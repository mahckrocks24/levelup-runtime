'use strict';

require('dotenv').config();

// 2026-06-29 v2.34.1 — WordPress is retired. The platform callback base is
// Laravel. Inherit WP_URL from LARAVEL_BASE_URL/LARAVEL_URL so every legacy
// WP_URL base-read + `if (!wp_url)` guard across the runtime resolves to
// Laravel instead of short-circuiting on a dead variable.
if (!process.env.WP_URL) process.env.WP_URL = process.env.LARAVEL_BASE_URL || process.env.LARAVEL_URL || '';

const express = require('express');
const dsModels = require('./deepseek-models'); // DeepSeek V4 registry (2026-07-26)
const { createRedisConnection }    = require('./redis');
const { assembleSystemPrompt, getToolDefinitionsForLLM } = require('./prompt-assembler');
const { runAgentLoop, callLLM }    = require('./llm');
const { getHistory, appendMessage, formatForLLM } = require('./conversation');
const { startMeeting, getMeeting, userMessage, directMessage, wrapUpMeeting, getPendingTasks, clearPendingTasks } = require('./meeting-room');
const taskMemory   = require('./task-memory');
const taskWorker   = require('./task-worker');
const registry     = require('./registry');
// Wave 82 — SEO intelligence routes (extract-anchor, score-ctr, etc.).
const seoIntelligence = require('./tool-seo-intelligence');
// Wave 88 — governance intelligence routes
const govIntelligence = require('./tool-governance-intelligence');
// Wave 89 — strategic intelligence routes
const strategicIntelligence = require('./tool-strategic-intelligence');
// Wave 90 — orchestrator intelligence routes
const orchestratorIntelligence = require('./tool-orchestrator-intelligence');
// Wave 91 — proactive intelligence routes
const proactiveIntelligence = require('./tool-proactive-intelligence');
const { v4: uuidv4 }               = require('uuid');
const crypto                         = require('crypto');  // stdlib — no install needed

// ── Hardening modules (v2.28.0) ───────────────────────────────────────
const {
    setRateLimitRedis,
    streamRateLimit, scannerRateLimit, internalRateLimit,
    bodyLimitDefault, bodyLimitSmall, bodyLimitMedium, bodyErrorHandler,
    requestTimeout, ssrfGuard,
    securityHeaders, requestId, requestLogger,
    // v2.37.5 — workload lanes
    laneTimeout, LANES,
} = require('./lu-middleware');
const runtimeErrors = require('./lu-runtime-errors');   // v2.37.5 typed errors
const router        = require('./lu-execution-router'); // v2.37.6 single routing engine

// v2.37.5 — single source of truth for the running version. Declared here, before
// the startup banner uses it, so the banner can never drift from package.json the
// way the hard-coded 'v2.28.0' and '/health: 2.37.3' strings did.
const RUNTIME_BUILD_VERSION = require('./package.json').version;
const { enqueue, getAllQueueCounts, closeAll: closeQueues } = require('./lu-queues');
const { startWorkers, getWorkerStats, getScaleRecommendation } = require('./lu-worker-manager');
const { inc, recordLatency, logger, buildMetricsSnapshot, startQueueMonitor } = require('./lu-metrics');
const governor = require('./lu-governor');

// App must be declared before any route registrations below
const app  = express();
app.set('trust proxy', 1);  // Resolve real client IP behind Railway LB

// ═══════════════════════════════════════════════════════════════════════════════
// STREAMING INFRASTRUCTURE — Redis-backed, HMAC-token-authenticated
// Architecture: WP→Runtime(init)→Redis   Browser→Runtime(poll|sse|cancel)
// No WordPress in the streaming hot path. Zero DB writes per chunk.
// ═══════════════════════════════════════════════════════════════════════════════

// Dedicated Redis connection for stream state — isolated from BullMQ worker pool
const streamRedis = createRedisConnection();
// Wire rate limiter to Redis (must be after Redis client creation)
setRateLimitRedis(streamRedis);

const STREAM_TTL      = 300; // seconds — 5 minutes auto-expiry per key
const ALLOWED_ORIGINS = [
    'https://staging1.shukranuae.com',
    'https://app.staging1.shukranuae.com',
    'https://app.levelupgrowth.ai',
];

// ── Patch 7: CORS — /stream/* only, locked to known origins ──────────────────
// Stream routes also get rate limiting (Redis-backed, 50 req/15min per IP)
// This is applied at the route level, not globally, so /internal/* isn't affected.

function streamCors(req, res, next) {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin',  origin);
        res.setHeader('Vary',                         'Origin');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
}

// ── Patch 1+2+5: HMAC stream tokens ──────────────────────────────────────────
// Token = base64url(JSON({jti,exp})) + "." + HMAC-SHA256-hex
// Signed with LU_SECRET. Browser receives token; never sees LU_SECRET or WP_SECRET.
// Patch 10: expired → 401. Invalid signature → 400.
function _streamSecret() {
    const s = process.env.LU_SECRET || process.env.WP_SECRET;
    if (!s) throw new Error('LU_SECRET not configured — stream tokens cannot be signed');
    return s;
}

function createStreamToken(jti) {
    const payload = Buffer.from(JSON.stringify({
        jti,
        exp: Date.now() + STREAM_TTL * 1000,
    })).toString('base64url');
    const sig = crypto.createHmac('sha256', _streamSecret()).update(payload).digest('hex');
    return `${payload}.${sig}`;
}

function verifyStreamToken(token) {
    const dot = (token || '').indexOf('.');
    if (dot < 0) throw new Error('malformed');
    const payload  = token.slice(0, dot);
    const sig      = token.slice(dot + 1);
    const expected = crypto.createHmac('sha256', _streamSecret()).update(payload).digest('hex');
    // Timing-safe comparison — prevent HMAC oracle attacks
    const sigBuf = Buffer.from(sig.padEnd(64, '0').slice(0, 64), 'hex');
    const expBuf = Buffer.from(expected.padEnd(64, '0').slice(0, 64), 'hex');
    if (!crypto.timingSafeEqual(sigBuf, expBuf)) throw new Error('expired'); // unified 401
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (Date.now() > data.exp) throw new Error('expired');
    return data.jti;
}

// ── Patch 6: Redis stream state helpers ──────────────────────────────────────
// Keys:
//   lu:stream:{jti}         → Hash  (status, complete, error, cancelled, created_at)
//   lu:stream:{jti}:chunks  → List  (RPUSH text, LRANGE offset -1 for poll)
// TTL: 300s on both keys, refreshed on every chunk write.
// Patch 12: RPUSH + LRANGE = O(1) write, O(k) read. No full-blob serialization per chunk.
const _sk  = jti => `lu:stream:${jti}`;
const _skc = jti => `lu:stream:${jti}:chunks`;

async function _streamInit(jti) {
    await streamRedis.hset(_sk(jti), {
        status:    'pending',
        complete:  '0',
        error:     '',
        cancelled: '0',
        created_at: String(Date.now()),
    });
    await streamRedis.expire(_sk(jti), STREAM_TTL);
}

async function _streamAppendChunk(jti, text) {
    await streamRedis.rpush(_skc(jti), text);
    await streamRedis.expire(_skc(jti), STREAM_TTL); // refresh TTL on activity
}

async function _streamSetStatus(jti, status, error = '') {
    await streamRedis.hset(_sk(jti), {
        status,
        complete: status === 'done' ? '1' : '0',
        error,
    });
    await streamRedis.expire(_sk(jti), STREAM_TTL);
}

async function _streamGetState(jti, offset) {
    const [meta, chunks, total] = await Promise.all([
        streamRedis.hgetall(_sk(jti)),
        streamRedis.lrange(_skc(jti), offset, -1),
        streamRedis.llen(_skc(jti)),
    ]);
    if (!meta || !meta.status) return null;
    return {
        status:    meta.status,
        complete:  meta.complete  === '1',
        error:     meta.error     || null,
        cancelled: meta.cancelled === '1',
        chunks,
        offset:    offset + chunks.length,
        total,
    };
}

async function _streamCancel(jti) {
    await streamRedis.hset(_sk(jti), { status: 'cancelled', cancelled: '1' });
}

async function _streamIsCancelled(jti) {
    return (await streamRedis.hget(_sk(jti), 'cancelled')) === '1';
}

// ── Patch 4+11: Stream execution engine ──────────────────────────────────────
// Runs entirely async after stream-init returns. No HTTP response held open.
// Writes chunks directly to Redis — no WP callback, no per-chunk HTTP.
// Patch 12: Non-blocking. Uses async generator pattern via fetch ReadableStream.
async function _runWriteStream(jti, params) {
    const { title, brief, keywords, tone, length, content_type, intent, seo_brief } = params;
    console.log(`[STREAM START] jti=${jti} type=${content_type || 'blog_article'}`);
    try {
        await _streamSetStatus(jti, 'streaming');

        const apiKey = process.env.DEEPSEEK_API_KEY;
        if (!apiKey) throw new Error('DEEPSEEK_API_KEY not set');

        const prompts         = buildWritePrompt({ content_type, title, brief, tone, length, intent, seo_brief });
        const systemPrompt    = prompts.system;
        const userPrompt      = prompts.user;
        const resolvedTokens  = prompts.max_tokens;

        const dsResponse = await fetch('https://api.deepseek.com/v1/chat/completions', {
            method:  'POST',
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model:       dsModels.DEFAULT_MODEL,
                messages:    [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
                max_tokens:  dsModels.withReasoningHeadroom(resolvedTokens),
                temperature: 0.72,
                stream:      true,
            }),
            signal: AbortSignal.timeout(120000),
        });

        if (!dsResponse.ok) {
            const errText = await dsResponse.text();
            throw new Error(`DeepSeek ${dsResponse.status}: ${errText.slice(0, 200)}`);
        }

        const reader  = dsResponse.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let wordBuffer = '', lineBuffer = '', chunkCount = 0;

        const flushWords = async () => {
            if (!wordBuffer.trim()) { wordBuffer = ''; return; }
            await _streamAppendChunk(jti, wordBuffer);
            chunkCount++;
            wordBuffer = '';
        };

        while (true) {
            // Patch 5: Cancellation check — abort loop cleanly without Redis leak
            if (await _streamIsCancelled(jti)) {
                console.log(`[STREAM CANCEL] jti=${jti} at chunk ${chunkCount} — cleanup`);
                await streamRedis.del(_sk(jti), _skc(jti));
                return;
            }

            const { done, value } = await reader.read();
            if (done) break;

            lineBuffer += decoder.decode(value, { stream: true });
            const lines = lineBuffer.split('\n');
            lineBuffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data:')) continue;
                const jsonStr = trimmed.slice(5).trim();
                if (jsonStr === '[DONE]') continue;
                try {
                    const parsed = JSON.parse(jsonStr);
                    const token  = parsed.choices?.[0]?.delta?.content || '';
                    if (!token) continue;
                    wordBuffer += token;
                    const wc = wordBuffer.split(/\s+/).filter(w => w.length > 0).length;
                    if (wc >= 6 || /[.!?\n]{1,2}\s*$/.test(wordBuffer)) await flushWords();
                } catch (e) { /* skip malformed SSE line */ }
            }
        }

        if (wordBuffer.trim()) await flushWords();
        await _streamSetStatus(jti, 'done');
        console.log(`[STREAM DONE] jti=${jti} chunks=${chunkCount}`);

    } catch (err) {
        console.error(`[STREAM ERROR] jti=${jti}:`, err.message);
        await _streamSetStatus(jti, 'error', err.message || 'stream_failed');
    }
}

// ── Patch 1: Stream init — WP→Runtime (secret protected) ─────────────────────
// WordPress calls this after the user triggers generation.
// Returns stream_token + jti. WP proxies both to browser.
// Kicks off async generation immediately — browser can begin polling.
app.post('/internal/write/stream-init', requireSecret, async (req, res) => {
    const { title, brief, keywords, tone, length, content_type, intent, seo_brief, user_id } = req.body || {};
    if (!title && !brief) {
        return res.status(400).json({ success: false, error: 'title or brief required' });
    }

    let jti, token;
    try {
        jti   = uuidv4();
        token = createStreamToken(jti);
    } catch (e) {
        console.error('[STREAM INIT] Token creation failed:', e.message);
        return res.status(500).json({ success: false, error: 'Stream secret not configured' });
    }

    await _streamInit(jti);
    console.log(`[STREAM INIT] jti=${jti} user_id=${user_id || 'unknown'}`);

    // Respond immediately — browser starts polling before generation begins
    res.json({ success: true, stream_token: token, jti });

    // Patch 12: setImmediate — non-blocking fire-and-forget
    setImmediate(() => _runWriteStream(jti, { title, brief, keywords, tone, length, content_type, intent, seo_brief }));
});

// ── Patch 2: Stream poll — Browser→Runtime (token auth, no secret) ────────────
// Browser polls this directly. No WordPress in the hot path.
// Returns only NEW chunks from offset. Adaptive: browser slows down when idle.
// Patch 10: 401 = expired token. 404 = stream not found (GC'd or bad jti).
app.get('/stream/poll/:token', streamCors, streamRateLimit, async (req, res) => {
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    let jti;
    try {
        jti = verifyStreamToken(req.params.token);
    } catch (e) {
        const code = (e.message === 'expired') ? 401 : 400;
        return res.status(code).json({ error: e.message });
    }

    try {
        const state = await _streamGetState(jti, offset);
        if (!state) return res.status(404).json({ error: 'stream_not_found' });
        res.setHeader('Cache-Control', 'no-store');
        res.json({
            chunks:   state.chunks,
            offset:   state.offset,
            complete: state.complete,
            error:    state.error  || null,
            status:   state.status,
        });
    } catch (e) {
        console.error('[STREAM POLL] Redis error:', e.message);
        res.status(500).json({ error: 'internal_error' });
    }
});

// ── Patch 3: SSE stream — Browser→Runtime ────────────────────────────────────
// Optional SSE transport — SPA can use this instead of polling.
// Pushes chunk events at 250ms interval. Sends done/error event on completion.
// Patch 12: interval-based, non-blocking. Cleaned up on client disconnect.
app.get('/stream/sse/:token', streamCors, async (req, res) => {
    let jti;
    try {
        jti = verifyStreamToken(req.params.token);
    } catch (e) {
        return res.status(e.message === 'expired' ? 401 : 400).json({ error: e.message });
    }

    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Nginx: disable buffering
    res.flushHeaders();

    let offset = 0;
    const tick = setInterval(async () => {
        try {
            const state = await _streamGetState(jti, offset);
            if (!state) {
                res.write('event: error\ndata: {"error":"stream_not_found"}\n\n');
                clearInterval(tick); res.end(); return;
            }
            for (const chunk of state.chunks) {
                res.write(`event: chunk\ndata: ${JSON.stringify({ text: chunk })}\n\n`);
            }
            offset = state.offset;
            if (state.complete) {
                res.write('event: done\ndata: {"complete":true}\n\n');
                clearInterval(tick); res.end();
            } else if (state.error) {
                res.write(`event: error\ndata: ${JSON.stringify({ error: state.error })}\n\n`);
                clearInterval(tick); res.end();
            }
        } catch (e) {
            res.write(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`);
            clearInterval(tick); res.end();
        }
    }, 250);

    req.on('close', () => { clearInterval(tick); });
});

// ── Patch 5: Stream cancel — Browser→Runtime (token auth) ─────────────────────
// Marks Redis state as cancelled. _runWriteStream loop detects this and
// exits + deletes both Redis keys. Safe to call multiple times.
app.post('/stream/cancel/:token', streamCors, async (req, res) => {
    let jti;
    try {
        jti = verifyStreamToken(req.params.token);
    } catch (e) {
        return res.status(e.message === 'expired' ? 401 : 400).json({ error: e.message });
    }
    await _streamCancel(jti);
    console.log(`[STREAM CANCEL] jti=${jti} — marked cancelled`);
    res.json({ success: true, jti });
});


const { registerBuilderRoutes }    = require('./builder-ai');
const synthesisRoutes              = require('./lu-synthesis-routes');
// 2026-05-24 — Sarah synthesis (intelligence layer in runtime, not Laravel).
const sarahSynthesisRoutes         = require('./lu-sarah-synthesis-routes');
// 2026-06-12 — GSC intelligence (Phase 3): all Search Console scoring/ranking
// lives in the runtime (hands-vs-brain). POST /internal/seo/gsc-intelligence.
const gscIntelligence              = require('./lu-gsc-intelligence');
// 2026-05-24 — Agent search (DuckDuckGo HTML by default).
const agentSearchRoutes            = require('./lu-agent-search');

// ── Phase 1A: Lu-module imports ────────────────────────────────────────────
const taskQueueRoutes    = require('./lu-task-queue-routes');
const intelligenceRoutes = require('./lu-intelligence-routes');
const { handlePlan }     = require('./lu-intelligence-routes');
const activityRoutes     = require('./lu-activity-routes');

// ── Phase 7: Global crash guard — runtime must never exit on uncaught errors ──
process.on('uncaughtException', (err) => {
    console.error('[CRASH GUARD] Uncaught exception (runtime continues):', err.message);
    console.error(err.stack?.split('\n').slice(0, 4).join('\n') || '');
});
process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.error('[CRASH GUARD] Unhandled rejection (runtime continues):', msg);
});

const PORT = process.env.PORT || 3000;
// ── Hardening middleware (v2.28.0) ───────────────────────────────────
app.use(requestId);
app.use(securityHeaders);
app.use(requestLogger);
// v2.37.2 (2026-07-18) — per-route timeout budget.
//
// The flat 30s global cap silently broke /internal/agent-search. DataForSEO
// live SERP latency measured 5.7-25.9s (highly variable, their side), so a
// single attempt could consume the entire 30s budget — which meant v2.37.1's
// retry logic never got to run AND the route returned the middleware's
// `request_timeout` instead of a real error. Measured result: v2.37.1 scored
// 2/5, WORSE than v2.37.0's 3/5. The retry was correct; the budget was not.
//
// agent-search gets 75s so its retry chain fits (20s x 3 attempts + backoff
// = ~62s worst case). Laravel's caller budget is RUNTIME_TIMEOUT=120, so 75s
// is comfortably inside it. Everything else keeps the 30s global.
// v2.37.5 (2026-08-05) — WORKLOAD LANES, and a deliberate ORDER CHANGE.
//
// The body parser now runs BEFORE the timeout middleware. It has to: the lane
// is chosen from the DECLARED workload (body.workload / body.context.task), and
// that cannot be read before the body is parsed. Parsing is bounded at 256kb and
// costs microseconds, so nothing meaningful is spent before the deadline arms.
//
// Lanes (see lu-middleware.LANES):
//   interactive 30s — unchanged, so chat latency does not regress
//   synthesis   70s — Sarah daily/weekly/monthly executive synthesis
//   search      75s — /internal/agent-search, unchanged from v2.37.2
//
// WHY SYNTHESIS NEEDS ITS OWN LANE
// Sarah's daily synthesis was killed at the 30s global deadline on every
// workspace from 2026-07-27, returning an untyped 503 that Laravel recorded as
// text_len=0. Measured: the same prompt completes in 28.4s at a reduced budget
// and is still generating at 30s at the production budget. 70s gives real
// headroom without becoming an unbounded lane.
app.use(bodyLimitDefault);             // 256kb body limit globally
app.use(bodyErrorHandler);             // Handle body-too-large + parse errors
app.use(laneTimeout());                // Lane-aware deadline + AbortController

console.log(`[STARTUP] LevelUp Runtime v${RUNTIME_BUILD_VERSION} — ExecutionRouter + conversation lane`);
console.log('[STARTUP] REDIS_URL          :', process.env.REDIS_URL          ? 'SET ✓' : 'NOT SET ✗');
console.log('[STARTUP] WP_SECRET          :', process.env.WP_SECRET          ? 'SET ✓' : 'NOT SET ✗');
console.log('[STARTUP] LU_SECRET          :', process.env.LU_SECRET          ? 'SET ✓' : 'NOT SET ✗');
console.log('[STARTUP] DEEPSEEK_KEY       :', process.env.DEEPSEEK_API_KEY   ? 'SET ✓' : 'NOT SET ✗');
console.log('[STARTUP] Laravel base (WP_URL):', process.env.WP_URL ? 'SET ✓' : 'NOT SET ✗ — set LARAVEL_URL on Railway');
console.log('[STARTUP] SYNTHESIS_ENDPOINT :', process.env.SYNTHESIS_ENDPOINT ? 'SET ✓' : 'NOT SET ✗ — tasks will deliver raw tool output');
console.log('[STARTUP] LLM_PROVIDER       :', process.env.LLM_PROVIDER || 'deepseek (default)');
console.log('[STARTUP] Tools (unified)    :', registry.list().length, 'tools loaded from canonical registry');

// ── Phase 9: Critical config validation — warn loudly on missing vars ────────
const CRITICAL_VARS = {
    WP_URL:             'Workspace context fetch — agents operate without business profile',
    SYNTHESIS_ENDPOINT: 'LLM synthesis — task outputs will be raw JSON instead of agent prose',
    WP_SECRET:          'Runtime authentication — all WP callbacks will fail',
    DEEPSEEK_API_KEY:   'LLM provider — no AI calls possible',
    REDIS_URL:          'Memory + queue — platform will not function',
};
const MISSING_CRITICAL = Object.entries(CRITICAL_VARS)
    .filter(([k]) => !process.env[k])
    .map(([k, desc]) => `  ✗ ${k}: ${desc}`);

if (MISSING_CRITICAL.length) {
    console.error('\n[STARTUP] ⚠️  CRITICAL CONFIGURATION MISSING:');
    MISSING_CRITICAL.forEach(m => console.error('[STARTUP]' + m));
    console.error('[STARTUP] Platform may not function correctly until these are set.\n');
}
if (process.env.LLM_PROVIDER && !['deepseek','openai'].includes(process.env.LLM_PROVIDER.toLowerCase())) {
    console.error(`[STARTUP] ✗ LLM_PROVIDER="${process.env.LLM_PROVIDER}" is not a recognised provider. Use: deepseek or openai`);
}

// ── Auth ───────────────────────────────────────────────────────────────────
function requireSecret(req, res, next) {
    const secret = process.env.WP_SECRET;
    if (!secret) return res.status(500).json({ error: 'WP_SECRET not set.' });
    if (req.headers['x-levelup-secret'] !== secret) return res.status(401).json({ error: 'Unauthorized.' });
    next();
}

// ── Queue (legacy Sprint A enqueue — kept for backward compat) ────────────
let taskQueue = null;
function getQueue() {
    if (taskQueue) return taskQueue;
    const { Queue } = require('bullmq');
    taskQueue = new Queue('levelup-tasks', { connection: createRedisConnection() });
    return taskQueue;
}

// ── Health ─────────────────────────────────────────────────────────────────
// v2.37.5 — VERSION ACCURACY.
//
// /health reported '2.37.3' while the deployed build was the v2.37.4 DeepSeek-V4
// code. The version was hard-coded here AND package.json was never bumped, so
// the only way to identify the running build was to fingerprint its behaviour.
// Version now derives from package.json (single source of truth) and the build
// identity is explicit.
const RUNTIME_BUILD = {
    version:          RUNTIME_BUILD_VERSION,
    build_id:         process.env.RAILWAY_GIT_COMMIT_SHA || process.env.RUNTIME_BUILD_ID || 'v2.37.9-provider-transport',
    built_at:         process.env.RUNTIME_BUILT_AT || '2026-08-08',
    contract_version: runtimeErrors.CONTRACT_VERSION,
    // v2.37.7 — an explicit, non-overridable release tag. In production
    // build_id is the Railway git SHA, so it cannot answer "which release is
    // live?". Verifying the v2.37.6 deploy required inferring that from
    // behaviour; this makes it directly checkable.
    release:          'v2.37.10-social-dec0028',
    abort_provenance: true,
};

app.get('/health', (req, res) => res.json({
    status:'ok', version: RUNTIME_BUILD.version, phase:'2',
    build_id:         RUNTIME_BUILD.build_id,
    built_at:         RUNTIME_BUILD.built_at,
    release:          RUNTIME_BUILD.release,
    abort_provenance: RUNTIME_BUILD.abort_provenance,
    contract_version: RUNTIME_BUILD.contract_version,
    // Declared so callers can verify lane behaviour without probing for it.
    lanes: LANES,
    // v2.37.9 — live admission-control state. Certification Pass A could only
    // infer saturation from the outside, by correlating edge 502s with task
    // bursts. Exposing it means the next investigation reads a number instead
    // of reconstructing one.
    concurrency: require('./lu-provider-transport').snapshot(),
    model_capabilities: {
        default_model:      dsModels.DEFAULT_MODEL,
        pro_model:          dsModels.PRO_MODEL,
        supported_models:   [...dsModels.SUPPORTED_MODELS],
        retired_models:     [...dsModels.RETIRED_MODELS],
        max_tokens_cap:     dsModels.MAX_TOKENS_CAP,
        reasoning_headroom: dsModels.REASONING_HEADROOM,
        output_contract:    ['v1_max_tokens', 'v2_explicit'],
    },
    max_prompt_chars: Number(process.env.RUNTIME_MAX_PROMPT_CHARS || 64000),
    error_codes: Object.keys(runtimeErrors.ERRORS),
    agents:Object.keys(require('./agents').AGENTS),
    tools: registry.list().map(t=>t.name),
    // Phase 0.17 — explicit list so callers can verify chat_json is live
    // before switching their fold-pattern refactors over to it.
    //
    // LAUNCH SCOPE (v2.37.3): email_generation, social_post,
    // email_template_generate_v2, email_block_rewrite, email_subject_suggest
    // and email_spam_critique REMOVED. /health is the capability advertisement
    // callers integrate against — leaving them listed would have told every
    // caller the runtime still generates email-marketing and social copy.
    ai_run_tasks: [
        'seo_content_generation','image_generation','builder_generate',
        'competitor_analysis',
        'write_article','improve_draft','serp_analysis','competitor_keywords',
        'chat_json',
        // v2.37.10 (DEC-0028): social copy generation is back in scope.
        'social_post','social_hashtag_pack',
        // Sarah × Studio Phase 1
        'studio_design','studio_template_pick','studio_copy_variants',
    ],
    // Phase 2A.-1 — image gen via DALL-E 3 lives at POST /internal/image/generate
    // (not /ai/run). Listed here so callers can detect availability.
    internal_routes: [
        '/internal/health',
        '/internal/image/generate',
        '/internal/vision/analyze',
        '/internal/sarah/synthesize-daily',
        '/internal/sarah/synthesize-weekly',
        '/internal/sarah/synthesize-monthly',
        '/internal/agent-search',
        '/internal/scanner',
    ],
    config:{
        redis:     !!process.env.REDIS_URL,
        llm:       !!process.env.DEEPSEEK_API_KEY,
        wp_secret: !!process.env.WP_SECRET,
        lu_secret: !!process.env.LU_SECRET,
    },
    modules:{
        task_queue:   true,
        intelligence: true,
        activity:     true,
        bootstrap:    true,
    },
}));

// ── POST /ai/run — Unified AI dispatcher ─────────────────────────────────────
// V4 (2026-07-26): model now resolved via ./deepseek-models (default
// deepseek-v4-flash); was hardwired to the retired deepseek-chat.
// Direct axios call — still bypasses the callLLM() wrapper.
// to avoid provider-switching and ensure identical payload to working Assistant.
// Protected by requireSecret.
app.post('/ai/run', requireSecret, async (req, res) => {
    const axios = require('axios');

    // Phase 0.17 (chat_json): also accept an optional `system` override.
    // When present, it takes precedence over the SYSTEM_PROMPTS[task] lookup
    // and lets Laravel callers pass arbitrary system prompts without folding
    // them into the user prompt.
    const { task, prompt: rawPrompt, context = {}, max_tokens, system: systemOverride } = req.body || {};

    if (!task)     return res.status(400).json({ success: false, error: 'task required' });
    if (!rawPrompt) return res.status(400).json({ success: false, error: 'prompt required' });

    // ── LAUNCH SCOPE GATE (v2.37.3) ──
    // Refuse generation modes for capability the product no longer ships.
    // Without this, deleting the prompt entries alone would let the request
    // fall through to the generic assistant prompt and still return the copy.
    const OUT_OF_SCOPE_TASKS = new Set([
        // email marketing
        'email_generation', 'email_template_generate_v2', 'email_copy',
        'email_subject', 'email_subject_suggest', 'email_block_rewrite',
        'email_spam_check', 'email_spam_critique', 'email_ai_generate',
        'newsletter', 'newsletter_generation', 'campaign_copy', 'ai_campaign_copy',
        // social: RE-INCLUDED per DEC-0028 (2026-08-25) — social automation is in launch (v2.37.10).
    ]);
    // Belt-and-braces: catch future/renamed modes by shape as well as by name,
    // so adding a new `email_*` or `social_*` generation task cannot silently
    // reopen the surface. `chat_json` and studio tasks are unaffected.
    const taskName = String(task);
    const shapeMatch = /^(email|newsletter|campaign)[_-]/i.test(taskName); // v2.37.10: social un-gated (DEC-0028)
    if (OUT_OF_SCOPE_TASKS.has(taskName) || shapeMatch) {
        return res.status(400).json({
            success: false,
            error: 'out_of_launch_scope',
            message: `Task '${task}' is not available: email marketing is not part of this product.`,
        });
    }

    // ── Task 4: Prompt size guard ─────────────────────────────────────────────
    // v2.37.5 — SILENT TRUNCATION REMOVED.
    //
    // v2.37.4 sliced any prompt over 8000 chars and logged a single console
    // line. Sarah's daily synthesis prompt is 16,251 bytes, so HALF of it was
    // discarded before generation and neither Laravel nor the customer could
    // know. The runtime now accepts the full documented maximum and REJECTS
    // anything larger with a typed input_too_large, rather than quietly
    // answering a different question than the one it was asked.
    //
    // The ceiling sits inside the 256kb body limit with generous margin.
    const MAX_PROMPT_CHARS = Number(process.env.RUNTIME_MAX_PROMPT_CHARS || 64000);
    const receivedChars = rawPrompt ? rawPrompt.length : 0;

    if (receivedChars > MAX_PROMPT_CHARS) {
        return runtimeErrors.sendError(res, 'input_too_large', {
            request_id: req.requestId || req.id || null,
            elapsed_ms: 0,
            message: `Prompt is ${receivedChars} characters; the documented maximum is ${MAX_PROMPT_CHARS}. ` +
                     `Reduce the prompt or split the workload — the runtime will not truncate it for you.`,
            detail: {
                received_chars: receivedChars,
                max_chars:      MAX_PROMPT_CHARS,
                accepted_chars: 0,
                transformed:    false,
            },
        });
    }

    const prompt = rawPrompt;
    const acceptedChars = receivedChars;

    // ── Task 2: Force working model ───────────────────────────────────────────
    // V4 migration 2026-07-26: deepseek-chat retired 2026-07-24 (HTTP 400).
    // Restoration default is flash. A caller may request a tier via req.body
    // .tier ('flash'|'pro'); an unsupported/retired name is rejected outright.
    let model;
    try {
        model = req.body && req.body.tier
            ? dsModels.resolveModel(req.body.tier)
            : dsModels.resolveRequestedModel(req.body && req.body.model);
    } catch (modelErr) {
        return res.status(400).json({ success: false, error: modelErr.message, code: modelErr.code });
    }

    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return res.status(500).json({ success: false, error: 'DEEPSEEK_API_KEY not set' });

    // ── System prompt map ─────────────────────────────────────────────────────
    const SYSTEM_PROMPTS = {
        seo_content_generation: 'You are an SEO content specialist. Generate high-quality, search-optimised content. Return structured output with title, meta_description, and body sections.',
        image_generation:       'You are a creative director. Convert the user brief into a detailed image generation prompt. Return only the prompt string.',
        builder_generate:       'You are the LevelUp Builder AI. Generate a structured page section as JSON with type, content (object), styles (object), and tokens (object). No raw HTML.',
        competitor_analysis:    'You are a marketing strategist. Analyse the competitor and return structured insights: strengths, weaknesses, opportunities, and counter-strategies.',
        // v2.37.10 (DEC-0028): social copy generation restored. Mirrors Laravel SocialService::SOCIAL_SYSTEM_PROMPT.
        social_post:            'You are a senior social media copywriter. Write ONE on-brand post for the given platform. Ground every choice in the supplied brand context (brand_name, brand_voice, colours, industry, audience) and any learned_patterns. Honour platform norms: instagram 138-150 characters sweet spot, facebook 40-80 characters organic, linkedin 1300-3000 characters professional, twitter/x 280 characters hard limit, tiktok 100-300 characters. Never mention LevelUp, AI, or that this was generated. Return ONLY JSON: {"content": "...", "hashtags": ["#tag", ...], "best_time": "e.g. Tue 6pm"}.',
        social_hashtag_pack:    'You are a social media strategist. Return ONLY a JSON object {"hashtags": ["#tag", ...]} — a mix of popular, medium and niche tags relevant to the brief. No prose.',
        // LAUNCH SCOPE (v2.37.3): email_generation, social_post, social_post_v2,
        // social_hashtag_pack, social_platform_adapt and email_template_generate_v2
        // were REMOVED. They are LLM generation modes for email-marketing copy and
        // social captions/hashtags — capability the product no longer ships. Any
        // request for them is now refused by the guard below rather than silently
        // falling through to the generic assistant prompt (which would still have
        // produced the copy).
        write_article:          'You are a content writer. Write a well-structured SEO-friendly article. Return title, sections (heading + content array), and meta_description.',
        improve_draft:          "You are an editor. Improve the draft while preserving the author's voice. Return the improved version with a brief explanation of changes.",
        serp_analysis:          'You are an SEO analyst. Analyse the SERP landscape and return intent_type, top_themes, content_gaps, and recommended_angle.',
        competitor_keywords:    'You are an SEO strategist. Identify keyword opportunities. Return keyword clusters with difficulty and opportunity scores.',
        studio_design:          'You are a senior brand designer. Given format, intent, brand kit (palette/fonts), industry, optional headline seed, and a template pool — pick the best template_slug and return JSON: {template_slug, copy:{headline,sub,cta}, palette:{primary,bg,text,accent}, font_pair:{display,body}, rationale}. Ground EVERY choice in the supplied brand kit. Never invent colors. Never auto-publish.',
        studio_template_pick:   'You are a template selector. Rank the supplied template_pool by fit for the brief. Return JSON: {ranked:[{template_slug, score (0-1), why}]} sorted by score descending. Top 5 only.',
        studio_copy_variants:   'You are a brand copywriter. Given context + brand voice, return 3 distinct headline+sub+cta variants for A/B testing. Return JSON: {variants:[{headline,sub,cta,angle}]}. Use brand voice consistently across all variants.',
        // LAUNCH SCOPE (v2.37.3): email_block_rewrite, email_subject_suggest and
        // email_spam_critique removed alongside email_generation /
        // email_template_generate_v2 / social_post* — all email-marketing and
        // social-copy generation modes. Refused by the guard in /ai/run.
        // Phase 0.17 — generic JSON-mode escape hatch.
        // Callers MUST pass a custom `system` override in the request body (the
        // engine-specific framing they want). DeepSeek is invoked in JSON mode
        // and the runtime parses the output automatically. Used by Sarah brain,
        // BlueprintService, ScenePlannerService, BuilderService wizard, etc. —
        // anywhere a Laravel call site needs to send an arbitrary system prompt
        // and get parsed JSON back without the fold-into-user-prompt workaround.
        chat_json:              'You are a helpful AI assistant. Always respond with valid JSON only — no prose, no markdown fences, no commentary.',
    };

    // chat_json prefers the caller-supplied system override; falls back to the
    // generic JSON-mode default above if none was provided. All other tasks
    // honor the override only when explicitly passed (backwards compatible).
    const systemContent = systemOverride
        || SYSTEM_PROMPTS[task]
        || ('You are a helpful AI assistant for the LevelUp Growth Platform. Complete the task: ' + task);

    // Build context block
    const contextLines = Object.entries(context)
        .filter(([, v]) => v !== null && v !== undefined && v !== '')
        .map(([k, v]) => k + ': ' + v);
    const systemPrompt = contextLines.length
        ? systemContent + '\n\nContext:\n' + contextLines.join('\n')
        : systemContent;

    // ── Task 3: Normalized payload — identical structure to working Assistant ─
    const payload = {
        model:       model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: prompt },
        ],
        temperature: 0.7,
        // v2.37.5 — budgets resolved through the EXPLICIT contract so the
        // effective value can be reported back to the caller (see budget below).
        max_tokens:  0, // set immediately after budget resolution
    };

    // v2.37.5 — explicit, visible output contract. Legacy callers sending only
    // max_tokens behave exactly as in v2.37.4; the difference is that the
    // response now states what the runtime actually used.
    let budget;
    try {
        budget = dsModels.resolveTokenBudget(
            {
                max_tokens,
                output_budget:    req.body && req.body.output_budget,
                reasoning_budget: req.body && req.body.reasoning_budget,
            },
            1200
        );
    } catch (budgetErr) {
        return runtimeErrors.sendError(res, 'output_contract_violation', {
            request_id: req.requestId || req.id || null,
            elapsed_ms: 0,
            message: budgetErr.message,
            detail: budgetErr.meta || null,
        });
    }
    payload.max_tokens = budget.effective_max_tokens;

    // Phase 0.17 — chat_json forces DeepSeek's JSON mode so the model is
    // constrained to emit a single valid JSON object. The runtime then parses
    // it server-side and includes the parsed value in the response, eliminating
    // the per-caller json_decode + manual error handling pattern that the fold
    // workaround forced on every refactored Laravel site.
    if (task === 'chat_json') {
        payload.response_format = { type: 'json_object' };
        // ── Guard (2026-07-08): DeepSeek's json_object mode HARD-REQUIRES the
        // literal word "json" somewhere in the prompt, else it returns HTTP 400
        // ("Prompt must contain the word 'json'"). The default chat_json system
        // prompt contains it, but a caller-supplied `system` override may not —
        // and neither may the user prompt. Append a minimal instruction so the
        // contract holds for EVERY caller without changing their semantics.
        const hasJsonWord = /\bjson\b/i.test(payload.messages[0].content) || /\bjson\b/i.test(prompt || '');
        if (!hasJsonWord) {
            payload.messages[0].content += '\n\nRespond with valid JSON only.';
            console.log('[ai/run] chat_json: injected "json" keyword to satisfy DeepSeek json_object contract');
        }
    }

    // ── Task 5: Debug log ─────────────────────────────────────────────────────
    console.log('AI_RUN_DEBUG', {
        model,
        task,
        prompt_length: prompt ? prompt.length : 0,
    });

    const t0 = Date.now();

    // ── Task 6: Call DeepSeek with 1 retry on 429 ─────────────────────────────
    // v2.37.5 — TIMEOUT HIERARCHY, corrected.
    //
    // v2.37.4 had it inverted: the provider timeout (90s) was THREE TIMES the
    // route deadline (30s), so the deadline always fired first, the caller got
    // an untyped 503, and the provider kept generating — billed, unread.
    //
    // The rule is now: provider timeout < route deadline < Laravel client.
    // The gap between provider and route is the runtime's own working budget —
    // enough time to abort, classify, serialise and log rather than being cut
    // off mid-answer by its own middleware.
    //
    //   lane          provider   route    headroom
    //   interactive     25s       30s        5s
    //   synthesis       55s       70s       15s
    //   search          —         75s        —      (own retry chain, untouched)
    // ── v2.37.6 — PROVIDER EXECUTION DELEGATED ─────────────────────────────
    //
    // Everything that used to live here — DeepSeek invocation, the 429 retry,
    // the OpenAI fallback, provider attribution, budget resolution — MOVED to
    // lu-execution-router.js. It was not copied: this endpoint no longer knows
    // that providers exist in the plural.
    //
    // The router is now the only component in the runtime that selects a
    // provider, sequences a fallback or applies a retry policy, so a change to
    // routing policy takes effect on every endpoint at once.
    const laneBudgetMs    = req.timeoutBudgetMs || LANES.interactive;
    const providerTimeout = Math.max(5_000, laneBudgetMs - (req.runtimeLane === 'synthesis' ? 15_000 : 5_000));

    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: prompt },
    ];

    // chat_json forces JSON mode; DeepSeek requires the literal word "json".
    let responseFormat = null;
    if (task === 'chat_json') {
        responseFormat = { type: 'json_object' };
        const hasJsonWord = /\bjson\b/i.test(systemPrompt) || /\bjson\b/i.test(prompt || '');
        if (!hasJsonWord) {
            messages[0].content += '\n\nRespond with valid JSON only.';
            console.log('[ai/run] chat_json: injected "json" keyword to satisfy DeepSeek json_object contract');
        }
    }

    // t0 is already declared above, at the start of the provider phase.
    const result = await router.execute({
        messages,
        capability:          task === 'chat_json' ? 'structured_extraction' : 'long_synthesis',
        max_tokens,
        output_budget:       req.body && req.body.output_budget,
        reasoning_budget:    req.body && req.body.reasoning_budget,
        temperature:         0.7,
        response_format:     responseFormat,
        signal:              req.abortSignal,
        request_id:          req.requestId || req.id || null,
        deadline_ms:         laneBudgetMs,
        provider_timeout_ms: providerTimeout,
        // v2.37.9 — admission control needs the workload class. req.runtimeLane
        // is set by laneTimeout() before this handler runs, so background
        // article generation can never occupy the conversation reserve.
        lane:                req.runtimeLane || 'interactive',
    });

    const meta = router.metadata(result);

    if (!result.ok) {
        return runtimeErrors.sendError(res, result.error_code, {
            request_id: result.request_id,
            elapsed_ms: result.elapsed_ms,
            provider:   result.provider,
            message:    result.error_message,
            stage:      result.stage,   // v2.37.7 — canonical stage, matches meta
            detail: {
                task,
                runtime_lane: req.runtimeLane || 'interactive',
                lane_budget_ms: laneBudgetMs,
                provider_timeout_ms: providerTimeout,
                ...meta,
            },
        });
    }

    const output      = result.content || '';
    const duration_ms = Date.now() - t0;
    console.log(`[ai/run] done | task=${task} | ${duration_ms}ms | provider=${result.actual_provider} | model=${result.actual_model}`);

    const responseBody = {
        success:      true,
        task,
        output,
        duration_ms,
        model:        result.actual_model,
        usage:        result.usage || null,
        request_id:       result.request_id,
        runtime_lane:     req.runtimeLane || 'interactive',
        contract_version: runtimeErrors.CONTRACT_VERSION,
        budget: {
            output_budget:        result.budget.output_budget,
            reasoning_budget:     result.budget.reasoning_budget,
            effective_max_tokens: result.budget.effective_max_tokens,
            transformed:          result.budget.transformed,
            contract_form:        result.budget.contract_form,
        },
        input: {
            received_chars: receivedChars,
            accepted_chars: acceptedChars,
            max_chars:      MAX_PROMPT_CHARS,
            transformed:    receivedChars !== acceptedChars,
        },
        ...meta,
    };

    if (task === 'chat_json') {
        try {
            responseBody.parsed = dsModels.parseStructuredOutput(output, {
                meta: { finish_reason: result.finish_reason, model: result.actual_model },
            });
        } catch (structErr) {
            console.error('[ai/run] chat_json invalid structured output |', structErr.code);
            return runtimeErrors.sendError(res, 'malformed_provider_response', {
                request_id: result.request_id,
                elapsed_ms: duration_ms,
                provider:   result.actual_provider,
                message:    structErr.message,
                detail:     { task, code: structErr.code, meta: structErr.meta || null, ...meta },
            });
        }
    }

    return res.json(responseBody);
});

app.get('/internal/health', requireSecret, async (req, res) => {
    try {
        const counts = await getQueue().getJobCounts();
        res.json({ status:'ok', redis:'connected', queue:counts });
    } catch(e) { res.status(500).json({ status:'error', message:e.message }); }
});

// ── Phase 2A.-1: Image generation (DALL-E 3) ─────────────────────────────
//
// POST /internal/image/generate
//
// gpt-image-1 (migrated 2026-05-13 — dall-e-3 + dall-e-2 lost access on
// this OpenAI account). Runtime owns the OpenAI key; Laravel persists the
// asset. Per CREATIVE888 LAW: quality is HARDCODED 'low' for every
// auto-generation regardless of what callers pass.
//
// Request body:
//   - prompt (required, string) — what to generate
//   - style  (optional, string) — folded into the prompt as "Style: ..."
//   - size   (optional, string) — gpt-image-1 supports:
//                                   '1024x1024' (square, default)
//                                   '1024x1536' (portrait)
//                                   '1536x1024' (landscape)
//                                   'auto'
//
// Response (success):
//   { success: true, b64_json, revised_prompt: null, size, quality: 'low',
//     model: 'gpt-image-1', provider: 'openai', duration_ms }
//
// gpt-image-1 only returns base64. Laravel side (RuntimeClient::imageGenerate)
// is responsible for decoding + uploading to public storage + returning a URL
// to downstream consumers (CreativeConnector / CreativeService / call sites).
//
// `quality` from req.body is intentionally IGNORED — auto-gen is always low.
app.post('/internal/image/generate', requireSecret, async (req, res) => {
    const axios = require('axios');

    const { prompt: rawPrompt, style, size: requestedSize } = req.body || {};

    if (!rawPrompt || typeof rawPrompt !== 'string') {
        return res.status(400).json({ success: false, error: 'prompt required' });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        return res.status(500).json({ success: false, error: 'OPENAI_API_KEY not set on runtime' });
    }

    // gpt-image-1 supports exactly these sizes
    const validSizes = ['1024x1024', '1024x1536', '1536x1024', 'auto'];
    // Back-compat: map old dall-e-3 sizes to gpt-image-1 equivalents
    const sizeAlias = { '1792x1024': '1536x1024', '1024x1792': '1024x1536' };
    const aliased = sizeAlias[requestedSize] || requestedSize;
    const size = validSizes.includes(aliased) ? aliased : '1024x1024';

    // CREATIVE888 LAW: quality always 'low' for auto-generation
    const quality = 'low';

    // Fold style into the prompt if supplied
    const fullPrompt = style ? `${rawPrompt}\n\nStyle: ${style}` : rawPrompt;

    // gpt-image-1 has a 32000-char prompt cap (vs dall-e-3's 4000); we keep
    // the conservative 4000 cap to bound payload size + token cost.
    const safePrompt = fullPrompt.length > 4000 ? fullPrompt.slice(0, 4000) : fullPrompt;

    const t0 = Date.now();

    // gpt-image-1 request body:
    //   - no `response_format` (always returns b64_json)
    //   - no `n > 1` support varies; keep n=1
    const reqBody = {
        model:   'gpt-image-1',
        prompt:  safePrompt,
        n:       1,
        size,
        quality,
    };

    try {
        const response = await axios.post(
            'https://api.openai.com/v1/images/generations',
            reqBody,
            {
                timeout: 120000, // gpt-image-1 can be slower than dall-e; allow 2min
                headers: {
                    'Content-Type':  'application/json',
                    'Authorization': 'Bearer ' + apiKey,
                },
            }
        );

        const imageData   = (response.data && response.data.data && response.data.data[0]) || {};
        const b64Json     = imageData.b64_json;
        const duration_ms = Date.now() - t0;

        if (!b64Json) {
            console.error('[image/generate] gpt-image-1 returned no b64_json');
            return res.status(502).json({
                success: false,
                error:   'gpt-image-1 returned no b64_json',
                duration_ms,
            });
        }

        console.log(`[image/generate] done | size=${size} | quality=${quality} | bytes=${b64Json.length} | ${duration_ms}ms`);

        return res.json({
            success:        true,
            b64_json:       b64Json,
            revised_prompt: null,   // gpt-image-1 does not return a revised prompt
            size,
            quality,
            model:          'gpt-image-1',
            provider:       'openai',
            duration_ms,
        });

    } catch (err) {
        const duration_ms = Date.now() - t0;
        const errMsg = err.response
            ? ('OpenAI ' + err.response.status + ': ' + JSON.stringify(err.response.data))
            : err.message;
        console.error('[image/generate] failed |', errMsg);
        return res.status(500).json({
            success:     false,
            error:       errMsg,
            duration_ms,
        });
    }
});

// ── Bella Session 1: Vision analysis (GPT-4o) ────────────────────────────
//
// POST /internal/vision/analyze
//
// Accepts a base64 image + text prompt and sends both to GPT-4o's vision
// capability. Used by Bella's admin panel for screenshot analysis, design
// review, and visual QA — any workflow where the admin pastes an image and
// asks "what's wrong with this?" or "describe what you see."
//
// Request body:
//   - prompt    (required, string)          — what to analyze
//   - image     (required, string)          — base64-encoded image data (no data:... prefix needed,
//                                             but if present it's stripped automatically)
//   - image_url (optional, string)          — URL to an image (used instead of base64 if provided)
//
// Response (success):
//   { success: true, analysis, tokens_used, model: 'gpt-4o', duration_ms }
//
// Response (failure): HTTP 4xx/5xx with { success: false, error, duration_ms }
app.post('/internal/vision/analyze', requireSecret, async (req, res) => {
    const axios = require('axios');

    const { prompt: rawPrompt, image, image_url } = req.body || {};

    if (!rawPrompt || typeof rawPrompt !== 'string') {
        return res.status(400).json({ success: false, error: 'prompt required' });
    }
    if (!image && !image_url) {
        return res.status(400).json({ success: false, error: 'image (base64) or image_url required' });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        return res.status(500).json({ success: false, error: 'OPENAI_API_KEY not set on runtime' });
    }

    // Cap prompt length
    const prompt = rawPrompt.length > 4000 ? rawPrompt.slice(0, 4000) : rawPrompt;

    // Build the image content part — either base64 or URL
    let imageContent;
    if (image_url) {
        imageContent = { type: 'image_url', image_url: { url: image_url } };
    } else {
        // Strip data:image/...;base64, prefix if present
        const base64Clean = image.replace(/^data:image\/[a-z]+;base64,/i, '');
        imageContent = {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,' + base64Clean },
        };
    }

    const t0 = Date.now();

    try {
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: 'gpt-4o',
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: prompt },
                            imageContent,
                        ],
                    },
                ],
                max_tokens: 2000,
                temperature: 0.3,
            },
            {
                timeout: 120000,
                headers: {
                    'Content-Type':  'application/json',
                    'Authorization': 'Bearer ' + apiKey,
                },
                // base64 images can be large — increase max body size
                maxContentLength: 20 * 1024 * 1024,
                maxBodyLength:    20 * 1024 * 1024,
            }
        );

        const choice     = response.data.choices && response.data.choices[0];
        const analysis   = choice ? (choice.message.content || '') : '';
        const usage      = response.data.usage || {};
        const duration_ms = Date.now() - t0;

        console.log(`[vision/analyze] done | tokens=${usage.total_tokens || '?'} | ${duration_ms}ms`);

        return res.json({
            success:     true,
            analysis,
            tokens_used: usage.total_tokens || 0,
            model:       'gpt-4o',
            duration_ms,
        });

    } catch (err) {
        const duration_ms = Date.now() - t0;
        const errMsg = err.response
            ? ('OpenAI ' + err.response.status + ': ' + JSON.stringify(err.response.data))
            : err.message;
        console.error('[vision/analyze] failed |', errMsg);
        return res.status(500).json({
            success:     false,
            error:       errMsg,
            duration_ms,
        });
    }
});

// ── Sprint A: Enqueue (legacy) ────────────────────────────────────────────
app.post('/internal/enqueue', requireSecret, async (req, res) => {
    const b = req.body;
    for (const f of ['task_id','tool_name','workspace_id','agent_id','callback_url']) {
        if (!b[f]) return res.status(400).json({ error:`Missing: ${f}` });
    }
    try {
        const job = await getQueue().add('execute-tool',
            { ...b, payload:b.payload||{}, governance_tier:b.governance_tier??0, enqueued_at:new Date().toISOString() },
            { priority:b.priority||5, attempts:3, backoff:{type:'exponential',delay:2000}, removeOnComplete:{count:100}, removeOnFail:{count:50} });
        res.json({ accepted:true, task_id:b.task_id, job_id:job.id });
    } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Sprint B: Chat ─────────────────────────────────────────────────────────
app.post('/internal/chat', requireSecret, async (req, res) => {
    const { conversation_id, workspace_id=1, agent_id='dmm', message, workspace_context={} } = req.body;
    if (!message?.trim()) return res.status(400).json({ error:'message required.' });
    if (!conversation_id)  return res.status(400).json({ error:'conversation_id required.' });
    try {
        const history    = await getHistory(workspace_id, conversation_id);
        const llmHistory = formatForLLM(history, 20);
        await appendMessage(workspace_id, conversation_id, 'user', message);
        const systemPrompt = assembleSystemPrompt(agent_id, workspace_context,
            { availableTools: registry.list().map(t=>t.name) });
        const messages = [{ role:'system', content:systemPrompt }, ...llmHistory, { role:'user', content:message }];
        const toolDefs = getToolDefinitionsForLLM(registry.list().map(t=>({ name:t.name, description:t.description, parameters:registry.get(t.name)?.parameters })));
        const result   = await runAgentLoop({ messages, toolDefs, toolRegistry:registry, context:{ task_id:`chat_${conversation_id}_${Date.now()}`, agent_id, workspace_id }, maxRounds:3 }); // Part 6: capped at 3 rounds (was 5)
        await appendMessage(workspace_id, conversation_id, 'assistant', result.content);
        res.json({ response:result.content, agent_id, agent_name:agent_id==='dmm'?'Sarah':'Aria', tools_used:result.tools_used, rounds:result.rounds, conversation_id });
    } catch(e) {
        res.status(500).json({ error:e.message, response:"I'm having a technical issue. Please try again." });
    }
});

// ── Sprint C: Meeting Room ─────────────────────────────────────────────────

app.post('/internal/meeting/start', requireSecret, async (req, res) => {
    const b = req.body;
    if (!b.topic) return res.status(400).json({ error:'topic required.' });
    // ── LB-12 fix 2026-04-25 — thread workspace_id into meeting context ──
    // Prevents cross-workspace memory contamination at the 5 getMemory() sites
    // in meeting-room.js. Laravel caller MUST send workspace_id in body.
    if (!b.workspace_id) {
        console.warn('[MEETING][LB-12] workspace_id missing from /internal/meeting/start request body. Fallback to workspace 1 will fire. Check Laravel caller.');
    }
    const meetingId = 'mtg_' + uuidv4().replace(/-/g,'').substring(0,16);
    try {
        await startMeeting(meetingId, {
            workspace_id: b.workspace_id || null,
            type:         b.type        || 'brainstorm',
            topic:        b.topic,
            businessName: b.businessName || '',
            website:      b.website      || '',
            goals:        b.goals        || '',
            industry:     b.industry     || '',
        });
        res.json({ meeting_id:meetingId, status:'starting', topic:b.topic });
    } catch(e) { res.status(500).json({ error:e.message }); }
});

app.get('/internal/meeting/:id/status', requireSecret, async (req, res) => {
    try {
        const m = await getMeeting(req.params.id);
        if (!m) return res.status(404).json({ error:'Meeting not found.' });
        res.json({
            meeting_id:      m.id,
            status:          m.status,
            current_speaker: m.current_speaker || null,
            topic:           m.topic,
            type:            m.type,
            phase:           m.phase || 'opening',
            messages:        m.messages || [],
            message_count:   (m.messages||[]).length,
            spokenAgents:    m.spokenAgents || [],
            files:           m.files || [],
            completed_at:    m.completed_at || null,
            error:           m.error || null,
        });
    } catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/internal/meeting/:id/message', requireSecret, async (req, res) => {
    const content = req.body.content?.trim();
    if (!content) return res.status(400).json({ error:'content required.' });
    try {
        const result = await userMessage(req.params.id, content);
        if (result.error) return res.status(400).json(result);
        res.json(result);
    } catch(e) { res.status(500).json({ error:e.message }); }
});

// PHASE 1A FIX: Single DM route — duplicate removed
app.post('/internal/meeting/:id/dm', requireSecret, async (req, res) => {
    try {
        const { agentId, content } = req.body;
        const r = await directMessage(req.params.id, agentId, content);
        res.json(r);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/internal/meeting/:id/upload', requireSecret, (req, res) => {
    const multer  = (() => { try { return require('multer'); } catch(e) { return null; } })();
    if (!multer) return res.status(501).json({ error: 'multer not installed. Run: npm install multer' });
    const fs   = require('fs');
    const path = require('path');
    const uploadDir = path.join(__dirname, 'uploads', 'meeting-files');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    const upload = multer({ dest: uploadDir, limits: { fileSize: 20 * 1024 * 1024 } });
    upload.single('file')(req, res, async (err) => {
        if (err) return res.status(400).json({ error: err.message });
        if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
        const ext  = path.extname(req.file.originalname).toLowerCase();
        const safe = req.file.filename + ext;
        const dest = path.join(uploadDir, safe);
        fs.renameSync(req.file.path, dest);
        const fileInfo = { name:req.file.originalname, type:req.file.mimetype, size:req.file.size, url:`/uploads/meeting-files/${safe}`, path:dest };
        try {
            const { addFileToMeeting } = require('./meeting-room');
            await addFileToMeeting(req.params.id, fileInfo);
            res.json({ ok: true, file: fileInfo });
        } catch(e) { res.status(500).json({ error: e.message }); }
    });
});

app.use('/uploads', require('express').static(require('path').join(__dirname, 'uploads')));

app.post('/internal/meeting/:id/state-file', requireSecret, async (req,res) => {
    try {
        const { addFileToMeeting } = require('./meeting-room');
        await addFileToMeeting(req.params.id, req.body.file||{});
        res.json({ok:true});
    } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/internal/meeting/:id/pending-tasks', requireSecret, async (req,res) => {
    try { const d=await getPendingTasks(req.params.id); res.json(d||{tasks:[]}); }
    catch(e){ res.status(500).json({error:e.message}); }
});

app.delete('/internal/meeting/:id/pending-tasks', requireSecret, async (req,res) => {
    try { await clearPendingTasks(req.params.id); res.json({ok:true}); }
    catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/internal/meeting/:id/wrap', requireSecret, async (req, res) => {
    try {
        const result = await wrapUpMeeting(req.params.id);
        if (result.error) return res.status(400).json(result);
        res.json(result);
    } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Sprint D: Task Memory & Projects ──────────────────────────────────────

app.post('/internal/tasks/import', requireSecret, async (req, res) => {
    try {
        const { wsId = 1, task } = req.body;
        if (!task?.id) return res.status(400).json({ error: 'task.id required.' });
        const imported = await taskMemory.importApprovedTask(wsId, task);
        res.json({ ok: true, task: imported });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/internal/tasks', requireSecret, async (req, res) => {
    try {
        const wsId  = parseInt(req.query.wsId || 1);
        const tasks = await taskMemory.getAllTasks(wsId);
        res.json({ tasks });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/internal/tasks/:id', requireSecret, async (req, res) => {
    try {
        const wsId = parseInt(req.query.wsId || 1);
        const task = await taskMemory.getTask(wsId, req.params.id);
        if (!task) return res.status(404).json({ error: 'Task not found.' });
        res.json(task);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/internal/tasks/:id/status', requireSecret, async (req, res) => {
    try {
        const { wsId = 1, status, note, by = 'user' } = req.body;
        if (!status) return res.status(400).json({ error: 'status required.' });
        const result = await taskMemory.updateStatus(wsId, req.params.id, status, { note, by });
        if (!result) return res.status(404).json({ error: 'Task not found.' });
        if (status === taskMemory.STATUS.IN_PROGRESS) {
            taskWorker.triggerTaskDelivery(wsId, req.params.id)
                .catch(err => console.error(`[TASK] Delivery error:`, err.message));
        }
        res.json({ ok: true, task: result.task, oldStatus: result.oldStatus });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/internal/tasks/:id/note', requireSecret, async (req, res) => {
    try {
        const { wsId = 1, author, author_name, content, type = 'user' } = req.body;
        const task = await taskMemory.addNote(wsId, req.params.id, { author, author_name, content, type });
        if (!task) return res.status(404).json({ error: 'Task not found.' });
        res.json({ ok: true, task });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/internal/workspace-memory', requireSecret, async (req, res) => {
    try {
        const wsId   = parseInt(req.query.wsId || 1);
        const memory = await require('./workspace-memory').getMemory(wsId);
        res.json(memory);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/internal/workspace-memory', requireSecret, async (req, res) => {
    try {
        const { wsId = 1, field, value } = req.body;
        const wsMem  = require('./workspace-memory');
        const memory = await wsMem.getMemory(wsId);
        if (field && value !== undefined) {
            memory[field] = value;
            await wsMem.saveMemory(wsId, memory);
        }
        res.json({ ok: true, memory });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Global AI Assistant (Phase 3 — Intelligence Upgrade) ─────────────────────
// Upgrades: persistent conversation history, workspace memory, tool execution,
//           1200 token budget, no 100-word restriction, unified tool access.
app.post('/internal/assistant', requireSecret, async (req, res) => {
    const { message, context={}, conversation_id='default', agent_id='dmm' } = req.body;
    if (!message?.trim()) return res.status(400).json({ error:'message required' });

    const { routeIntent, formatToolSuggestions } = require('./assistant-tool-router');
    const { buildAssistantPrompt, buildAgentConsultPrompt, AGENTS, TOKENS } = require('./agents');

    // ── v2.37.8 — CONVERSATION LANE ────────────────────────────────────────
    // Every LLM call made while a human waits in a chat window is a
    // conversation call. Binding the capability here covers all six call sites
    // in this handler (direct reply, strategic synthesis, specialist consults)
    // without touching each one, so no site can be missed or drift later.
    //
    // The deadline is also threaded through, so the router knows how much of
    // the lane is left and can hold back FALLBACK_RESERVE_MS for a fallback
    // attempt instead of letting the primary consume everything.
    const { callLLM: _rawCallLLM } = require('./llm');
    const _laneBudget = req.timeoutBudgetMs || null;
    const callLLM = (opts) => _rawCallLLM(Object.assign({
        capability: 'conversation',
        deadline_ms: _laneBudget,
        signal: req.abortSignal || null,
        // v2.37.9 — this is the route with a person waiting on a reply, so it
        // is the route the reserved concurrency exists for. Injected in the
        // same wrapper as the capability so no individual call site has to
        // remember it.
        lane: req.runtimeLane || 'conversation',
    }, opts));
    const { getHistory, appendMessage } = require('./conversation');
    const { longTermReadAll } = require('./lu-memory');
    const { getWorkspaceContext } = require('./lu-context');

    try {
        // ── Phase 0: Hard 8s timeout across ALL pre-work (history + context + memory) ──
        // Redis hang is the primary cause of blank responses. If ANY pre-work exceeds 8s,
        // we skip it and go straight to the LLM with whatever context we have.
        const PREWORK_TIMEOUT = 8000;
        const wp_url    = process.env.WP_URL || '';
        const wp_secret = process.env.WP_SECRET || '';

        const preworkTimeout = new Promise(resolve =>
            setTimeout(() => {
                console.warn('[ASSISTANT] Pre-work timeout — proceeding with base context only');
                resolve({ timedOut: true });
            }, PREWORK_TIMEOUT)
        );

        const preworkPromise = Promise.allSettled([
            getHistory(1, conversation_id),
            getWorkspaceContext(wp_url, wp_secret),
            longTermReadAll(),
        ]);

        const preworkResult = await Promise.race([preworkPromise, preworkTimeout]);

        let llm_history  = [];
        let workspaceCtx = { ...context };
        let memoryCtx    = {};

        if (!preworkResult.timedOut) {
            const [histResult, wsResult, memResult] = preworkResult;
            const conv_history = histResult.status === 'fulfilled' ? histResult.value : [];
            llm_history  = conv_history.slice(-14).map(m => ({ role: m.role, content: m.content }));
            workspaceCtx = { ...context, ...(wsResult.status === 'fulfilled' ? wsResult.value : {}) };
            memoryCtx    = memResult.status === 'fulfilled' ? memResult.value : {};
        }

        // ── PATCH (Option A, 2026-05-09) — honor Laravel-provided context ──
        // The merge above lets wsResult overwrite request context. After
        // clearing the Shukran ghost from Redis (lu:mem:ws:* DEL'd) AND
        // unsetting WP_URL on Railway, wsResult has empty identity fields.
        // Without this override, the assistant says "you haven't told me
        // about your business yet" even when Laravel passes business_name
        // in the request body. This block ensures Laravel's context fills
        // the gaps when the runtime's own memory layer has nothing.
        const reqCtx = req.body.context || {};
        if (reqCtx.business_name) {
            workspaceCtx.business_name = workspaceCtx.business_name || reqCtx.business_name;
            workspaceCtx.businessName  = workspaceCtx.businessName  || reqCtx.business_name;
            workspaceCtx.industry      = workspaceCtx.industry      || reqCtx.industry || '';
            workspaceCtx.location      = workspaceCtx.location      || reqCtx.location || '';
            workspaceCtx.website       = workspaceCtx.website       || reqCtx.website  || '';
        }

        // ── Phase 2: Pre-reasoning tool suggestion ─────────────────────────
        const suggestions    = routeIntent(message, agent_id);
        const toolSuggestion = formatToolSuggestions(suggestions);

        // ── Part 4.5: Append newly discovered tools (guarded — non-blocking) ──
        let discoveredBlock = '';
        try {
            const { formatDiscoveredToolsBlock } = require('./tool-discovery');
            discoveredBlock = formatDiscoveredToolsBlock(agent_id);
        } catch (_) { /* tool-discovery unavailable — continue without it */ }

        // ── Phase 7: Strategic mode — complex multi-domain queries trigger agent consultation ──
        const STRATEGIC_PATTERNS = [
            /how (can|do|should) (i|we).{10,}(seo|content|campaign|crm|leads|social|ads|funnel)/i,
            /improve (our|my).{5,}(seo|marketing|content|strategy|funnel|ads)/i,
            /full.{0,10}(strategy|plan|roadmap|audit)/i,
            /what.{0,15}(should we|should i|recommend).{5,}(marketing|seo|content|campaign)/i,
            /help.{0,10}(grow|scale|increase|improve).{5,}(traffic|leads|sales|revenue|rankings)/i,
        ];
        const isStrategic = STRATEGIC_PATTERNS.some(p => p.test(message));

        if (isStrategic) {
            console.log('[ASSISTANT] Strategic mode triggered — consulting specialists');
            const { buildAgentConsultPrompt: bac } = require('./agents');
            const { getAgentsSync } = require('./agents');
            const agentMap = getAgentsSync();

            // Determine which specialists to consult based on detected intent
            const consultAgents = suggestions.tools.reduce((acc, tool) => {
                // LAUNCH SCOPE: create_post → marcus and create_campaign → dmm
                // removed; both tools are out of scope and marcus is not on the
                // team. improve_draft/insert_link added so the retained surface
                // still routes to a specialist.
                const domainAgents = {
                    serp_analysis: 'james', deep_audit: 'james', write_article: 'priya',
                    improve_draft: 'priya', create_lead: 'elena',
                    create_post: 'marcus', schedule_post: 'marcus', // v2.37.10 (DEC-0028)
                    get_site_pages: 'alex', scan_site_url: 'alex', insert_link: 'alex',
                    generate_page_layout: 'dmm',
                };
                const ag = domainAgents[tool];
                if (ag && !acc.includes(ag)) acc.push(ag);
                return acc;
            }, []);
            const consultList = consultAgents.length ? consultAgents.slice(0, 3) : ['james', 'priya', 'elena'];

            // Parallel specialist consultations (30s each, non-blocking failures)
            const specialistResponses = await Promise.allSettled(
                consultList.map(async agId => {
                    const persona  = bac(agId, message, workspaceCtx);
                    const r = await callLLM({
                        messages: [{ role:'system', content: persona }, { role:'user', content: message }],
                        max_tokens: 400, temperature: 0.65,
                    });
                    const ag = agentMap[agId] || { name: agId };
                    return { agentId: agId, name: ag.name, response: r.content?.trim() || '' };
                })
            );

            const contributions = specialistResponses
                .filter(r => r.status === 'fulfilled' && r.value.response)
                .map(r => `[${r.value.name}]: ${r.value.response}`);

            if (contributions.length) {
                // Synthesise into a unified strategic response
                const synthPrompt = bac('dmm', message, workspaceCtx);
                const synthMessages = [
                    { role:'system', content: synthPrompt },
                    { role:'user', content: `The team has weighed in on: "${message}"

Team inputs:
${contributions.join('\n\n')}

Synthesise into one clear strategic recommendation with specific action steps.` },
                ];
                const synthR = await Promise.race([
                    callLLM({ messages: synthMessages, max_tokens: 800, temperature: 0.5 }),
                    new Promise((_,rej) => setTimeout(() => rej(new Error('synthesis_timeout')), 25000)),
                ]).catch(() => ({ content: contributions.join('\n\n') }));
                const reply  = synthR.content?.trim() || contributions.join('\n\n');
                await appendMessage(1, conversation_id, 'user', message).catch(() => {});
                await appendMessage(1, conversation_id, 'assistant', reply).catch(() => {});
                return res.json({
                    response:        reply,
                    strategic_mode:  true,
                    agents_consulted: consultList,
                });
            }
        }

        // ── Build upgraded prompt ───────────────────────────────────────────
        const fullSuggestion = [toolSuggestion, discoveredBlock].filter(Boolean).join('\n\n');
        const systemPrompt = buildAssistantPrompt(message, workspaceCtx, memoryCtx, fullSuggestion);

        const messages = [
            { role:'system', content: systemPrompt },
            ...llm_history,
            { role:'user', content: message },
        ];

        const r = await Promise.race([
            callLLM({ messages, max_tokens: 1200, temperature: 0.55 }),
            new Promise((_,rej) => setTimeout(()=>rej(new Error('timeout')), 35000)),
        ]);
        // ── Part 9: Blank-response failsafe — LLM returned empty content ────
        let raw = (r.content||'').trim();
        if (!raw) {
            console.warn('[ASSISTANT] LLM returned empty content — applying failsafe reply');
            raw = 'I processed your request but the response was empty. Please rephrase or try again.';
        }

        // ── Save to conversation history ─────────────────────────────────────
        await appendMessage(1, conversation_id, 'user', message).catch(() => {});
        await appendMessage(1, conversation_id, 'assistant', raw).catch(() => {});

        // ── Part 6: Tool call loop guard — max 3 tool calls per assistant turn ─
        // (single-turn tool calls — no multi-round agentic loop in assistant)
        let toolCallCount = 0;
        const MAX_TOOL_CALLS_PER_TURN = 3;

        // ── Tool call intercept ───────────────────────────────────────────────
        const toolMatch = raw.match(/<assistant_tool>\s*([\s\S]*?)\s*<\/assistant_tool>/i);
        if (toolMatch) {
            try {
                const toolCall = JSON.parse(toolMatch[1].trim());

                // ask_agent — delegate to specialist
                if (toolCall.tool === 'ask_agent' && toolCall.params?.agent) {
                    const agentId  = toolCall.params.agent;
                    const question = toolCall.params.question || message;
                    const persona  = buildAgentConsultPrompt(agentId, question, workspaceCtx);
                    const agentR   = await Promise.race([
                        callLLM({ messages:[{role:'system',content:persona},{role:'user',content:'Answer now.'}], max_tokens: TOKENS.specialist, temperature:0.65 }),
                        new Promise((_,rej)=>setTimeout(()=>rej(new Error('agent timeout')),30000)),
                    ]);
                    const agent = AGENTS[agentId]||{};
                    const agentReply = agentR.content?.trim() || raw || 'I reviewed your question and am working on a response.';
                    await appendMessage(1, conversation_id, 'assistant', agentReply).catch(() => {});
                    return res.json({ response:agentReply, agent_response:true, agent_id:agentId, agent_name:agent.name||agentId, agent_emoji:agent.emoji||'🤖', agent_color:agent.color||'#8B97B0' });
                }

                // 2026-05-25 — web_search: live web search via Laravel chokepoint.
                // Routes through /api/internal/web/search so every call is
                // audited in agent_web_activity (admin Agent Web Activity panel).
                if (toolCall.tool === 'web_search' && toolCall.params?.query) {
                    const query = String(toolCall.params.query).slice(0, 512);
                    const lavBase = process.env.LARAVEL_BASE_URL || process.env.LARAVEL_URL || process.env.WP_URL || '';
                    if (!lavBase) {
                        return res.json({ response: `I tried to search for "${query}" but LARAVEL_BASE_URL isn't configured on the runtime.`, tool_error: 'laravel_base_url_missing' });
                    }
                    let webResult;
                    try {
                        const ctrl = new AbortController();
                        const timer = setTimeout(() => ctrl.abort(), 15000);
                        const fetchRes = await fetch(`${lavBase.replace(/\/$/, '')}/api/internal/web/search`, {
                            method:  'POST',
                            signal:  ctrl.signal,
                            headers: { 'Content-Type': 'application/json', 'X-LevelUp-Secret': process.env.LU_SECRET || '' },
                            body:    JSON.stringify({ workspace_id: context?.workspace_id || 0, agent_slug: agent_id, query }),
                        });
                        clearTimeout(timer);
                        webResult = await fetchRes.json();
                    } catch (e) {
                        return res.json({ response: `Search for "${query}" failed to reach the backend (${e.message}).`, tool_error: 'web_search_failed' });
                    }
                    if (!webResult || !webResult.success) {
                        return res.json({ response: `Search for "${query}" failed: ${(webResult && webResult.error) || 'unknown error'}.`, tool_error: (webResult && webResult.error) || 'unknown' });
                    }
                    const results = (webResult.data && webResult.data.results) || [];
                    const summary = results.length
                        ? results.slice(0, 5).map((r, i) => `${i+1}. ${r.title} — ${r.snippet} (${r.url})`).join('\n')
                        : '(no results found)';
                    const synthMsgs = [
                        ...messages,
                        { role: 'assistant', content: (raw || '').replace(/<assistant_tool>[\s\S]*?<\/assistant_tool>/gi, '').trim() || `Let me search for that.` },
                        { role: 'user', content: `Live web search results for "${query}":\n\n${summary}\n\nUsing these results, answer the original question concisely. Cite the source domain when useful. If results don't answer the question, say so.` },
                    ];
                    const synthR = await Promise.race([
                        callLLM({ messages: synthMsgs, max_tokens: 800, temperature: 0.55 }),
                        new Promise((_, rej) => setTimeout(() => rej(new Error('synth_timeout')), 30000)),
                    ]).catch(() => ({ content: summary }));
                    const finalReply = (synthR.content || '').trim() || summary;
                    await appendMessage(1, conversation_id, 'assistant', finalReply).catch(() => {});
                    return res.json({
                        response:    finalReply,
                        web_search:  { query, result_count: results.length, activity_id: webResult.activity_id },
                    });
                }

                // 2026-05-25 — web_fetch: fetch a single URL via the audit chokepoint.
                if (toolCall.tool === 'web_fetch' && toolCall.params?.url) {
                    const url = String(toolCall.params.url).slice(0, 2048);
                    const lavBase = process.env.LARAVEL_BASE_URL || process.env.LARAVEL_URL || process.env.WP_URL || '';
                    if (!lavBase) {
                        return res.json({ response: `I tried to fetch ${url} but LARAVEL_BASE_URL isn't configured.`, tool_error: 'laravel_base_url_missing' });
                    }
                    let webResult;
                    try {
                        const ctrl = new AbortController();
                        const timer = setTimeout(() => ctrl.abort(), 20000);
                        const fetchRes = await fetch(`${lavBase.replace(/\/$/, '')}/api/internal/web/fetch`, {
                            method:  'POST',
                            signal:  ctrl.signal,
                            headers: { 'Content-Type': 'application/json', 'X-LevelUp-Secret': process.env.LU_SECRET || '' },
                            body:    JSON.stringify({ workspace_id: context?.workspace_id || 0, agent_slug: agent_id, url }),
                        });
                        clearTimeout(timer);
                        webResult = await fetchRes.json();
                    } catch (e) {
                        return res.json({ response: `Fetch of ${url} failed (${e.message}).`, tool_error: 'web_fetch_failed' });
                    }
                    if (!webResult || !webResult.success) {
                        return res.json({ response: `Could not fetch ${url}: ${(webResult && webResult.error) || 'unknown error'}.`, tool_error: (webResult && webResult.error) || 'unknown' });
                    }
                    const pageTitle = (webResult.data && (webResult.data.og_data?.title || webResult.data.blueprint?.brand_name)) || url;
                    const headings  = ((webResult.data && webResult.data.headings) || []).slice(0, 8).map(h => `${h.level || 'h'}: ${h.text}`).join('\n');
                    const ctas      = ((webResult.data && webResult.data.ctas) || []).slice(0, 6).join(', ');
                    const summary   = `Title: ${pageTitle}\nHeadings:\n${headings || '(none)'}\nCTAs: ${ctas || '(none)'}`;
                    const synthMsgs = [
                        ...messages,
                        { role: 'assistant', content: (raw || '').replace(/<assistant_tool>[\s\S]*?<\/assistant_tool>/gi, '').trim() || `Fetching ${url}.` },
                        { role: 'user', content: `I fetched ${url} and extracted:\n\n${summary}\n\nAnswer the original question using this content. Cite the page title and source domain.` },
                    ];
                    const synthR = await Promise.race([
                        callLLM({ messages: synthMsgs, max_tokens: 800, temperature: 0.55 }),
                        new Promise((_, rej) => setTimeout(() => rej(new Error('synth_timeout')), 30000)),
                    ]).catch(() => ({ content: summary }));
                    const finalReply = (synthR.content || '').trim() || summary;
                    await appendMessage(1, conversation_id, 'assistant', finalReply).catch(() => {});
                    return res.json({
                        response:   finalReply,
                        web_fetch:  { url, activity_id: webResult.activity_id, title: pageTitle },
                    });
                }

                // 2026-05-25 — improve_draft / ai_builder_action.
                // These EDIT existing content and route through Laravel's
                // /api/internal/edit/dispatch (RUNTIME_SECRET-protected),
                // which audit-logs every call to audit_logs + calls the
                // appropriate service method (WriteService::improveDraft,
                // ArthurEditService::editPage).
                // Bypasses the dead WP-bound registry.execute() path.
                // 2026-07-08 — fill_missing_images added: bulk backfill of hero
                // images for articles missing one. Takes NO entity id (backend
                // discovers the articles); optional { limit } caps the batch.
                // Routes through the SAME dispatch chokepoint → Laravel maps it
                // to WriteService::fillMissingImages(). params is optional here,
                // so this tool is allowed through even when omitted.
                // 2026-07-21 (v2.37.3) — `update_post` REMOVED from this
                // allow-list. It mapped to SocialService::updatePost, i.e. edit
                // a social post: out of launch scope. This was the last
                // executable path in the runtime that could still reach a
                // removed tool, because it dispatches by name and bypasses both
                // the registry and the capability map.
                if (toolCall.tool && ['improve_draft', 'ai_builder_action', 'fill_missing_images'].includes(toolCall.tool) && (toolCall.params || toolCall.tool === 'fill_missing_images')) {
                    const editTool = toolCall.tool;
                    const editParams = toolCall.params || {};
                    const lavBase = process.env.LARAVEL_BASE_URL || process.env.LARAVEL_URL || process.env.WP_URL || '';
                    if (!lavBase) {
                        return res.json({ response: `I tried to ${editTool} but LARAVEL_BASE_URL isn't configured.`, tool_error: 'laravel_base_url_missing' });
                    }
                    let editResult;
                    try {
                        const ctrl = new AbortController();
                        const timer = setTimeout(() => ctrl.abort(), 60000); // edits can be slow (LLM-driven)
                        const fetchRes = await fetch(`${lavBase.replace(/\/$/, '')}/api/internal/edit/dispatch`, {
                            method:  'POST',
                            signal:  ctrl.signal,
                            headers: { 'Content-Type': 'application/json', 'X-LevelUp-Secret': process.env.LU_SECRET || '' },
                            body:    JSON.stringify({
                                workspace_id: context?.workspace_id || 0,
                                agent_slug:   agent_id,
                                tool:         editTool,
                                params:       editParams,
                            }),
                        });
                        clearTimeout(timer);
                        editResult = await fetchRes.json();
                    } catch (e) {
                        return res.json({ response: `Edit (${editTool}) failed to reach the backend: ${e.message}.`, tool_error: 'edit_dispatch_failed' });
                    }
                    if (!editResult || !editResult.success) {
                        const errMsg = (editResult && editResult.error) || 'unknown error';
                        return res.json({ response: `Edit failed: ${errMsg}.`, tool_error: errMsg, edit_audit_id: editResult && editResult.audit_id });
                    }
                    // Compose a clean final reply via a second LLM call.
                    const editSummary = JSON.stringify(editResult.data || {}).slice(0, 800);
                    const targetId = editParams.article_id || editParams.id || editParams.page_id || editParams.post_id || '?';
                    const synthMsgs = [
                        ...messages,
                        { role: 'assistant', content: (raw || '').replace(/<assistant_tool>[\s\S]*?<\/assistant_tool>/gi, '').trim() || `Editing ${editTool} #${targetId}.` },
                        { role: 'user', content: `Edit completed. Tool: ${editTool}. Target ID: ${targetId}. Audit row: ${editResult.audit_id}. Result summary: ${editSummary}\n\nConfirm to the user what you changed, cite the entity_id, and note the audit row id for traceability.` },
                    ];
                    const synthR = await Promise.race([
                        callLLM({ messages: synthMsgs, max_tokens: 800, temperature: 0.45 }),
                        new Promise((_, rej) => setTimeout(() => rej(new Error('synth_timeout')), 30000)),
                    ]).catch(() => ({ content: `Done. Edited ${editTool} #${targetId} (audit ${editResult.audit_id}).` }));
                    const finalReply = (synthR.content || '').trim();
                    await appendMessage(1, conversation_id, 'assistant', finalReply).catch(() => {});
                    return res.json({
                        response:  finalReply,
                        edit:      { tool: editTool, target_id: targetId, audit_id: editResult.audit_id, duration_ms: editResult.duration_ms },
                    });
                }

                // execute_tool — run a tool through the unified registry (capability-checked)
                if (toolCall.tool === 'execute_tool' && toolCall.params?.tool_id) {
                    const tool_id   = toolCall.params.tool_id;
                    const toolParams = toolCall.params.params || {};
                    const { hasCapability } = require('./capability-map');
                    if (!hasCapability(agent_id, tool_id)) {
                        return res.json({ response:`I don't have permission to run ${tool_id} directly. I can consult a specialist agent instead.`, tool_error:'capability_denied' });
                    }
                    const unifiedReg = require('./registry');
                    const result = await Promise.race([
                        unifiedReg.execute(tool_id, toolParams, { agent_id }),
                        new Promise((_,rej)=>setTimeout(()=>rej(new Error('tool_timeout')),20000)),
                    ]).catch(e => ({ success:false, error:e.message }));
                    const textBefore = raw.replace(/<assistant_tool>[\s\S]*<\/assistant_tool>/i,'').trim();
                    return res.json({ response:textBefore || 'Done.', tool_executed:true, tool_id, tool_result:result });
                }

                // navigate — platform navigation
                const textBefore = raw.replace(/<assistant_tool>[\s\S]*<\/assistant_tool>/i,'').trim();
                return res.json({ response:textBefore||`Navigating now.`, tool_call:toolCall });
            } catch(e) {
                // JSON parse failed — try XML-style tag extraction as fallback
                // Model sometimes uses <tool>...</tool><tool_id>...</tool_id> format
                const toolTagMatch = toolMatch[1].match(/<tool[^_][^>]*>([^<]+)<\/tool>/i);
                const toolIdMatch  = toolMatch[1].match(/<tool_id>([^<]+)<\/tool_id>/i);
                const toolName     = toolTagMatch ? toolTagMatch[1].trim() : null;
                const toolId       = toolIdMatch  ? toolIdMatch[1].trim()  : null;

                if (toolName === 'execute_tool' && toolId) {
                    // Execute the tool via capability-checked registry
                    const { hasCapability } = require('./capability-map');
                    if (hasCapability(agent_id, toolId)) {
                        const unifiedReg = require('./registry');
                        const result = await Promise.race([
                            unifiedReg.execute(toolId, {}, { agent_id }),
                            new Promise((_,rej) => setTimeout(() => rej(new Error('tool_timeout')), 20000)),
                        ]).catch(e2 => ({ success: false, error: e2.message }));
                        const cleanText = raw.replace(/<assistant_tool>[\s\S]*?<\/assistant_tool>/gi, '').trim();
                        return res.json({ response: cleanText || 'Done.', tool_executed: true, tool_id: toolId, tool_result: result });
                    }
                }
                // Unknown XML format — strip tags and return clean text
                console.warn('[ASSISTANT] tool XML parse failed, stripping tags. raw fragment:', toolMatch[1].slice(0, 80));
            }
        }
        // Always strip any remaining <assistant_tool> blocks before sending to client
        const cleanResponse = raw.replace(/<assistant_tool>[\s\S]*?<\/assistant_tool>/gi, '').trim();
        res.json({ response: cleanResponse || raw });
    } catch(e) {
        console.error('[ASSISTANT] Fatal:', e.message, e.stack?.split('\n')[1] || '');
        // Part 9: Global failsafe — always return a usable response
        if (!res.headersSent) {
            res.status(200).json({
                response: 'The assistant encountered an internal issue but remains operational. Please retry.',
                error:    e.message,
                failsafe: true,
            });
        }
    }
});

// ── Phase 9: Growth Insights endpoints ───────────────────────────────────────
// Lazy — growth-insights and campaign-learning connect Redis at module load.
// Required inside handlers to avoid boot-time Redis connection race.

// ── Part 4: Tool Discovery + Health endpoints ────────────────────────────────
// Lazy requires — these modules connect Redis at load time; defer until actually needed.
// discovery, toolLearning, healthCheck are required inline inside route handlers only.

app.post('/internal/tools/discover', requireSecret, async (req, res) => {
    const wp_url = process.env.WP_URL || req.body?.wp_url || '';
    const secret = process.env.WP_SECRET || '';
    try {
        const { scanPlatformTools } = require('./tool-discovery');
        const { learnNewTools }     = require('./tool-learning');
        const result   = await scanPlatformTools(wp_url, secret);
        const newTools = (result.dynamic || []).filter(t => t.auto_discovered);
        const knowledge = newTools.length
            ? await learnNewTools(newTools).then(r => r.map(x => x.knowledge))
            : [];
        res.json({ success: true, ...result, knowledge });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/internal/tools/health', requireSecret, async (req, res) => {
    try {
        const { getHealthSummary } = require('./tool-health-check');
        const summary = await getHealthSummary();
        res.json({ success: true, ...summary });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/internal/tools/health/run', requireSecret, async (req, res) => {
    const wp_url = process.env.WP_URL || '';
    const secret = process.env.WP_SECRET || '';
    try {
        const { runHealthChecks } = require('./tool-health-check');
        const result = await runHealthChecks(wp_url, secret, { force: true });
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/internal/insights/refresh', requireSecret, async (req, res) => {
    const wp_url    = process.env.WP_URL || '';
    const wp_secret = process.env.WP_SECRET || '';
    try {
        const { generateInsights }           = require('./growth-insights');
        const { refreshInsights: refreshCampaignInsights } = require('./campaign-learning');
        const [growth, campaign] = await Promise.allSettled([
            generateInsights(wp_url, wp_secret),
            refreshCampaignInsights(wp_url, wp_secret),
        ]);
        res.json({
            success:  true,
            growth:   growth.status  === 'fulfilled' ? growth.value  : null,
            campaign: campaign.status === 'fulfilled' ? campaign.value : null,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/internal/insights/current', requireSecret, async (req, res) => {
    try {
        const { readInsights: readGrowthInsights }          = require('./growth-insights');
        const { readInsights: readCampaignInsights }         = require('./campaign-learning');
        const [growth, campaign] = await Promise.allSettled([
            readGrowthInsights(),
            readCampaignInsights(),
        ]);
        res.json({
            growth:   growth.status  === 'fulfilled' ? growth.value  : null,
            campaign: campaign.status === 'fulfilled' ? campaign.value : null,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Governance ─────────────────────────────────────────────────────────────
const { getPendingActions, approveAction, rejectAction } = require('./tool-executor');

app.get('/internal/governance/pending', requireSecret, async (req, res) => {
    try { const actions = await getPendingActions(); res.json({ success:true, pending:actions, count:actions.length }); }
    catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

app.post('/internal/governance/approve', requireSecret, async (req, res) => {
    const { action_id } = req.body;
    if (!action_id) return res.status(400).json({ success:false, error:'action_id required.' });
    try { res.json(await approveAction(action_id)); }
    catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

app.post('/internal/governance/reject', requireSecret, async (req, res) => {
    const { action_id } = req.body;
    if (!action_id) return res.status(400).json({ success:false, error:'action_id required.' });
    try { res.json(await rejectAction(action_id)); }
    catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

// ── PHASE 1A: New route mounts ─────────────────────────────────────────────

// Phase 6 — Task queue routes
app.use('/internal/task', taskQueueRoutes);

// Phase 7 — Intelligence routes (plan, memory, trace, collab)
app.use('/internal/intelligence', intelligenceRoutes);

// Phase 7 — Backward-compat alias: PHP lu_agent_plan_create calls this path
app.post('/internal/agent/plan', (req, res) => handlePlan(req, res));

// Phase 8 — Activity stream routes (SSE + event log)
app.use('/internal/activity', activityRoutes);

// Builder AI routes
registerBuilderRoutes(app);

// Synthesis route — called by lu-task-worker.js when SYNTHESIS_ENDPOINT is set
// Set Railway env: SYNTHESIS_ENDPOINT=https://<runtime-url>/internal/synthesize
app.use('/internal/synthesize', synthesisRoutes);

// 2026-05-24 — Sarah synthesis routes (intelligence-in-runtime move).
// Three endpoints owning the daily/weekly/monthly synthesis prompts so
// Laravel orchestrators stay thin (gather state → POST → persist result).
//   POST /internal/sarah/synthesize-daily
//   POST /internal/sarah/synthesize-weekly
//   POST /internal/sarah/synthesize-monthly
sarahSynthesisRoutes.mountRoutes(app, requireSecret);
// GSC intelligence — POST /internal/seo/gsc-intelligence (Phase 3).
gscIntelligence.mountRoutes(app, requireSecret);

// 2026-05-24 — Agent search route. Server-side query → SERP results.
// Backed by /internal/agent-search (DuckDuckGo HTML default). Laravel's
// WebActivityService is the chokepoint that logs every call.
agentSearchRoutes.mountRoutes(app, requireSecret);

// ══════════════════════════════════════════════════════════════════════════════
// CONTENT TYPE INTELLIGENCE — Write Engine
// TYPE_PROMPTS: per-type system prompt + required section structure.
// buildWritePrompt(): assembles final system+user prompts for any content type.
// Used by both /internal/write/draft (JSON) and /internal/write/stream (SSE).
// ══════════════════════════════════════════════════════════════════════════════

const TYPE_PROMPTS = {

    blog_article: {
        system: 'You are an expert SEO content writer specialising in long-form blog content for the MENA/Dubai market.',
        tokens:  { short: 800, medium: 1200, long: 2000 },
        structure: `Write a complete, publication-ready blog article structured as follows:

TITLE: [Compelling H1 title using the topic provided]

INTRODUCTION
A 2-3 sentence hook that draws the reader in, followed by 1-2 sentences stating what the article covers.

SECTION 1: [First key theme — H2 heading]
Detailed paragraph expanding on this theme. Include specific examples, data points, or insights.

SECTION 2: [Second key theme — H2 heading]
Detailed paragraph with supporting evidence or analysis.

SECTION 3: [Third key theme — H2 heading]
Practical application, case study reference, or deeper insight.

SECTION 4: [Fourth key theme — H2 heading]
Forward-looking perspective, implications, or expert take.

KEY TAKEAWAYS
3-5 bullet points summarising the most important points.

FAQ
Q: [Relevant question 1]
A: [Concise answer]

Q: [Relevant question 2]
A: [Concise answer]

Q: [Relevant question 3]
A: [Concise answer]

CONCLUSION
Tie back to the introduction. End with a forward-looking statement or call to action.`,
    },

    service_page: {
        system: 'You are a high-converting website copywriter who writes service pages that build trust and drive enquiries.',
        tokens:  { short: 700, medium: 1000, long: 1500 },
        structure: `Write complete service page copy structured as follows:

HEADLINE
A clear, benefit-focused H1 headline (under 10 words).

SUBHEADLINE
One sentence expanding on the headline promise.

INTRODUCTION
2-3 sentences describing the service, who it is for, and the core problem it solves.

WHY CHOOSE US
3-4 benefit statements. Each: [Benefit title] — [1-sentence explanation].

WHAT WE OFFER
A breakdown of the specific services or deliverables included. Use clear labels.

OUR PROCESS
Step 1: [Name] — [Brief description]
Step 2: [Name] — [Brief description]
Step 3: [Name] — [Brief description]
Step 4: [Name] — [Brief description]

TRUST SIGNALS
Mention credentials, experience, results, or client types served.

CALL TO ACTION
A direct, compelling CTA with a clear next step.`,
    },

    landing_page_copy: {
        system: 'You are a direct response conversion copywriter. Every line must push the reader towards one action.',
        tokens:  { short: 700, medium: 1100, long: 1600 },
        structure: `Write high-converting landing page copy structured as follows:

HERO HEADLINE
Bold, attention-grabbing headline that names the transformation or outcome.

HERO SUBHEADLINE
One sentence clarifying the offer and who it is for.

PRIMARY CTA
Short, action-driven button text.

THE PROBLEM
2-3 sentences describing the pain point your target customer feels before your solution.

THE SOLUTION
2-3 sentences introducing your offer as the answer to that problem.

BENEFITS
Benefit 1: [Bold title] — [1-sentence elaboration]
Benefit 2: [Bold title] — [1-sentence elaboration]
Benefit 3: [Bold title] — [1-sentence elaboration]
Benefit 4: [Bold title] — [1-sentence elaboration]

SOCIAL PROOF
A testimonial or result: "[Quote]" — [Name, Title/Company]

FINAL CTA SECTION
Urgency or value reminder + primary CTA repeated.`,
    },

    email_campaign: {
        system: 'You are an email marketing specialist who writes campaigns that get opened, read, and clicked.',
        tokens:  { short: 500, medium: 750, long: 1000 },
        structure: `Write a complete marketing email structured exactly as follows:

SUBJECT LINE: [Compelling subject line under 50 characters]

PREHEADER: [Preview text — extends the subject, under 90 characters]

GREETING:
Hi {{first_name}},

BODY:
[Opening sentence that hooks immediately — relate to a pain point or goal]

[2-3 paragraphs of body copy. Be concise, conversational, and purposeful. Lead to the CTA naturally.]

CTA BUTTON: [Action-driven button text]

CTA URL: [Placeholder: https://yourdomain.com/landing-page]

CLOSING:
[1-2 sentence warm close]

SIGNATURE:
Best regards,
{{sender_name}}
{{sender_title}} | {{company_name}}
{{phone}} | {{website}}

P.S. [Optional P.S. that reinforces the offer or adds urgency]`,
    },

    email_sequence: {
        system: 'You are an email sequence strategist who builds nurture flows that convert over time.',
        tokens:  { short: 800, medium: 1200, long: 1800 },
        structure: `Write a 3-email nurture sequence. Each email is clearly separated.

EMAIL 1 — WELCOME / VALUE
Subject: [Subject line]
Preheader: [Preview text]
Body: Welcome the subscriber. Deliver immediate value. Set expectations for the sequence.
CTA: [Soft CTA — read a blog, follow on social, reply with a question]

---

EMAIL 2 — EDUCATION / TRUST
Subject: [Subject line]
Preheader: [Preview text]
Body: Go deeper on a problem or topic they care about. Share insight, a case study reference, or a practical tip.
CTA: [Medium CTA — download, watch, or learn more]

---

EMAIL 3 — OFFER / CONVERSION
Subject: [Subject line]
Preheader: [Preview text]
Body: Present the primary offer or next step. Use social proof. Create urgency or value.
CTA: [Strong CTA — book, buy, start, apply]`,
    },

    sales_script: {
        system: 'You are a sales trainer and script writer who creates scripts that convert without being pushy.',
        tokens:  { short: 700, medium: 1000, long: 1500 },
        structure: `Write a complete sales script structured as follows:

OPENING
[Warm, natural opening line. Introduce yourself and ask if they have a moment.]

HOOK
[State the reason for the call in one benefit-focused sentence. Make it relevant to them.]

DISCOVERY QUESTION
[One open question to understand their situation or pain point.]

PAIN POINT
[Acknowledge the common challenge your prospect faces. Make them feel understood.]

PITCH
[Present your solution clearly. Focus on outcome, not features. Keep it under 3 sentences.]

PROOF POINT
[Brief reference to a result, client, or case that backs up your claim.]

OBJECTION HANDLING
Objection: "I need to think about it."
Response: [Empathetic, non-pushy response]

Objection: "It's too expensive."
Response: [Value reframe response]

Objection: "I'm already using another solution."
Response: [Differentiation response]

CLOSE
[Clear, confident ask for the next step — a meeting, a trial, a decision.]

FOLLOW-UP LINE
[If no decision: leave the door open professionally.]`,
    },

    social_caption: {
        system: 'You are a social media strategist who writes captions that stop the scroll and drive engagement.',
        tokens:  { short: 200, medium: 350, long: 500 },
        structure: `Write a social media caption structured as follows:

HOOK
[First line — make it impossible to scroll past. Ask a question, share a bold statement, or open a loop.]

BODY
[2-4 sentences expanding the hook. Share value, a story, a lesson, or a perspective. Keep it readable — short lines.]

CTA
[Clear action: comment, save, share, click link in bio, DM us, etc.]

HASHTAGS
[8-15 relevant hashtags. Mix broad and niche. Format: #hashtag]`,
    },

    ad_copy: {
        system: 'You are a paid media copywriter who writes ads that drive clicks and conversions at scale.',
        tokens:  { short: 400, medium: 600, long: 800 },
        structure: `Write ad copy variations structured as follows:

HEADLINE VARIATIONS (for A/B testing)
Headline 1: [Under 30 characters — benefit-led]
Headline 2: [Under 30 characters — curiosity or question]
Headline 3: [Under 30 characters — urgency or proof]

PRIMARY TEXT VARIATIONS
Version A (Problem-aware):
[2-3 sentences. Open with the pain. Introduce solution. End with CTA.]

Version B (Outcome-led):
[2-3 sentences. Open with the result. Show how. End with CTA.]

DESCRIPTION LINE
[One sentence that supports the headline and adds context. Under 90 characters.]

CTA OPTIONS
[3 short CTA options: e.g. Learn More / Get a Quote / Book Now]`,
    },

    product_description: {
        system: 'You are an ecommerce conversion copywriter who writes product descriptions that sell.',
        tokens:  { short: 400, medium: 700, long: 1000 },
        structure: `Write a product description structured as follows:

PRODUCT NAME
[Clear product name as heading]

SHORT DESCRIPTION
[1-2 sentences: what the product is, who it is for, and the core benefit. Used for listings.]

KEY FEATURES
Feature 1: [Name] — [Brief description]
Feature 2: [Name] — [Brief description]
Feature 3: [Name] — [Brief description]
Feature 4: [Name] — [Brief description]

BENEFITS
[2-3 sentences explaining how the product improves the customer's life or business. Focus on outcome, not specs.]

SPECIFICATIONS
[Relevant technical details: dimensions, materials, compatibility, formats, or requirements.]

CTA
[Direct action: Buy Now / Add to Cart / Get a Quote / Order Today]`,
    },

    case_study: {
        system: 'You are a case study writer who turns client results into compelling proof of impact.',
        tokens:  { short: 700, medium: 1100, long: 1600 },
        structure: `Write a complete case study structured as follows:

TITLE
[Result-focused title: "How [Client Type] Achieved [Result] with [Solution]"]

CLIENT OVERVIEW
Client: [Type of business, industry, size — keep anonymous if no specific client named]
Challenge: [One-sentence summary of their situation before]

THE CHALLENGE
[2-3 sentences describing the specific problem, pain point, or gap the client faced. Be specific — numbers where possible.]

THE SOLUTION
[2-3 sentences describing what was done, how it was approached, and which tools or methods were used.]

IMPLEMENTATION
Step 1: [Action taken]
Step 2: [Action taken]
Step 3: [Action taken]

THE RESULTS
[2-3 sentences of outcomes. Use metrics where possible.]
Result 1: [Metric or outcome]
Result 2: [Metric or outcome]
Result 3: [Qualitative outcome]

CLIENT TESTIMONIAL
"[Quote that captures the experience and result — written as a representative quote]"
— [Job title], [Industry]

CALL TO ACTION
[1-2 sentences inviting the reader to achieve similar results. Include next step.]`,
    },

    location_page: {
        system: 'You are a local SEO content writer who writes location pages that rank and convert.',
        tokens:  { short: 600, medium: 900, long: 1300 },
        structure: `Write a location page structured as follows:

HEADLINE
[Service] in [Location] — [Benefit or differentiator]

INTRODUCTION
2-3 sentences. Mention the location naturally. State what service is offered and who it serves.

WHY [LOCATION] CUSTOMERS CHOOSE US
3-4 sentences about local relevance, understanding of the market, or proximity benefits.

OUR SERVICES IN [LOCATION]
Service 1: [Name + 1-sentence description]
Service 2: [Name + 1-sentence description]
Service 3: [Name + 1-sentence description]

LOCAL TRUST SIGNALS
[Mention number of clients served, years in area, local partnerships, or area knowledge.]

LOCAL TESTIMONIAL
"[Representative client quote mentioning the location]"
— [Title], [Location area]

CALL TO ACTION
[Direct CTA with contact method. Mention location.]`,
    },

    website_section_copy: {
        system: 'You are a website copywriter who writes punchy, conversion-focused section copy.',
        tokens:  { short: 300, medium: 500, long: 750 },
        structure: `Write website section copy structured as follows:

SECTION HEADLINE
[Clear, benefit-focused H2 or H3 heading for this section]

SECTION SUBHEADLINE
[Optional: one supporting sentence under the headline]

SECTION BODY
[2-4 sentences of body copy. Focus on a single idea. Lead naturally to the CTA or next section.]

CALL TO ACTION
[Optional section CTA if needed]`,
    },

    testimonial_block: {
        system: 'You are a testimonial copywriter who crafts authentic, specific, results-focused client quotes.',
        tokens:  { short: 200, medium: 350, long: 500 },
        structure: `Write a testimonial block structured as follows:

PRIMARY TESTIMONIAL
"[Testimonial quote: specific, results-focused, and authentic. Mentions a before/after or concrete outcome. 2-4 sentences.]"
— [Full Name or Title], [Company or Industry]

CONTEXT LINE
[1 sentence explaining what the client used the service for, to set context for the reader]

SECONDARY TESTIMONIAL (optional)
"[Shorter supporting quote from a different perspective or industry]"
— [Title], [Industry]`,
    },

    faq_set: {
        system: 'You are a support and content writer who writes FAQ sections that reduce friction and build confidence.',
        tokens:  { short: 500, medium: 800, long: 1200 },
        structure: `Write an FAQ section structured as follows:

FAQ INTRODUCTION
[1-2 sentences introducing the FAQ section. Optional but recommended for SEO.]

Q: [Question 1 — the most common question customers ask]
A: [Clear, direct answer in 2-4 sentences. Use plain language.]

Q: [Question 2 — a pricing or value question]
A: [Answer that addresses cost or value without being evasive.]

Q: [Question 3 — a how-it-works question]
A: [Step-by-step or brief process explanation.]

Q: [Question 4 — a trust or credibility question]
A: [Answer that builds confidence — experience, results, guarantees.]

Q: [Question 5 — a getting-started question]
A: [Simple, low-friction answer with a clear next step.]

Q: [Question 6 — an objection disguised as a question]
A: [Address the real concern behind the question empathetically.]

CTA LINE
[1 sentence CTA after the FAQ — invite them to reach out if their question was not answered.]`,
    },

    crm_message_template: {
        system: 'You are a CRM and sales messaging specialist who writes personalised outreach templates that get responses.',
        tokens:  { short: 300, medium: 500, long: 700 },
        structure: `Write a CRM message template structured as follows:

TEMPLATE NAME
[Descriptive name: e.g. "Follow-up After First Meeting" or "Re-engagement After 30 Days"]

SUBJECT LINE (if email)
[Subject line using personalisation variable: {{first_name}} or {{company}}]

MESSAGE BODY

Hi {{first_name}},

[Opening line — personalised, relevant, not generic. Reference their situation or a previous interaction if applicable.]

[Core message — 2-3 sentences. Be clear about purpose. Offer value or a clear reason to reply.]

[Soft CTA — make the next step easy and low-commitment.]

[Closing line — warm but professional]

Best,
{{sender_name}}
{{sender_title}} | {{company_name}}

PERSONALISATION VARIABLES USED
[List all {{variables}} included in this template so the CRM admin knows what fields to map]

USAGE NOTES
[When to send this template, trigger event, or recommended sequence position]`,
    },

};  // end TYPE_PROMPTS

/**
 * buildWritePrompt — assembles system + user prompts for any content type.
 * Used by both streaming and non-streaming write endpoints.
 * Falls back to generic prompt if type not found (preserves existing behavior).
 *
 * @param {Object} opts
 * @param {string} opts.content_type
 * @param {string} opts.title
 * @param {string} opts.tone
 * @param {string} opts.length   short | medium | long
 * @param {string} opts.intent
 * @param {string} [opts.brief]
 * @param {string[]} [opts.keywords]
 * @returns {{ system: string, user: string, max_tokens: number }}
 */
function buildWritePrompt({ content_type, title, tone, length, intent, brief, keywords, seo_brief }) {
    const normalizedType = (content_type || '').toLowerCase().replace(/-/g, '_').trim();
    const cfg            = TYPE_PROMPTS[normalizedType] || null;
    const safeTone       = tone    || 'professional';
    const safeLength     = length  || 'medium';
    const safeTitle      = title   || brief || 'Untitled';
    const kwLine         = (keywords && keywords.length > 0)
        ? `\nKeywords to incorporate naturally: ${keywords.join(', ')}`
        : '';

    // Token budget — per-type overrides, then length scale
    const defaultTokens = { short: 700, medium: 1000, long: 1600 };
    let max_tokens;
    if (cfg && cfg.tokens) {
        max_tokens = cfg.tokens[safeLength] || cfg.tokens.medium;
    } else {
        max_tokens = defaultTokens[safeLength] || defaultTokens.medium;
    }

    // ── SEO Brief context block ───────────────────────────────────────────────
    // Injected when available. Falls back gracefully if absent or incomplete.
    const seo = (seo_brief && seo_brief.primary_keyword) ? seo_brief : null;
    const seoContext = seo ? `
SEO BRIEF:
Primary keyword: ${seo.primary_keyword}
Secondary keywords: ${(seo.secondary_keywords || []).join(', ') || 'none'}
Search intent: ${seo.search_intent || 'informational'}
Target word count: ${seo.word_count || 'match length target'}
${(seo.suggested_headings || []).length > 0 ? `Suggested section headings:\n${seo.suggested_headings.map(h => '- ' + h).join('\n')}` : ''}
${(seo.questions || []).length > 0 ? `Questions to answer (include in FAQ or body):\n${seo.questions.map(q => '- ' + q).join('\n')}` : ''}
${(seo.internal_links || []).length > 0 ? `Internal links to include naturally:\n${seo.internal_links.map(l => `- "${l.anchor || l}": ${l.url || ''}`.trim()).join('\n')}` : ''}
` : '';

    // Word count instruction from brief
    const wordCountLine = seo && seo.word_count
        ? `Target word count: ${seo.word_count} words minimum`
        : '';

    const seoRules = seo ? `
SEO EXECUTION RULES (mandatory):
- Use the primary keyword "${seo.primary_keyword}" in:
  - The very first heading/title
  - The first 100 words of the introduction
- Distribute secondary keywords naturally across sections — never force them
- Follow the suggested heading structure EXACTLY — do not rename or skip headings
- Include a FAQ section that answers the listed questions
- Reference internal link anchor text naturally within relevant sentences
- Maintain readability — no keyword stuffing
- ${wordCountLine}
- Grade will be computed post-generation — aim for 85+/100` : '';

    // 2026-06-11 — UNIQUENESS enforcement. Injected into every content prompt so
    // the model cannot produce near-identical pages that only swap a location or
    // keyword (the chef-red doorway-page problem: 33 county pages ~90% identical).
    // When the caller passes context.existing_pages / context.differentiate (e.g.
    // sibling articles), it lands in the "Additional context" block below and this
    // rule forces the output to diverge from them.
    const UNIQUENESS_RULE = `
UNIQUENESS (mandatory — overrides everything except factual accuracy):
- Produce ORIGINAL content. Do NOT write a templated clone where only a place name, county, or keyword is find-and-replaced. Two pages on the same service for different areas must differ in opening, examples, structure, and specifics — not just the location word.
- If the context lists existing/sibling pages or a "differentiate" instruction, your output MUST be materially different from them: a different angle, different anecdotes/examples, a different section order.
- For location / service-area content, include GENUINELY local specifics (real neighbourhoods, towns, landmarks, local context). Generic boilerplate with the area name slotted in is NOT acceptable.`;

    if (!cfg) {
        // Preserve existing generic fallback — no regression
        const system = `You are a professional content writer for a Dubai-based marketing agency. Write clear, engaging, publication-ready ${(content_type || 'content').replace(/_/g, ' ')} content. Rules: no markdown symbols (no *, #, -, —), no placeholder text. Use clean paragraphs separated by blank lines. Tone: ${safeTone}. Start immediately — no preamble.${UNIQUENESS_RULE}`;
        const user   = `Write ${(content_type || 'content').replace(/_/g, ' ')}.\n\nTopic: ${safeTitle}\nTone: ${safeTone}${seoContext ? '\n' + seoContext : ''}${kwLine}\n\nBegin with the opening paragraph directly.`;
        return { system, user, max_tokens };
    }

    const system = `${cfg.system}

STRUCTURE — follow this exactly:
${cfg.structure}

RULES:
- Output must follow the exact section order above
- Each section must have a clear heading
- Do not merge sections
- Do not skip required sections
- Do not output explanations, meta-commentary, or "Here is your..." preamble
- Output final content only — start immediately with the first section
- Tone throughout: ${safeTone}${UNIQUENESS_RULE}${seoRules}`;

    const user = `Generate the following content:

Type: ${normalizedType.replace(/_/g, ' ')}
Topic / Title: ${safeTitle}
Tone: ${safeTone}
Length target: ${safeLength}${seoContext ? '\n' + seoContext : ''}${kwLine}${intent ? `\nIntent: ${intent}` : ''}${brief && brief !== title ? `\nBrief: ${brief}` : ''}

Follow the required structure strictly. Begin immediately with the first section heading.`;

    return { system, user, max_tokens };
}

// ══════════════════════════════════════════════════════════════════════════════
// WRITE ENGINE — Phase 4
// Three endpoints consumed by levelup-write-engine PHP plugin via lu_runtime().
// All use DeepSeek (default provider). No markdown in output. Plain paragraphs.
// ══════════════════════════════════════════════════════════════════════════════

// POST /internal/write/draft  — generate a new AI draft from brief/title/keywords
app.post('/internal/write/draft', requireSecret, async (req, res) => {
    const { title = '', brief = '', keywords = [], tone = 'professional', length = 'medium', content_type = 'blog_article', context = {} } = req.body || {};

    if (!title && !brief) {
        return res.status(400).json({ success: false, error: 'title or brief required' });
    }

    const lengthMap = { short: { words: '250–350 words', tokens: 700 }, medium: { words: '400–550 words', tokens: 1000 }, long: { words: '700–900 words', tokens: 1600 } };
    const lg = lengthMap[length] || lengthMap.medium;
    const kwLine = keywords.length > 0 ? `Naturally incorporate these keywords: ${keywords.join(', ')}.` : '';
    const ctxLines = Object.entries(context).filter(([,v]) => v).map(([k,v]) => `${k}: ${v}`).join('\n');

    // ── Type-intelligent + SEO-enriched prompt via buildWritePrompt() ──────────
    const { seo_brief: draft_seo_brief } = req.body || {};
    const prompts      = buildWritePrompt({ content_type, title: title || brief, tone, length, intent: 'generate', brief, keywords, seo_brief: draft_seo_brief });
    const systemPrompt = prompts.system;
    const userPrompt   = ctxLines
        ? prompts.user + '\nAdditional context:\n' + ctxLines
        : prompts.user;
    // Use per-type token budget (overrides generic lg.tokens)
    const resolvedTokens = prompts.max_tokens;

    try {
        const result = await callLLM({ messages: [{ role:'system', content:systemPrompt }, { role:'user', content:userPrompt }], max_tokens: resolvedTokens, temperature: 0.72 });
        const content = result.content.trim();
        const word_count = content.split(/\s+/).filter(w => w.length > 0).length;
        return res.json({ success:true, content, meta:{ word_count, tokens_used: result.usage?.total_tokens || 0, source:'deepseek', tone, length } });
    } catch (err) {
        console.error('[write/draft]', err.message);
        return res.status(500).json({ success:false, error:'AI generation failed: ' + err.message });
    }
});

// POST /internal/write/improve  — improve existing content
app.post('/internal/write/improve', requireSecret, async (req, res) => {
    const { content = '', instruction = '', tone = '', context = {} } = req.body || {};

    if (!content) return res.status(400).json({ success:false, error:'content required' });

    const focusLine = instruction || 'Improve clarity, readability, and flow. Strengthen the opening. Ensure smooth transitions between paragraphs.';
    const toneLine  = tone ? `Maintain or adjust to a ${tone} tone.` : 'Preserve the existing tone.';

    const systemPrompt = `You are a senior editor and content strategist. You improve existing content while fully preserving its meaning, structure, and intent. \
Rules: no markdown (no *, #, -, —), no placeholder text. Return only the improved content — no commentary, no "Here is the improved version:", just the content itself.`;

    const userPrompt = `Improve the following content.

Instruction: ${focusLine}
Tone: ${toneLine}
${Object.entries(context).filter(([,v])=>v).map(([k,v])=>`${k}: ${v}`).join('\n')}

--- ORIGINAL CONTENT ---
${content.slice(0, 6000)}
--- END ---

Return the improved version now. Start directly with the first paragraph.`;

    try {
        const result = await callLLM({ messages: [{ role:'system', content:systemPrompt }, { role:'user', content:userPrompt }], max_tokens: Math.min(2000, Math.ceil(content.length / 3) + 400), temperature: 0.6 });
        const improved = result.content.trim();
        const word_count = improved.split(/\s+/).filter(w=>w.length>0).length;
        return res.json({ success:true, content:improved, meta:{ word_count, tokens_used: result.usage?.total_tokens || 0, source:'deepseek' } });
    } catch (err) {
        console.error('[write/improve]', err.message);
        return res.status(500).json({ success:false, error:'AI improvement failed: ' + err.message });
    }
});

// POST /internal/write/rewrite  — rewrite content with new tone/style/intent
app.post('/internal/write/rewrite', requireSecret, async (req, res) => {
    const { content = '', instruction = '', tone = 'professional', context = {} } = req.body || {};

    if (!content) return res.status(400).json({ success:false, error:'content required' });

    const directiveBase = instruction || `Rewrite with a ${tone} tone.`;

    const systemPrompt = `You are a professional copywriter. You rewrite content to match a specific tone or style while preserving all key information and meaning. \
Rules: no markdown (no *, #, -, —), no placeholder text. Return only the rewritten content — nothing else.`;

    const userPrompt = `Rewrite the following content.

Directive: ${directiveBase}
Target tone: ${tone}
${Object.entries(context).filter(([,v])=>v).map(([k,v])=>`${k}: ${v}`).join('\n')}

Important: preserve all factual information. Do not add or remove key points. Only change tone, style, and phrasing.

--- ORIGINAL CONTENT ---
${content.slice(0, 6000)}
--- END ---

Write the rewritten version now. Start directly with the first paragraph.`;

    try {
        const result = await callLLM({ messages: [{ role:'system', content:systemPrompt }, { role:'user', content:userPrompt }], max_tokens: Math.min(2000, Math.ceil(content.length / 3) + 400), temperature: 0.75 });
        const rewritten = result.content.trim();
        const word_count = rewritten.split(/\s+/).filter(w=>w.length>0).length;
        return res.json({ success:true, content:rewritten, meta:{ word_count, tokens_used: result.usage?.total_tokens || 0, source:'deepseek', tone } });
    } catch (err) {
        console.error('[write/rewrite]', err.message);
        return res.status(500).json({ success:false, error:'AI rewrite failed: ' + err.message });
    }
});

// ══════════════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════════════
// WRITE ENGINE STREAMING — S2 (hardened)
// ════════════════════════════════════════════════════════════════════════════════
// SCANNER + BLUEPRINT MIGRATION — Patch 1+2 (v2.25.0)
// POST /internal/scanner
// Replaces PHP wp_remote_get() + DOMDocument parsing.
// Runtime = ALL execution. WP = store result only.
// Patch 8: SSRF protection built-in. Patch 6: AbortController 10s timeout.
// Patch 4: standard {task_id, status, result, error} envelope.
// Patch 7: cheerio loaded lazily per-request (no startup cost).
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Patch 8: SSRF protection — block localhost and RFC-1918 private ranges.
 * Returns an error string if blocked, null if safe.
 */
function _checkSsrf(rawUrl) {
    let parsed;
    try { parsed = new URL(rawUrl); } catch { return 'invalid URL format'; }
    const scheme = parsed.protocol;
    if (!['http:', 'https:'].includes(scheme)) return 'URL must use http or https';
    const host = parsed.hostname.toLowerCase();
    if (['localhost', '127.0.0.1', '::1', '0.0.0.0', '[::]'].includes(host)) {
        return 'scanning internal addresses is not allowed';
    }
    // RFC-1918 + link-local ranges (basic regex check)
    if (/^10\./.test(host))                               return 'scanning private IP ranges is not allowed';
    if (/^192\.168\./.test(host))                        return 'scanning private IP ranges is not allowed';
    if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(host))     return 'scanning private IP ranges is not allowed';
    if (/^169\.254\./.test(host))                        return 'scanning link-local addresses is not allowed';
    if (/^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./.test(host)) return 'scanning CGNAT ranges is not allowed';
    return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// WEBSITE DEPLOYMENT — Phase 6 build pipeline
// Receives deploy job from WP Core, fetches deploy-prep, builds static site,
// uploads back to WP uploads directory.
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/internal/deploy/build', requireSecret, async (req, res) => {
    const { job_id, website_id, domain, wp_url } = req.body || {};

    if (!job_id || !website_id) {
        return res.status(400).json({ success: false, error: 'job_id and website_id required' });
    }

    logger.info(`[Deploy] Starting build job=${job_id} website=${website_id}`);

    // Respond immediately — build runs async
    res.json({ success: true, job_id, status: 'building', message: 'Build started.' });

    // Async build process
    (async () => {
        const axios = require('axios');
        const wpSecret = process.env.WP_SECRET;
        const wpBase   = wp_url || process.env.WP_CALLBACK_URL || 'https://staging1.shukranuae.com';
        const apiBase  = wpBase.replace(/\/$/, '') + '/wp-json/lu/v1';
        const headers  = { 'X-LevelUp-Secret': wpSecret, 'Content-Type': 'application/json' };

        const updateJob = async (data) => {
            try {
                // Direct DB update callback via WP REST
                await axios.post(apiBase + '/deploy/job-update', { job_id, ...data }, { headers, timeout: 10000 });
            } catch (e) { logger.warn(`[Deploy] Job update failed: ${e.message}`); }
        };

        try {
            await updateJob({ status: 'building', progress: 10 });

            // 1. Fetch deploy-prep payload
            logger.info(`[Deploy] Fetching deploy-prep for website ${website_id}`);
            const prepResp = await axios.get(apiBase + `/websites/${website_id}/deploy-prep`, { headers, timeout: 30000 });
            const prep     = prepResp.data;

            if (!prep.success || !prep.pages || !prep.pages.length) {
                await updateJob({ status: 'failed', error_message: 'Deploy-prep returned no pages.' });
                return;
            }

            await updateJob({ status: 'building', progress: 30 });

            // 2. Build files in memory
            const pages    = prep.pages;
            const customCss = prep.deploy_hints?.custom_css || '';
            const customJs  = prep.deploy_hints?.custom_js || '';
            const files    = {};
            let totalBytes = 0;

            for (const page of pages) {
                let html = page.html || '';
                if (!html) continue;

                // Inject custom CSS/JS
                if (customCss && html.includes('</head>')) {
                    html = html.replace('</head>', `<style>${customCss}</style></head>`);
                }
                if (customJs && html.includes('</body>')) {
                    html = html.replace('</body>', `<script>${customJs}</script></body>`);
                }

                const slug     = page.slug || 'page-' + page.page_id;
                const filename = (slug === 'home' || slug === 'index') ? 'index.html' : slug + '/index.html';
                files[filename] = html;
                totalBytes += Buffer.byteLength(html, 'utf8');
            }

            await updateJob({ status: 'uploading', progress: 60 });

            // 3. Upload to WP (via callback endpoint that writes files)
            logger.info(`[Deploy] Uploading ${Object.keys(files).length} files to WP`);
            const uploadResp = await axios.post(apiBase + '/deploy/upload-build', {
                job_id,
                website_id,
                files,  // { 'index.html': '<html>...', 'about/index.html': '<html>...' }
            }, { headers, timeout: 60000, maxContentLength: 50 * 1024 * 1024 });

            if (!uploadResp.data.success) {
                await updateJob({ status: 'failed', error_message: uploadResp.data.error || 'Upload failed.' });
                return;
            }

            await updateJob({
                status: 'completed',
                progress: 100,
                output_url: uploadResp.data.output_url,
                pages_built: Object.keys(files).length,
                total_bytes: totalBytes,
            });

            logger.info(`[Deploy] DONE job=${job_id} pages=${Object.keys(files).length} bytes=${totalBytes}`);

        } catch (err) {
            logger.error(`[Deploy] FAILED job=${job_id}: ${err.message}`);
            await updateJob({ status: 'failed', error_message: err.message });
        }
    })();
});

// ═══════════════════════════════════════════════════════════════════════════════
// VIDEO EXPORT — ManualEdit888 export pipeline (Phase 1 fix)
// Accepts project+layers+timeline from WP, queues BullMQ job for processing.
// Worker uses ffmpeg (must be installed on Railway) or returns error.
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/internal/edit/export-video', requireSecret, async (req, res) => {
    const { project, layers, timeline, format = 'mp4' } = req.body || {};
    const export_id = uuidv4();

    if (!project || !project.id) {
        return res.status(400).json({ success: false, error: 'project payload required', export_id });
    }

    if (!Array.isArray(layers) || layers.length === 0) {
        return res.status(400).json({ success: false, error: 'layers array required', export_id });
    }

    const validFormats = ['mp4', 'webm'];
    const outputFormat = validFormats.includes(format) ? format : 'mp4';

    try {
        // Queue export job via BullMQ — uses 'creative' domain (video-class work)
        await enqueue('creative', 'video-export', {
            export_id,
            project_id: project.id,
            project_name: project.name || 'Untitled',
            width: parseInt(project.width) || 1080,
            height: parseInt(project.height) || 1080,
            duration: parseFloat(project.duration) || 30,
            format: outputFormat,
            layers,
            timeline: timeline || [],
            queued_at: new Date().toISOString(),
        }, {
            jobId: export_id,
            priority: 1, // user-triggered
        });

        logger.info(`[VideoExport] Queued export ${export_id} for project ${project.id} (${outputFormat})`);

        res.json({
            success: true,
            export_id,
            status: 'queued',
            format: outputFormat,
            message: 'Video export job queued. Poll for status.',
        });
    } catch (err) {
        logger.error(`[VideoExport] Queue failed: ${err.message}`);
        res.status(500).json({
            success: false,
            export_id,
            error: 'Failed to queue video export: ' + err.message,
        });
    }
});

// Video export status check
app.get('/internal/edit/export-status/:id', requireSecret, async (req, res) => {
    const { id } = req.params;
    try {
        const status = await streamRedis.get(`video-export:${id}:status`);
        const result = await streamRedis.get(`video-export:${id}:result`);
        if (!status) {
            return res.json({ success: true, export_id: id, status: 'unknown', message: 'Export not found or expired.' });
        }
        const data = { success: true, export_id: id, status };
        if (result) {
            try { Object.assign(data, JSON.parse(result)); } catch(e) {}
        }
        res.json(data);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/internal/scanner', requireSecret, scannerRateLimit, async (req, res) => {
    const { url, workspace_id = 1 } = req.body || {};
    const task_id = uuidv4();
    const t0      = Date.now();

    // Patch 6: validate URL before any network call
    if (!url || typeof url !== 'string') {
        return res.status(400).json({ success: false, task_id, status: 'error', error: 'url required', result: null });
    }

    const ssrfErr = _checkSsrf(url);
    if (ssrfErr) {
        return res.status(400).json({ success: false, task_id, status: 'error', error: ssrfErr, result: null });
    }

    console.log(`[SCANNER START] task_id=${task_id} url=${url}`);

    // Patch 6: AbortController timeout 10s
    const controller = new AbortController();
    const fetchTimer = setTimeout(() => controller.abort(), 10000);

    try {
        const fetchRes = await fetch(url, {
            signal:  controller.signal,
            headers: {
                'User-Agent': 'LevelUpBot/1.0 (marketing intelligence; +https://levelupgrowth.ai)',
                'Accept':     'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
            },
        });
        clearTimeout(fetchTimer);

        if (!fetchRes.ok) throw new Error(`HTTP ${fetchRes.status} from target URL`);

        let html = await fetchRes.text();
        // Patch 7: 1MB cap — prevents DOM explosion on large pages
        if (html.length > 1_048_576) html = html.slice(0, 1_048_576);

        // Lazy-load cheerio per request (not at startup)
        const { load: cheerioLoad } = require('cheerio');
        const $ = cheerioLoad(html);

        // ── Extract OG data ───────────────────────────────────────────────
        const og_data = {
            title:       $('meta[property="og:title"]').attr('content')       || '',
            description: $('meta[property="og:description"]').attr('content') || '',
            image:       $('meta[property="og:image"]').attr('content')       || '',
            site_name:   $('meta[property="og:site_name"]').attr('content')   || '',
            url:         $('meta[property="og:url"]').attr('content')         || url,
        };
        const pageTitle   = $('title').first().text().trim();
        const metaDesc    = $('meta[name="description"]').attr('content') || '';
        const themeColor  = $('meta[name="theme-color"]').attr('content')  || '';

        // ── Extract colors (theme-color + inline style sampling) ──────────
        const colorSet = new Set();
        if (themeColor) colorSet.add(themeColor);
        $('[style]').each((i, el) => {
            if (colorSet.size >= 12) return false;
            const style = $(el).attr('style') || '';
            const hits  = style.match(/#[0-9a-fA-F]{3,6}|rgb\([^)]+\)/g);
            if (hits) hits.slice(0, 3).forEach(c => colorSet.add(c));
        });
        const colors = [...colorSet].slice(0, 10);

        // ── Extract fonts (Google Fonts links + font-family inline) ───────
        const fontSet = new Set();
        $('link[href*="fonts.googleapis.com"]').each((i, el) => {
            const href  = $(el).attr('href') || '';
            const match = href.match(/family=([^&:]+)/);
            if (match) fontSet.add(decodeURIComponent(match[1]).replace(/\+/g, ' '));
        });
        $('[style*="font-family"]').each((i, el) => {
            if (fontSet.size >= 6) return false;
            const style = $(el).attr('style') || '';
            const match = style.match(/font-family:\s*([^;,"']+)/);
            if (match) fontSet.add(match[1].trim());
        });
        const fonts = [...fontSet].slice(0, 5);

        // ── Extract prominent images ──────────────────────────────────────
        const images = [];
        if (og_data.image) images.push({ url: og_data.image, alt: og_data.title });
        $('img[src]').each((i, el) => {
            if (images.length >= 5) return false;
            const src = $(el).attr('src') || '';
            const alt = $(el).attr('alt') || '';
            if (!src || src.startsWith('data:')) return;
            try {
                const abs = src.startsWith('http') ? src : new URL(src, url).href;
                if (!images.some(im => im.url === abs)) images.push({ url: abs, alt });
            } catch {}
        });

        // ── Extract headings ──────────────────────────────────────────────
        const headings = [];
        $('h1,h2,h3').each((i, el) => {
            if (headings.length >= 15) return false;
            const text = $(el).text().trim().replace(/\s+/g, ' ');
            if (text.length > 4 && text.length < 250) headings.push({ level: el.tagName, text });
        });

        // ── Extract CTAs ──────────────────────────────────────────────────
        const CTA_PATTERNS = ['buy','get','start','book','contact','sign up','sign-up','join','try',
            'claim','request','download','subscribe','learn more','discover','explore','order','shop',
            'schedule','apply','register','free trial','quote','demo','consult','call us','chat','hire'];
        const ctaSet = new Set();
        $('button, [role="button"], a').each((i, el) => {
            if (ctaSet.size >= 15) return false;
            const text  = $(el).text().trim().replace(/\s+/g, ' ');
            const lower = text.toLowerCase();
            if (text.length > 2 && text.length < 80 && CTA_PATTERNS.some(p => lower.includes(p))) {
                ctaSet.add(text);
            }
        });
        const ctas = [...ctaSet];

        // ── Build blueprint (Patch 2: brand intelligence from scan) ───────
        const blueprint = {
            primary_color: colors[0]               || null,
            fonts,
            hero_image:    og_data.image           || (images[1]?.url || null),
            brand_name:    og_data.site_name       || pageTitle   || null,
            description:   og_data.description     || metaDesc    || null,
        };

        const duration_ms = Date.now() - t0;
        console.log(`[SCANNER DONE] task_id=${task_id} url=${url} colors=${colors.length} fonts=${fonts.length} headings=${headings.length} dur=${duration_ms}ms`);

        // Patch 4: standard envelope
        return res.json({
            success:     true,
            task_id,
            status:      'done',
            url,
            colors,
            fonts,
            images:      images.slice(0, 5),
            og_data,
            headings,
            ctas,
            blueprint,
            result:      { colors, fonts, images: images.slice(0, 5), og_data, headings, ctas, blueprint },
            error:       null,
            duration_ms,
        });

    } catch (err) {
        clearTimeout(fetchTimer);
        const duration_ms = Date.now() - t0;
        const isTimeout   = err.name === 'AbortError' || err.message.includes('abort');
        const error_msg   = isTimeout ? 'Scanner timeout — target took >10s to respond' : err.message;
        const httpStatus  = isTimeout ? 504 : 502;
        console.error(`[SCANNER ERROR] task_id=${task_id} url=${url}:`, error_msg);
        // Patch 5: structured error log
        return res.status(httpStatus).json({
            success: false, task_id, status: 'error', error: error_msg, result: null, duration_ms,
        });
    }
});

// Responds 202 immediately. Streams DeepSeek → pushes typed chunks to WP callback.
// type: "chunk" | "final" | "error". Strict sequential index. Abort-aware.
// ══════════════════════════════════════════════════════════════════════════════

app.post('/internal/write/stream', requireSecret, async (req, res) => {
    const { jti, intent, title, tone, length, content_type,
            seo_brief,
            callback_url, callback_secret } = req.body || {};

    if (!jti || !callback_url) {
        return res.status(400).json({ success: false, error: 'jti and callback_url required' });
    }
    if (!title) {
        return res.status(400).json({ success: false, error: 'title required' });
    }

    // Respond immediately — WordPress stream-start does not block
    res.json({ success: true, jti, status: 'streaming' });

    setImmediate(async () => {
        const axios = require('axios');

        // Strict sequential counter — never parallel, never out of order
        let chunkIndex = 0;
        let totalTokens = 0;
        let aborted = false;

        // Typed chunk push — sequential await enforces ordering
        const pushChunk = async (text, type, extra) => {
            if (aborted && type === 'chunk') return;
            const payload = { jti, index: chunkIndex++, text, type, ...(extra || {}) };
            try {
                await axios.post(callback_url, payload, {
                    timeout: 8000,
                    headers: { 'Content-Type': 'application/json', 'X-LU-Secret': callback_secret },
                });
            } catch (err) {
                console.error(`[write/stream] chunk push failed (${jti}):`, err.message);
            }
        };

        // Lightweight abort check — polls WP every 10 chunks to avoid overhead
        const checkAborted = async () => {
            if (chunkIndex % 10 !== 0) return false;
            try {
                const wpBase = callback_url.replace(/\/(wp-json\/lu\/v1|api\/internal)\/write\/stream-chunk.*$/, '');
                const r = await axios.get(
                    `${wpBase}/api/internal/write/stream-poll?jti=${encodeURIComponent(jti)}&offset=0`,
                    { timeout: 3000, headers: { 'X-LU-Secret': callback_secret } }
                );
                if (r.data && r.data.status === 'aborted') {
                    aborted = true;
                    console.log(`[write/stream] jti=${jti} aborted by user`);
                    return true;
                }
            } catch (e) { /* non-fatal — continue streaming */ }
            return false;
        };

        try {
            const apiKey = process.env.DEEPSEEK_API_KEY;
            if (!apiKey) throw new Error('DEEPSEEK_API_KEY not set');

            const lgMap = {
                short:  { words: '250-350', tokens: 700 },
                medium: { words: '400-550', tokens: 1000 },
                long:   { words: '700-900', tokens: 1600 },
            };
            const lg = lgMap[length] || lgMap.medium;

            // ── Type-intelligent + SEO-enriched prompt via buildWritePrompt() ──────
            const prompts      = buildWritePrompt({ content_type, title, tone, length, intent, seo_brief });
            const systemPrompt = prompts.system;
            const userPrompt   = prompts.user;
            // Per-type token budget (overrides lgMap)
            const resolvedTokens = prompts.max_tokens;

            console.log(`[STREAM START] jti=${jti} type=${content_type} tokens=${resolvedTokens}`);

            // ── Native fetch + ReadableStream — fully sequential, no fire-and-forget ──
            // Root cause of previous non-streaming: axios .on('data') callbacks fired
            // async flushBuffer() without await, causing parallel races and ordering
            // failures. fetch + getReader() gives a proper awaitable sequential loop.
            const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions';

            const dsResponse = await fetch(DEEPSEEK_URL, {
                method:  'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type':  'application/json',
                },
                body: JSON.stringify({
                    model:       dsModels.DEFAULT_MODEL,
                    messages:    [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
                    max_tokens:  dsModels.withReasoningHeadroom(resolvedTokens),
                    temperature: 0.72,
                    stream:      true,
                }),
                signal: AbortSignal.timeout(120000),
            });

            if (!dsResponse.ok) {
                const errText = await dsResponse.text();
                throw new Error(`DeepSeek HTTP ${dsResponse.status}: ${errText.slice(0, 200)}`);
            }

            const reader  = dsResponse.body.getReader();
            const decoder = new TextDecoder('utf-8');

            let wordBuffer = '';
            let lineBuffer = '';   // handles SSE lines split across network packets
            const FLUSH_AT_WORDS = 6;

            // Flush wordBuffer as one chunk — always awaited, always sequential
            const flushWords = async () => {
                if (!wordBuffer.trim() || aborted) { wordBuffer = ''; return; }
                await pushChunk(wordBuffer, 'chunk');
                console.log(`[CHUNK] ${chunkIndex - 1} words=${wordBuffer.trim().split(/\s+/).length}`);
                wordBuffer = '';
            };

            // ── Sequential read loop — every await here is guaranteed ordered ──────
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (aborted) break;

                // Decode incoming bytes, accumulate into lineBuffer to handle
                // SSE lines that span multiple network packets
                lineBuffer += decoder.decode(value, { stream: true });
                const lines = lineBuffer.split('\n');

                // Keep last (potentially incomplete) line in buffer
                lineBuffer = lines.pop() || '';

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || !trimmed.startsWith('data:')) continue;

                    const jsonStr = trimmed.slice(5).trim();
                    if (jsonStr === '[DONE]') continue;

                    try {
                        const parsed = JSON.parse(jsonStr);
                        const token  = parsed.choices?.[0]?.delta?.content || '';
                        if (parsed.usage) totalTokens = parsed.usage.total_tokens || 0;
                        if (!token) continue;

                        wordBuffer += token;

                        const wordCount = wordBuffer.split(/\s+/).filter(w => w.length > 0).length;
                        if (wordCount >= FLUSH_AT_WORDS || /[.!?\n]{1,2}\s*$/.test(wordBuffer)) {
                            await flushWords();
                            // Abort check every flush — avoids checking every token
                            await checkAborted();
                        }
                    } catch (e) { /* skip malformed SSE lines */ }
                }
            }

            // Flush any remaining partial buffer after loop
            if (!aborted && wordBuffer.trim()) {
                await flushWords();
            }

            if (!aborted) {
                // Mandatory typed final signal — triggers status=done in WordPress
                await pushChunk('', 'final');
                console.log(`[STREAM DONE] jti=${jti} chunks=${chunkIndex} tokens=${totalTokens}`);
            } else {
                console.log(`[STREAM ABORTED] jti=${jti} at chunk ${chunkIndex}`);
            }

        } catch (err) {
            console.error(`[write/stream] failed jti=${jti}:`, err.message);
            // S2 MANDATORY: typed error signal with message
            await pushChunk('', 'error', { message: err.message || 'stream_failed' });
        }
    });
});


// ══════════════════════════════════════════════════════════════════════════════
// WRITE STRUCTURE ENDPOINT — S3/S4
// POST /internal/write/structure
// Takes accumulated plain-text streaming output and converts it to the
// canonical block JSON schema. Called AFTER streaming completes — never during.
// Returns ONLY JSON, never plain text. Validates output strictly.
// Streaming is untouched — this runs post-generation as a separate step.
// ══════════════════════════════════════════════════════════════════════════════

// S3: Strict JSON block validator — rejects any non-conforming output
function validateStructuredOutput(output) {
    const ALLOWED_TYPES = new Set(['h1', 'h2', 'h3', 'p', 'ul', 'ol', 'faq', 'cta']);
    try {
        // Strip markdown code fences if AI wrapped output
        const cleaned = output.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
        const parsed  = JSON.parse(cleaned);
        if (!Array.isArray(parsed) || parsed.length === 0) return null;
        for (const block of parsed) {
            if (!block || typeof block.type !== 'string') return null;
            if (!ALLOWED_TYPES.has(block.type)) return null;
            // Type-specific field validation
            if (['h1','h2','h3','p','cta'].includes(block.type) && typeof block.text !== 'string') return null;
            if (['ul','ol'].includes(block.type) && !Array.isArray(block.items)) return null;
            if (block.type === 'faq' && (typeof block.question !== 'string' || typeof block.answer !== 'string')) return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

// S4: Convert plain text → structured blocks as fallback (no AI needed)
function plainTextToBlocks(text, title) {
    if (!text || !text.trim()) {
        return [{ type: 'h1', text: title || 'Untitled' }, { type: 'p', text: 'Content unavailable.' }];
    }
    const paras = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
    const blocks = [];
    let h1set = false;
    for (const para of paras) {
        const isShort = para.length <= 120 && !para.includes('\n');
        const looksLikeHeading = isShort && !/[.!]$/.test(para) && !/^(Q:|A:)/.test(para);
        if (!h1set && looksLikeHeading) {
            blocks.push({ type: 'h1', text: para }); h1set = true;
        } else if (looksLikeHeading && blocks.length > 0 && blocks[blocks.length-1].type !== 'h1') {
            blocks.push({ type: 'h2', text: para });
        } else if (/^(Q:|Question:)/i.test(para)) {
            const qMatch = para.match(/^(?:Q:|Question:)\s*(.+)/i);
            blocks.push({ type: 'faq', question: qMatch ? qMatch[1] : para, answer: '' });
        } else if (/^\s*[-*•·▪]|^\d+\.\s/.test(para)) {
            const items = para.split('\n').map(l => l.replace(/^\s*[-*•·▪\d.]+\s*/, '').trim()).filter(Boolean);
            blocks.push({ type: 'ul', items });
        } else {
            blocks.push({ type: 'p', text: para });
        }
    }
    if (!h1set) blocks.unshift({ type: 'h1', text: title || 'Generated Content' });
    return blocks;
}

// POST /internal/write/structure — convert plain text to canonical JSON blocks
app.post('/internal/write/structure', requireSecret, async (req, res) => {
    const { plain_text = '', title = '', content_type = 'blog_article', seo_brief } = req.body || {};

    if (!plain_text.trim()) {
        return res.status(400).json({ success: false, error: 'plain_text required' });
    }

    const primary = seo_brief && seo_brief.primary_keyword ? seo_brief.primary_keyword : '';

    const systemPrompt = `You are a content structuring engine. Your ONLY job is to convert plain text into a JSON block array.

RETURN ONLY A VALID JSON ARRAY — no markdown, no explanation, no wrapper text.

SCHEMA — each element must match one of these EXACTLY:
{ "type": "h1", "text": "..." }
{ "type": "h2", "text": "..." }
{ "type": "h3", "text": "..." }
{ "type": "p",  "text": "..." }
{ "type": "ul", "items": ["...", "..."] }
{ "type": "ol", "items": ["...", "..."] }
{ "type": "faq", "question": "...", "answer": "..." }

RULES:
- First block MUST be h1
- Section titles → h2
- Sub-section titles → h3
- Regular paragraphs → p
- Bullet lists → ul with items array
- Numbered lists → ol with items array
- FAQ questions and answers → faq blocks (one per Q&A pair)
- Do NOT merge blocks
- Do NOT add blocks not in the source text
- Do NOT output anything except the JSON array`;

    const userPrompt = `Convert this content to structured JSON blocks.
${primary ? `Primary keyword: "${primary}" (ensure it appears in the h1)` : ''}
Title hint: "${title}"

CONTENT:
${plain_text.slice(0, 8000)}

Return ONLY the JSON array. Start with [ and end with ].`;

    try {
        const result = await callLLM({
            messages:   [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
            max_tokens: 3000,
            temperature: 0.1,  // very low — deterministic structuring task
        });

        const raw     = result.content ? result.content.trim() : '';
        const blocks  = validateStructuredOutput(raw);

        if (blocks) {
            console.log('[write/structure] OK —', blocks.length, 'blocks,', content_type);
            return res.json({ success: true, blocks, source: 'ai_structured' });
        }

        // S4: AI validation failed — use deterministic fallback
        console.warn('[write/structure] AI output invalid — using fallback structuring');
        const fallbackBlocks = plainTextToBlocks(plain_text, title);
        return res.json({ success: true, blocks: fallbackBlocks, source: 'fallback_structured' });

    } catch (err) {
        console.error('[write/structure]', err.message);
        // S4: Never fail — always return fallback blocks
        const fallbackBlocks = plainTextToBlocks(plain_text, title);
        return res.json({ success: true, blocks: fallbackBlocks, source: 'error_fallback' });
    }
});


// Wave 82 — mount SEO intelligence routes (6 endpoints under /internal/seo/*).
seoIntelligence.mountRoutes(app, requireSecret);
// Wave 88 — mount governance intelligence
govIntelligence.mountRoutes(app, requireSecret);
// Wave 89 — mount strategic intelligence
strategicIntelligence.mountRoutes(app, requireSecret);
// Wave 90 — mount orchestrator intelligence
orchestratorIntelligence.mountRoutes(app, requireSecret);
// Wave 91 — mount proactive intelligence
proactiveIntelligence.mountRoutes(app, requireSecret);

// ── 404 ────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error:'Not found', path:req.path }));

// ── Start ──────────────────────────────────────────────────────────────────
// ── PATCH 8: Metrics endpoint ─────────────────────────────────────────
app.get('/internal/metrics', requireSecret, async (req, res) => {
    try { res.json(await buildMetricsSnapshot()); }
    catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH 1+2: Domain queue enqueue endpoint ──────────────────────────
app.post('/internal/queue/enqueue', requireSecret, internalRateLimit, async (req, res) => {
    const { domain, type, payload, user_id = 0, priority = 5 } = req.body || {};
    if (!domain || !type || !payload) {
        return res.status(400).json({ error: 'domain, type, and payload required' });
    }
    try {
        const job = await enqueue(domain, type, payload, { user_id, priority });
        inc('jobs_enqueued');
        res.json({ success: true, job_id: job.id, domain, type });
    } catch(e) { res.status(400).json({ success: false, error: e.message }); }
});

app.get('/internal/queue/counts', requireSecret, async (req, res) => {
    try { res.json({ success: true, queues: await getAllQueueCounts() }); }
    catch(e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] ✓ LevelUp Runtime v${RUNTIME_BUILD_VERSION} on :${PORT}`);
    // PATCH 1+2: Start domain workers
    try { startWorkers(); console.log('[STARTUP] Domain workers started'); }
    catch(e) { console.error('[STARTUP] Worker startup error (non-fatal):', e.message); }
    // PATCH 8: Start queue monitor
    startQueueMonitor(60_000);
    console.log('[STARTUP] Queue monitor active');
    // PHASE 6: Start governance monitor
    governor.start(30_000);
    console.log('[STARTUP] Governor active');
    console.log('[SERVER] Routes registered — Assistant ready');
    // Phase 2+6: Background worker starts AFTER server is live (never blocks boot)
    try {
        const worker = require('./tool-discovery-worker');
        worker.start();
        console.log('[SERVER] Background discovery scheduled');
    } catch (e) {
        // Worker failure never prevents the server from running
        console.warn('[SERVER] Background worker failed to start (non-fatal):', e.message);
    }
    // lu-bootstrap: starts lu-task-worker (Phase 7) + crash recovery
    require('./lu-bootstrap');
});

module.exports = app;
