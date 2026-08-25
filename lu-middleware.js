'use strict';

/**
 * LevelUp — API Protection Middleware (v2.25.0)
 *
 * PATCH 3: Rate limiting, burst protection, request validation.
 * PATCH 9: Security hardening — input sanitization, secret validation, SSRF global guard.
 *
 * Rate limiting is Redis-backed (not in-memory) so it works correctly
 * across multiple Railway replicas. In-memory limiters lose state on restart
 * and don't coordinate across instances — wrong for horizontal scaling.
 *
 * RATE LIMIT TIERS:
 *   /stream/*           50 req/15min per IP  (token-auth, low abuse risk)
 *   /internal/scanner   30 req/15min per IP  (external fetch, expensive)
 *   /internal/*         300 req/min per IP   (secret-protected, trust WP)
 *   /health             1000 req/min per IP  (public, used by load balancer)
 *   default             200 req/min per IP
 *
 * BODY SIZE LIMITS:
 *   Default: 256kb  — prevents JSON bomb attacks
 *   Scanner: 32kb   — URL is tiny; large bodies are attacks
 *   Stream:  64kb   — prompt + context, no need for more
 */

const crypto = require('crypto');

// ── Redis-backed rate limiter ─────────────────────────────────────────
// Uses a sliding window (token bucket approximation via INCRBY + EXPIRE).
// Two Redis commands per request = ~0.3ms overhead at negligible cost.
let _redisClient = null;

function setRateLimitRedis(client) {
    _redisClient = client;
}

/**
 * Check rate limit for a given key.
 * Returns { limited: bool, remaining: int, reset_ms: int }
 */
async function checkRateLimit(key, limit, windowMs) {
    if (!_redisClient) {
        // Redis not available — fail open (log and allow)
        console.warn('[middleware] Rate limit Redis not set — failing open for key:', key);
        return { limited: false, remaining: limit, reset_ms: windowMs };
    }

    const redisKey = `lu:rl:${key}`;
    const now      = Date.now();
    const windowS  = Math.ceil(windowMs / 1000);

    try {
        // Atomic increment + TTL set (MULTI/EXEC equivalent via pipeline)
        const pipeline = _redisClient.pipeline();
        pipeline.incr(redisKey);
        pipeline.pttl(redisKey);
        const [[, count], [, pttl]] = await pipeline.exec();

        // First request in window — set TTL
        if (count === 1 || pttl < 0) {
            await _redisClient.expire(redisKey, windowS);
        }

        const remaining = Math.max(0, limit - count);
        const reset_ms  = pttl > 0 ? pttl : windowMs;

        return { limited: count > limit, remaining, reset_ms };
    } catch (e) {
        // Redis error — fail open, don't break the request
        console.error('[middleware] Rate limit Redis error:', e.message);
        return { limited: false, remaining: limit, reset_ms: windowMs };
    }
}

/**
 * Build an Express rate-limit middleware.
 * @param {object} opts
 * @param {number} opts.limit     — max requests per window
 * @param {number} opts.windowMs  — window in milliseconds
 * @param {string} [opts.keyBy]   — 'ip' | 'secret' | function(req)
 * @param {string} [opts.label]   — label for logging
 */
function rateLimit({ limit, windowMs, keyBy = 'ip', label = 'default' }) {
    return async (req, res, next) => {
        let key;
        if (typeof keyBy === 'function') {
            key = keyBy(req);
        } else if (keyBy === 'ip') {
            key = `${label}:ip:${req.ip || req.connection.remoteAddress || 'unknown'}`;
        } else if (keyBy === 'secret') {
            // Key by secret hash — rate-limits WP instance, not individual users
            const secret = req.headers['x-levelup-secret'] || req.headers['x-lu-secret'] || '';
            key = `${label}:secret:${crypto.createHash('sha256').update(secret).digest('hex').slice(0, 16)}`;
        }

        const result = await checkRateLimit(key, limit, windowMs);

        res.setHeader('X-RateLimit-Limit',     String(limit));
        res.setHeader('X-RateLimit-Remaining', String(result.remaining));
        res.setHeader('X-RateLimit-Reset',     String(Date.now() + result.reset_ms));

        if (result.limited) {
            res.setHeader('Retry-After', String(Math.ceil(result.reset_ms / 1000)));
            console.warn(`[middleware] Rate limited: label=${label} key=${key}`);
            return res.status(429).json({
                error:      'rate_limited',
                message:    'Too many requests. Please slow down.',
                retry_after: Math.ceil(result.reset_ms / 1000),
            });
        }

        next();
    };
}

// ── Pre-built rate limiters ───────────────────────────────────────────

// Stream endpoints — 50 per 15 min per IP (token-authenticated)
const streamRateLimit = rateLimit({ limit: 50,  windowMs: 15 * 60_000, keyBy: 'ip', label: 'stream' });

// Scanner — 30 per 15 min per IP (external fetch, expensive)
const scannerRateLimit = rateLimit({ limit: 30, windowMs: 15 * 60_000, keyBy: 'ip', label: 'scanner' });

// Internal endpoints — 300 per min per WP secret (trust WP, not individual users)
const internalRateLimit = rateLimit({ limit: 300, windowMs: 60_000, keyBy: 'secret', label: 'internal' });

// AI generation — 50 per hour per IP (expensive GPU operations)
const aiGenRateLimit = rateLimit({ limit: 50, windowMs: 60 * 60_000, keyBy: 'ip', label: 'ai-gen' });

// ── Body size middleware ───────────────────────────────────────────────
// Prevents JSON bomb attacks (large payloads that exhaust memory).
const express = require('express');

const bodyLimitDefault = express.json({ limit: '256kb', strict: true });
const bodyLimitSmall   = express.json({ limit: '32kb',  strict: true });
const bodyLimitMedium  = express.json({ limit: '64kb',  strict: true });

// Error handler for body-parser limit exceeded
function bodyErrorHandler(err, req, res, next) {
    if (err.type === 'entity.too.large') {
        return res.status(413).json({ error: 'payload_too_large', message: 'Request body exceeds allowed size.' });
    }
    if (err.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'invalid_json', message: 'Request body is not valid JSON.' });
    }
    next(err);
}

// ── Request timeout middleware ─────────────────────────────────────────
// Enforces server-side timeout. Prevents slow clients from holding workers.
// v2.37.5 — TWO DEFECTS CORRECTED.
//
// 1. NO CANCELLATION. The previous implementation answered 503 and then called
//    next(); the handler kept running and the provider request was never
//    aborted. A /ai/run call could therefore burn a 90s DeepSeek generation AND
//    a 60s OpenAI fallback — 150s of billed work — after the caller had already
//    been told at 30s that the request failed. Every deadline now aborts an
//    AbortController that handlers pass to their provider calls.
//
// 2. UNTYPED ERROR. The old envelope was
//       503 {"error":"request_timeout", ...}
//    which a caller cannot distinguish from a provider timeout or an upstream
//    stall, so it could not decide whether a retry was sensible. It now emits
//    the standard typed shape from lu-runtime-errors.js with request id,
//    elapsed time, stage and an explicit retryable flag.
//
//    runtime_deadline is retryable:false ON PURPOSE. Re-issuing identical work
//    that has already exhausted its budget spends it twice for the same result;
//    the caller must reduce demand or use a longer lane instead.
const runtimeErrors = require('./lu-runtime-errors');

function requestTimeout(ms) {
    return (req, res, next) => {
        const startedAt = Date.now();

        // Handlers opt in by passing req.abortSignal to their provider client.
        // Creating it unconditionally keeps the contract uniform; a handler that
        // ignores it is no worse off than before this change.
        const controller = new AbortController();
        req.abortController = controller;
        req.abortSignal     = controller.signal;
        req.timeoutBudgetMs = ms;

        const timer = setTimeout(() => {
            const elapsed = Date.now() - startedAt;
            console.warn(
                `[middleware] runtime_deadline ${req.method} ${req.path} after ${elapsed}ms ` +
                `(budget ${ms}ms) — aborting provider work`
            );

            // Abort FIRST, answer second: stopping the spend is the part that
            // matters even if the client has already disconnected.
            try {
                // v2.37.7 — record WHY before aborting. Without this the router
                // sees an indistinguishable abort and has to guess; a deadline
                // breach would be mislabelled as a provider timeout and wrongly
                // become eligible for a fallback there is no time left to run.
                req.abortSignal.__luAbortReason = runtimeErrors.ABORT_REASONS.RUNTIME_DEADLINE;
                controller.abort();
            } catch (e) {
                console.warn('[middleware] abort failed:', e && e.message);
            }

            runtimeErrors.sendError(res, 'runtime_deadline', {
                request_id: req.id || req.requestId || null,
                elapsed_ms: elapsed,
                detail: { budget_ms: ms, path: req.path, lane: req.runtimeLane || null },
            });
        }, ms);

        const clear = () => clearTimeout(timer);
        res.on('finish', clear);
        res.on('close',  clear);

        next();
    };
}

// ── Workload lane classification (v2.37.5) ─────────────────────────────
//
// A single global deadline cannot serve both interactive chat and long-form
// synthesis. v2.37.2 already proved the per-route pattern by giving
// /internal/agent-search its own 75s lane; this generalises it WITHOUT putting
// every /ai/run request into a long lane indiscriminately.
//
// Classification is by DECLARED workload, never by guesswork:
//   - the route is a known synthesis or search route, or
//   - the caller declares workload:'synthesis' in the body, or
//   - the task name is in the registered synthesis set.
//
// Everything else keeps the 30s interactive budget, so chat latency is
// unchanged. See LANES for the budgets and DEPLOY-README for the rationale.
//
// ORDER MATTERS: this must run AFTER the body parser, because it reads
// req.body. index.js mounts it accordingly.
const LANES = {
    interactive: Number(process.env.RUNTIME_LANE_INTERACTIVE_MS || 30_000),
    // v2.37.8 — executive conversation. Chat used to run on the 30s interactive
    // lane, which is a utility-call budget, not a conversation budget. On a
    // context-rich workspace (Chef Red: 1,476 tasks) the provider could not
    // finish inside it, so 30.1% of turns in the F1 stress test returned an
    // error placeholder and p90 latency was 57s against a 30s deadline.
    //
    // 45s is deliberately ABOVE the p99 latency objective (40s) rather than at
    // it: the lane is the point at which we give up, not the target. Latency is
    // brought down by provider selection, not by widening the deadline — the
    // deadline only stops a healthy-but-slow turn being killed mid-flight.
    conversation: Number(process.env.RUNTIME_LANE_CONVERSATION_MS || 45_000),
    synthesis:   Number(process.env.RUNTIME_LANE_SYNTHESIS_MS   || 70_000),
    search:      Number(process.env.RUNTIME_LANE_SEARCH_MS      || 75_000),
};

// Long-running, low-frequency executive synthesis workloads.
const SYNTHESIS_TASKS = new Set([
    'sarah_daily_synthesis',
    'sarah_weekly_synthesis',
    'sarah_monthly_synthesis',
    'strategy_synthesis',
]);

const SYNTHESIS_ROUTES = new Set([
    '/internal/sarah/synthesize-daily',
    '/internal/sarah/synthesize-weekly',
    '/internal/sarah/synthesize-monthly',
]);

const SEARCH_ROUTES = new Set(['/internal/agent-search']);

// v2.37.8 — routes that carry a human waiting on a reply in a chat window.
const CONVERSATION_ROUTES = new Set(['/internal/assistant']);

function classifyLane(req) {
    if (SEARCH_ROUTES.has(req.path))       return 'search';
    if (CONVERSATION_ROUTES.has(req.path)) return 'conversation';
    if (SYNTHESIS_ROUTES.has(req.path))    return 'synthesis';

    const body = req.body || {};
    if (String(body.workload || '') === 'synthesis') return 'synthesis';

    // Laravel sends the workload name in context.task for /ai/run; the top-level
    // `task` field carries the prompt MODE ('seo_content_generation') and is far
    // too coarse to lane on by itself — laning on it would drag every article
    // generation into the long lane.
    const contextTask = body.context && body.context.task;
    if (contextTask && SYNTHESIS_TASKS.has(String(contextTask))) return 'synthesis';
    if (body.task && SYNTHESIS_TASKS.has(String(body.task)))     return 'synthesis';

    return 'interactive';
}

/** Express middleware applying the classified lane's deadline. */
function laneTimeout() {
    const built = {
        interactive:  requestTimeout(LANES.interactive),
        conversation: requestTimeout(LANES.conversation),
        synthesis:    requestTimeout(LANES.synthesis),
        search:       requestTimeout(LANES.search),
    };
    return (req, res, next) => {
        const lane = classifyLane(req);
        req.runtimeLane = lane;
        if (!res.headersSent) res.setHeader('X-Runtime-Lane', lane);
        return built[lane](req, res, next);
    };
}

// ── SSRF protection (global, not just scanner) ────────────────────────
// Applied to any endpoint that accepts a URL parameter.
function ssrfGuard(urlExtractor = (req) => req.body?.url) {
    return (req, res, next) => {
        const url = urlExtractor(req);
        if (!url) return next(); // No URL — not relevant

        const err = _checkSsrf(url);
        if (err) {
            return res.status(400).json({ error: 'ssrf_blocked', message: err });
        }
        next();
    };
}

function _checkSsrf(rawUrl) {
    let parsed;
    try { parsed = new URL(rawUrl); } catch { return 'Invalid URL format'; }
    const scheme = parsed.protocol;
    if (!['http:', 'https:'].includes(scheme)) return 'URL must use http or https';
    const host = parsed.hostname.toLowerCase();
    if (['localhost', '127.0.0.1', '::1', '0.0.0.0', '[::]'].includes(host)) {
        return 'Scanning internal addresses is not allowed';
    }
    if (/^10\./.test(host))                                return 'Private IP range not allowed (10.x)';
    if (/^192\.168\./.test(host))                          return 'Private IP range not allowed (192.168.x)';
    if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(host))       return 'Private IP range not allowed (172.16-31.x)';
    if (/^169\.254\./.test(host))                          return 'Link-local address not allowed';
    if (/^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./.test(host)) return 'CGNAT range not allowed';
    if (/^fd[0-9a-f]{2}:/i.test(host))                    return 'IPv6 ULA range not allowed';
    return null;
}

// ── Input sanitization helpers ────────────────────────────────────────
function sanitizeString(s, maxLen = 5000) {
    if (typeof s !== 'string') return '';
    return s.slice(0, maxLen).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

function sanitizeInt(n, fallback = 0) {
    const parsed = parseInt(n, 10);
    return isNaN(parsed) ? fallback : parsed;
}

// ── Security headers middleware ───────────────────────────────────────
// Applied globally. Runtime is an internal API — not a browser origin.
function securityHeaders(req, res, next) {
    res.setHeader('X-Content-Type-Options',  'nosniff');
    res.setHeader('X-Frame-Options',         'DENY');
    res.setHeader('X-XSS-Protection',        '0');         // modern browsers use CSP not this
    res.setHeader('Referrer-Policy',         'no-referrer');
    res.removeHeader('X-Powered-By');                      // don't expose Express version
    next();
}

// ── Request ID middleware ─────────────────────────────────────────────
// Adds X-Request-ID to every response for log correlation.
function requestId(req, res, next) {
    const id = req.headers['x-request-id'] || crypto.randomUUID();
    req.requestId = id;
    res.setHeader('X-Request-ID', id);
    next();
}

// ── Structured request logging ────────────────────────────────────────
// PATCH 8: emit structured log on every request for monitoring.
function requestLogger(req, res, next) {
    const t0 = Date.now();
    res.on('finish', () => {
        const ms = Date.now() - t0;
        const level = res.statusCode >= 500 ? 'ERROR'
            : res.statusCode >= 400 ? 'WARN'
            : 'INFO';
        // Structured log — parseable by Railway log drain / Datadog / Logtail
        console.log(JSON.stringify({
            ts:          new Date().toISOString(),
            level,
            type:        'http',
            method:      req.method,
            path:        req.path,
            status:      res.statusCode,
            duration_ms: ms,
            request_id:  req.requestId,
            ip:          req.ip,
        }));
    });
    next();
}

module.exports = {
    // Redis setup
    setRateLimitRedis,
    checkRateLimit,

    // Rate limiters
    rateLimit,
    streamRateLimit,
    scannerRateLimit,
    internalRateLimit,
    aiGenRateLimit,

    // Body parsers
    bodyLimitDefault,
    bodyLimitSmall,
    bodyLimitMedium,
    bodyErrorHandler,

    // Request handling
    requestTimeout,
    // v2.37.5 — workload lanes
    laneTimeout,
    classifyLane,
    LANES,
    SYNTHESIS_TASKS,
    SYNTHESIS_ROUTES,
    CONVERSATION_ROUTES,
    ssrfGuard,
    _checkSsrf,

    // Security
    securityHeaders,
    requestId,
    requestLogger,

    // Sanitization utilities
    sanitizeString,
    sanitizeInt,
};
