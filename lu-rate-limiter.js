'use strict';

/**
 * LevelUp — Rate Limiting Middleware (Patch 3)
 *
 * Redis sliding window rate limiter — no in-memory state, safe for
 * horizontal scaling (multiple runtime instances share Redis).
 *
 * Applied at three levels:
 *   1. Global per-IP       — 500 req/min (burst protection)
 *   2. Per-user global     — 200 req/min
 *   3. Per-endpoint        — fine-grained (AI endpoints stricter)
 *
 * Uses a single Redis INCR + EXPIRE pattern per window.
 * Key format: lu:rl:{scope}:{identifier}:{window_minute}
 *
 * LIMITS (tuned for 50k users at ~1 req/3s average):
 *   Global per-IP:        500/min    — block scraper floods
 *   Per-user global:      200/min    — 3.3 req/s sustained
 *   /stream/poll:         120/min    — 2/s polling (intentional high)
 *   /internal/scanner:    20/min     — scanner is expensive
 *   /internal/write/*:    30/min     — matches lu_rate_ai() in WP
 *   /internal/*:          60/min     — general internal route cap
 */

const { createAssistantRedisConnection } = require('./redis');

let _rlRedis = null;
function getRlRedis() {
  if (!_rlRedis) _rlRedis = createAssistantRedisConnection();
  return _rlRedis;
}

// ── Sliding window check ─────────────────────────────────────────────
async function checkLimit(key, limit, windowSecs) {
  const redis  = getRlRedis();
  const bucket = Math.floor(Date.now() / (windowSecs * 1000));
  const rkey   = `lu:rl:${key}:${bucket}`;
  const count  = await redis.incr(rkey);
  if (count === 1) await redis.expire(rkey, windowSecs + 5);   // TTL with buffer
  return { count, limit, exceeded: count > limit };
}

// ── Per-endpoint limit table ─────────────────────────────────────────
const ENDPOINT_LIMITS = [
  { match: /^\/stream\/poll/,             limit: 120, window: 60,  label: 'stream_poll' },
  { match: /^\/stream\/sse/,              limit: 30,  window: 60,  label: 'stream_sse' },
  { match: /^\/internal\/scanner/,        limit: 20,  window: 60,  label: 'scanner' },
  { match: /^\/internal\/write/,          limit: 30,  window: 60,  label: 'write_ai' },
  { match: /^\/internal\/creative/,       limit: 10,  window: 60,  label: 'creative_ai' },
  { match: /^\/internal\/task\/enqueue/,  limit: 30,  window: 60,  label: 'enqueue' },
  { match: /^\/internal\//,              limit: 60,  window: 60,  label: 'internal' },
];

// ── Rate limit response ───────────────────────────────────────────────
function rateLimitResponse(res, label, retryAfterSecs = 60) {
  res.set('Retry-After', String(retryAfterSecs));
  res.set('X-RateLimit-Limit', '—');
  return res.status(429).json({
    error:       'rate_limited',
    message:     `Too many requests (${label}). Retry after ${retryAfterSecs}s.`,
    retry_after: retryAfterSecs,
  });
}

// ── Middleware factory ───────────────────────────────────────────────
/**
 * Apply rate limiting to an Express app.
 * Usage: app.use(rateLimitMiddleware());
 */
function rateLimitMiddleware() {
  return async function luRateLimit(req, res, next) {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    // Extract user_id from bearer token header if present (for stream routes)
    // For internal routes, use the caller IP as identifier
    const userId = req.headers['x-lu-user-id'] || req.body?.user_id || ip;

    try {
      // ── Level 1: Global per-IP flood protection ──────────────────
      const ipCheck = await checkLimit(`ip:${ip}`, 500, 60);
      if (ipCheck.exceeded) {
        return rateLimitResponse(res, 'ip_global', 60);
      }

      // ── Level 2: Per-user global ─────────────────────────────────
      const userCheck = await checkLimit(`user:${userId}`, 200, 60);
      if (userCheck.exceeded) {
        return rateLimitResponse(res, 'user_global', 60);
      }

      // ── Level 3: Per-endpoint ────────────────────────────────────
      const path = req.path || '/';
      for (const rule of ENDPOINT_LIMITS) {
        if (rule.match.test(path)) {
          const epCheck = await checkLimit(`ep:${rule.label}:${userId}`, rule.limit, rule.window);
          if (epCheck.exceeded) {
            return rateLimitResponse(res, rule.label, rule.window);
          }
          break;   // Only apply first matching rule
        }
      }

      // Set informational headers
      res.set('X-RateLimit-Policy', 'sliding-window-60s');
      next();

    } catch (err) {
      // Redis failure → ALLOW through (fail-open: don't block users on Redis issues)
      console.error('[rate-limit] Redis error — failing open:', err.message);
      next();
    }
  };
}

// ── Burst detection (Patch 3: IP throttling) ────────────────────────
/**
 * Strict burst check — 50 requests in 5 seconds from same IP.
 * Applied only to write/creative AI endpoints.
 */
function burstMiddleware() {
  return async function luBurstCheck(req, res, next) {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    try {
      const check = await checkLimit(`burst:${ip}`, 50, 5);
      if (check.exceeded) {
        return rateLimitResponse(res, 'burst', 10);
      }
      next();
    } catch {
      next();   // fail-open
    }
  };
}

// ── Request body size guard ──────────────────────────────────────────
/**
 * Reject oversized request bodies before JSON parse.
 * Prevents memory exhaustion from malicious large payloads.
 */
function bodySizeGuard(maxKb = 512) {
  return function luBodySize(req, res, next) {
    const len = parseInt(req.headers['content-length'] || '0', 10);
    if (len > maxKb * 1024) {
      return res.status(413).json({
        error:   'payload_too_large',
        message: `Request body exceeds ${maxKb}KB limit.`,
        max_kb:  maxKb,
      });
    }
    next();
  };
}

// ── Input validation guard ────────────────────────────────────────────
/**
 * Reject requests with obviously malicious payloads before routing.
 * Not a replacement for per-handler validation — defense in depth.
 */
function inputValidationGuard() {
  const SUSPICIOUS = [
    /<script/i, /javascript:/i, /data:text\/html/i,
    /\.\.\//,                   // path traversal
    /\x00/,                     // null bytes
  ];
  return function luInputGuard(req, res, next) {
    const raw = JSON.stringify(req.body || '');
    for (const pattern of SUSPICIOUS) {
      if (pattern.test(raw)) {
        return res.status(400).json({ error: 'invalid_input', message: 'Malicious input detected.' });
      }
    }
    next();
  };
}

module.exports = {
  rateLimitMiddleware,
  burstMiddleware,
  bodySizeGuard,
  inputValidationGuard,
  checkLimit,
};
