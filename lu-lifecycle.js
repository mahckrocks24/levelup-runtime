/**
 * LevelUp — Task Lifecycle State Machine
 *
 * All state transitions are atomic Redis operations.
 * State is the canonical source of truth for the SPA poll endpoint.
 *
 * Valid states (strict — no others allowed):
 *   pending   → task created in WP, not yet queued
 *   queued    → job added to BullMQ, waiting for worker
 *   running   → worker has locked the job
 *   retrying  → previous attempt failed, BullMQ will retry
 *   complete  → all tools ran successfully, output persisted to WP
 *   partial   → some tools failed, output persisted with errors
 *   failed    → exhausted all retry attempts, in DLQ
 *   cancelled → cancelled before worker picked it up
 *
 * Transitions:
 *   pending   → queued    (dispatch endpoint)
 *   queued    → running   (worker on job start)
 *   queued    → cancelled (cancel endpoint)
 *   running   → complete  (worker success callback)
 *   running   → partial   (worker partial success)
 *   running   → retrying  (worker error, attempts remain)
 *   retrying  → running   (BullMQ retry picks up job)
 *   retrying  → failed    (attempts exhausted)
 *   running   → failed    (attempts exhausted, no retries left)
 *   failed    → queued    (manual retry via /queue/retry — re-enqueues fresh)
 *   failed    → retrying  (manual retry path when job still exists in BullMQ)
 */

'use strict';

const Redis = require('ioredis');

// ── Redis client (standalone — not BullMQ's connection) ──────────────
const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: false,
  tls: process.env.REDIS_URL?.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined,
});

redis.on('error', (e) => console.error('[lifecycle] Redis error:', e.message));

// ── Key helpers ──────────────────────────────────────────────────────
const STATE_KEY   = (id) => `lu:task:${id}:state`;
const META_KEY    = (id) => `lu:task:${id}:meta`;
const LOG_KEY     = (id) => `lu:task:${id}:log`;
const TOOL_KEY    = (id) => `lu:task:${id}:tools`;

const STATE_TTL   = 90 * 24 * 60 * 60;        // 90 days
const LOG_MAX     = 50;

// ── Valid state machine transitions ──────────────────────────────────
const TRANSITIONS = {
  pending:   ['queued'],
  queued:    ['running', 'cancelled'],
  running:   ['complete', 'partial', 'retrying', 'failed'],
  retrying:  ['running', 'failed'],
  complete:  [],
  partial:   [],
  // failed → queued:    manual retry when BullMQ job has expired (re-enqueue path)
  // failed → retrying:  manual retry when BullMQ job still exists (job.retry() path)
  failed:    ['queued', 'retrying'],
  cancelled: [],
};

const TERMINAL = new Set(['complete', 'partial', 'failed', 'cancelled']);

// ── State operations ─────────────────────────────────────────────────

async function getState(task_id) {
  const [state, meta, tools] = await Promise.all([
    redis.get(STATE_KEY(task_id)),
    redis.hgetall(META_KEY(task_id)),
    redis.lrange(TOOL_KEY(task_id), 0, -1),
  ]);
  if (!state) return null;
  return {
    task_id,
    state,
    agent_id:    meta.agent_id  || null,
    title:       meta.title     || null,
    goal_id:     meta.goal_id   || null,
    attempts:    parseInt(meta.attempts || '0', 10),
    queued_at:   meta.queued_at  ? parseInt(meta.queued_at,  10) : null,
    started_at:  meta.started_at ? parseInt(meta.started_at, 10) : null,
    finished_at: meta.finished_at? parseInt(meta.finished_at,10) : null,
    error:       meta.last_error || null,
    tool_events: tools.map(t => JSON.parse(t)),
  };
}

async function transition(task_id, to_state, extra_meta = {}) {
  const current = await redis.get(STATE_KEY(task_id));

  // Allow initial write if no state yet
  if (current !== null) {
    const allowed = TRANSITIONS[current] || [];
    if (!allowed.includes(to_state)) {
      throw new Error(`Invalid transition: ${current} → ${to_state} for task ${task_id}`);
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const meta = { state: to_state, updated_at: now, ...extra_meta };

  // Timestamp fields per transition
  if (to_state === 'queued')   meta.queued_at   = now;
  if (to_state === 'running')  meta.started_at  = now;
  if (TERMINAL.has(to_state))  meta.finished_at = now;

  const pipeline = redis.pipeline();
  pipeline.set(STATE_KEY(task_id), to_state, 'EX', STATE_TTL);
  pipeline.hset(META_KEY(task_id), meta);
  pipeline.expire(META_KEY(task_id), STATE_TTL);
  await pipeline.exec();

  await appendLog(task_id, { ts: now, event: `state:${to_state}`, ...extra_meta });
  return to_state;
}

async function appendLog(task_id, entry) {
  const pipeline = redis.pipeline();
  pipeline.rpush(LOG_KEY(task_id), JSON.stringify(entry));
  pipeline.ltrim(LOG_KEY(task_id), -LOG_MAX, -1);
  pipeline.expire(LOG_KEY(task_id), STATE_TTL);
  await pipeline.exec();
}

async function recordToolEvent(task_id, event) {
  // event: { tool_id, status, duration_ms, error? }
  const entry = JSON.stringify({ ts: Math.floor(Date.now() / 1000), ...event });
  await redis.pipeline()
    .rpush(TOOL_KEY(task_id), entry)
    .expire(TOOL_KEY(task_id), STATE_TTL)
    .exec();
}

async function incrementAttempts(task_id) {
  await redis.hincrby(META_KEY(task_id), 'attempts', 1);
}

async function setError(task_id, error_msg) {
  await redis.hset(META_KEY(task_id), 'last_error', String(error_msg).slice(0, 500));
}

async function getLog(task_id, limit = 50) {
  const entries = await redis.lrange(LOG_KEY(task_id), -limit, -1);
  return entries.map(e => JSON.parse(e));
}

async function isTerminal(task_id) {
  const state = await redis.get(STATE_KEY(task_id));
  return state ? TERMINAL.has(state) : false;
}

module.exports = {
  redis,
  getState,
  transition,
  appendLog,
  recordToolEvent,
  incrementAttempts,
  setError,
  getLog,
  isTerminal,
  TERMINAL,
  STATE_KEY,
  META_KEY,
};
