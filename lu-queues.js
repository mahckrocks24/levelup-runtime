'use strict';

/**
 * LevelUp — Domain Queue Registry (v2.25.0)
 *
 * PATCH 1: Multi-queue architecture replacing single lu-tasks queue.
 * Each domain gets its own BullMQ queue with domain-appropriate settings.
 *
 * WHY DOMAIN QUEUES:
 *   Single queue = head-of-line blocking. A 120s video generation blocks
 *   behind it a 2s scanner job. Domain queues isolate work by cost profile.
 *
 * QUEUES:
 *   lu-agent      — existing agent task execution (tools, reasoning)
 *   lu-write      — AI draft generation, improve, rewrite
 *   lu-creative   — image + video generation (expensive, slow)
 *   lu-scanner    — URL scanning (fast I/O, high volume)
 *   lu-social     — social post publishing, scheduling
 *   lu-marketing  — campaign sending, sequence steps
 *
 * WORKER CONCURRENCY (per process instance):
 *   agent:     3  — reasoning-heavy, blocked by LLM roundtrips
 *   write:     5  — I/O bound (DeepSeek streaming), parallelises well
 *   creative:  2  — GPU-expensive per job, don't overload providers
 *   scanner:  10  — fast network I/O, high fan-out safe
 *   social:    5  — external API calls, I/O bound
 *   marketing: 3  — email delivery, rate-limited by provider (Postmark)
 */

const { Queue, QueueEvents } = require('bullmq');

// ── Redis connection (shared config from environment) ─────────────────
const connection = {
    url:                  process.env.REDIS_URL,
    maxRetriesPerRequest: null,       // BullMQ requirement — never change
    enableReadyCheck:     false,
    tls: process.env.REDIS_URL?.startsWith('rediss://')
        ? { rejectUnauthorized: false } : undefined,
};

// ── Key prefix — all LevelUp keys under lu: namespace ────────────────
const PREFIX = 'lu';

// ── Priority constants (BullMQ: lower number = higher priority) ──────
const PRIORITY = {
    P1_USER:        1,  // user-triggered, blocking
    P2_APPROVED:    3,  // approved agent task
    P3_BACKGROUND:  6,  // autonomous/automation, background
    P4_MAINTENANCE: 9,  // scans, analytics refresh
};

// ── Domain queue definitions ──────────────────────────────────────────
const QUEUE_DEFS = {
    agent_user: {
        name:        'lu-agent-user',
        concurrency: parseInt(process.env.AGENT_USER_CONCURRENCY || '4', 10),
        attempts:    4,
        backoff:     { type: 'exponential', delay: 8_000 },
        timeout:     300_000,
        lockDuration: 45_000,
        removeOnComplete: { count: 500,  age: 7  * 86_400 },
        removeOnFail:     { count: 200,  age: 30 * 86_400 },
    },
    agent_auto: {
        name:        'lu-agent-auto',
        concurrency: parseInt(process.env.AGENT_AUTO_CONCURRENCY || '3', 10),
        attempts:    3,
        backoff:     { type: 'exponential', delay: 16_000 },
        timeout:     300_000,
        lockDuration: 45_000,
        removeOnComplete: { count: 1000, age: 7  * 86_400 },
        removeOnFail:     { count: 500,  age: 30 * 86_400 },
    },
    write: {
        name:        'lu-write',
        concurrency: parseInt(process.env.WRITE_CONCURRENCY    || '5', 10),
        attempts:    3,
        backoff:     { type: 'exponential', delay: 5_000 },
        timeout:     120_000,   // 2 min — DeepSeek stream max
        lockDuration: 30_000,
        removeOnComplete: { count: 1000, age: 3  * 86_400 },
        removeOnFail:     { count: 100,  age: 7  * 86_400 },
    },
    creative: {
        name:        'lu-creative',
        concurrency: parseInt(process.env.CREATIVE_CONCURRENCY || '2', 10),
        attempts:    2,
        backoff:     { type: 'exponential', delay: 15_000 },
        timeout:     300_000,   // 5 min — video generation
        lockDuration: 60_000,
        removeOnComplete: { count: 200,  age: 7  * 86_400 },
        removeOnFail:     { count: 100,  age: 30 * 86_400 },
    },
    scanner: {
        name:        'lu-scanner',
        concurrency: parseInt(process.env.SCANNER_CONCURRENCY  || '10', 10),
        attempts:    2,
        backoff:     { type: 'fixed', delay: 3_000 },
        timeout:     15_000,    // 15s — scanner has 10s fetch + overhead
        lockDuration: 20_000,
        removeOnComplete: { count: 2000, age: 1  * 86_400 },
        removeOnFail:     { count: 200,  age: 3  * 86_400 },
    },
    social: {
        name:        'lu-social',
        concurrency: parseInt(process.env.SOCIAL_CONCURRENCY   || '5', 10),
        attempts:    3,
        backoff:     { type: 'exponential', delay: 5_000 },
        timeout:     30_000,    // 30s — social API calls
        lockDuration: 35_000,
        removeOnComplete: { count: 1000, age: 3  * 86_400 },
        removeOnFail:     { count: 100,  age: 7  * 86_400 },
    },
    marketing: {
        name:        'lu-marketing',
        concurrency: parseInt(process.env.MARKETING_CONCURRENCY || '3', 10),
        attempts:    3,
        backoff:     { type: 'exponential', delay: 10_000 },
        timeout:     60_000,    // 60s — email delivery + Postmark API
        lockDuration: 70_000,
        removeOnComplete: { count: 500,  age: 7  * 86_400 },
        removeOnFail:     { count: 100,  age: 30 * 86_400 },
    },
};

// ── Queue instances ───────────────────────────────────────────────────
const queues   = {};
const events   = {};

for (const [domain, def] of Object.entries(QUEUE_DEFS)) {
    queues[domain] = new Queue(def.name, {
        connection,
        prefix: PREFIX,
        defaultJobOptions: {
            attempts:         def.attempts,
            backoff:          def.backoff,
            removeOnComplete: def.removeOnComplete,
            removeOnFail:     def.removeOnFail,
        },
    });

    events[domain] = new QueueEvents(def.name, { connection, prefix: PREFIX });
}

// ── DLQ — failed jobs that exhausted all retries ──────────────────────
const deadQueue = new Queue('lu-dead', {
    connection,
    prefix: PREFIX,
    defaultJobOptions: { removeOnFail: false },
});

// ── Standard job structure (Patch 1 contract) ─────────────────────────
/**
 * Build a normalized job payload.
 * Every job stored in Redis follows this structure.
 *
 * @param {string} type        — e.g. 'write.draft', 'scanner.url', 'creative.image'
 * @param {object} payload     — domain-specific input
 * @param {number} [user_id]   — WordPress user ID
 * @param {number} [priority]  — 1=highest, 10=lowest (BullMQ convention: lower = higher priority)
 */
function buildJob(type, payload, { user_id = 0, priority = 5 } = {}) {
    return {
        id:           payload.task_id || payload.job_id || require('uuid').v4(),
        type,
        payload,
        user_id,
        priority,
        retries:      0,
        status:       'pending',
        created_at:   new Date().toISOString(),
        started_at:   null,
        completed_at: null,
    };
}

// ── Enqueue helpers per domain ────────────────────────────────────────

/**
 * Add a job to a domain queue.
 * @param {string} domain  — one of 'agent','write','creative','scanner','social','marketing'
 * @param {string} type    — job type label
 * @param {object} payload — job data
 * @param {object} [opts]  — { user_id, priority, jobId }
 */
async function enqueue(domain, type, payload, opts = {}) {
    const q = queues[domain];
    if (!q) throw new Error(`Unknown queue domain: ${domain}`);
    const def = QUEUE_DEFS[domain];
    const job = await q.add(type, buildJob(type, payload, opts), {
        jobId:    opts.jobId || payload.task_id || undefined,  // idempotent if ID provided
        priority: opts.priority || 5,
        timeout:  def.timeout,
    });
    console.log(`[queues] enqueued domain=${domain} type=${type} job=${job.id}`);
    return job;
}

// ── Bulk counts for monitoring ────────────────────────────────────────
async function getAllQueueCounts() {
    const out = {};
    await Promise.all(Object.entries(queues).map(async ([domain, q]) => {
        const [waiting, active, completed, failed, delayed] = await Promise.all([
            q.getWaitingCount(),
            q.getActiveCount(),
            q.getCompletedCount(),
            q.getFailedCount(),
            q.getDelayedCount(),
        ]);
        out[domain] = { waiting, active, completed, failed, delayed };
    }));
    return out;
}

// ── Graceful shutdown ─────────────────────────────────────────────────
async function closeAll() {
    await Promise.all([
        ...Object.values(queues).map(q => q.close()),
        ...Object.values(events).map(e => e.close()),
        deadQueue.close(),
    ]);
}

module.exports = {
    queues,
    events,
    deadQueue,
    QUEUE_DEFS,
    PREFIX,
    connection,
    buildJob,
    enqueue,
    getAllQueueCounts,
    closeAll,
};
