/**
 * LevelUp — Activity Event Bus (Phase 8)
 *
 * Central event emitter for all agent execution activity.
 * Every event is:
 *   1. Published to Redis pub/sub  → lu:events:ws:{ws_id}  (live SSE)
 *   2. Appended to task timeline   → lu:timeline:{task_id} (per-task history)
 *   3. Appended to workspace feed  → lu:activity:ws:{ws_id} (global feed)
 *
 * All three operations are fire-and-forget — a Redis failure never
 * propagates to the caller. This guarantees event emission is always
 * additive and never blocks or breaks task execution.
 *
 * Event types:
 *   task_created     task entered the queue
 *   task_started     worker picked up the job
 *   agent_reasoning  agent logged thoughts before execution
 *   tool_started     about to call a tool
 *   tool_completed   tool returned (ok or error)
 *   task_completed   all tools ran successfully
 *   task_partial     task done but some tools failed
 *   task_failed      exhausted all retries
 *   task_retrying    scheduling a retry
 *
 * Event schema:
 * {
 *   id:          string   unique event ID
 *   type:        string   event type (see above)
 *   ts:          number   unix ms timestamp
 *   ws_id:       number   workspace ID
 *   task_id:     string
 *   goal_id:     string|null
 *   agent_id:    string
 *   agent_name:  string   human name (James, Sarah…)
 *   agent_color: string   hex colour for UI
 *   tool_id:     string|null   only for tool events
 *   progress:    number|null   0–100
 *   message:     string   human-readable description
 *   data:        object   event-specific payload
 * }
 */

'use strict';

const Redis = require('ioredis');

// ── Separate publisher client (ioredis subscriber mode locks a connection) ──
const pub = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 2,
  enableReadyCheck:     false,
  lazyConnect:          true,
  tls: process.env.REDIS_URL?.startsWith('rediss://')
    ? { rejectUnauthorized: false } : undefined,
});
pub.on('error', e => console.warn('[event-bus] pub error:', e.message));

// ── Subscriber client (separate connection required by Redis pub/sub) ──
let _sub = null;
function getSubscriber() {
  if (!_sub) {
    _sub = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck:     false,
      lazyConnect:          true,
      tls: process.env.REDIS_URL?.startsWith('rediss://')
        ? { rejectUnauthorized: false } : undefined,
    });
    _sub.on('error', e => console.warn('[event-bus] sub error:', e.message));
  }
  return _sub;
}

// ── Key builders ─────────────────────────────────────────────────────
const CHANNEL    = (ws_id)     => `lu:events:ws:${ws_id}`;
const TIMELINE   = (task_id)   => `lu:timeline:${task_id}`;
const FEED       = (ws_id)     => `lu:activity:ws:${ws_id}`;

const TIMELINE_TTL  = 90 * 24 * 60 * 60;   // 90 days
const FEED_TTL      = 7  * 24 * 60 * 60;   // 7 days
const TIMELINE_MAX  = 200;
const FEED_MAX      = 500;
const WS_ID         = 1;

// ── Agent display map ─────────────────────────────────────────────────
const AGENT_DISPLAY = {
  sarah:  { name: 'Sarah',  color: '#6C5CE7' },
  james:  { name: 'James',  color: '#3B8BF5' },
  priya:  { name: 'Priya',  color: '#A78BFA' },
  elena:  { name: 'Elena',  color: '#F87171' },
  alex:   { name: 'Alex',   color: '#00E5A8' },
};

// ── Human-readable message builders ──────────────────────────────────
const MESSAGES = {
  task_created:    (e) => `${_name(e)} task queued: "${e.data.title || e.task_id}"`,
  task_started:    (e) => `${_name(e)} started "${e.data.title || e.task_id}"`,
  agent_reasoning: (e) => `${_name(e)} is thinking: ${(e.data.thoughts || '').slice(0, 100)}`,
  tool_started:    (e) => `${_name(e)} calling ${e.tool_id}…`,
  tool_completed:  (e) => e.data.status === 'ok'
                    ? `${_name(e)} ${e.tool_id} ✓ (${e.data.duration_ms}ms)`
                    : `${_name(e)} ${e.tool_id} ✗ ${(e.data.error || 'error').slice(0, 60)}`,
  task_completed:  (e) => `${_name(e)} completed "${e.data.title || e.task_id}" in ${e.data.duration_ms}ms`,
  task_partial:    (e) => `${_name(e)} finished "${e.data.title || e.task_id}" with partial results`,
  task_failed:     (e) => `${_name(e)} task failed after ${e.data.attempts || 1} attempt(s): ${(e.data.error || '').slice(0, 80)}`,
  task_retrying:   (e) => `${_name(e)} retrying (attempt ${e.data.attempt_number || '?'})`,
};

function _name(e) {
  return AGENT_DISPLAY[e.agent_id]?.name || e.agent_id || 'Agent';
}

// ─────────────────────────────────────────────────────────────────────
// EMIT — the only public write API
// ─────────────────────────────────────────────────────────────────────

/**
 * Emit an activity event.
 *
 * Fire-and-forget — always resolves, never throws.
 *
 * @param {object} event
 * @param {string} event.type       — event type
 * @param {string} event.task_id
 * @param {string} [event.goal_id]
 * @param {string} event.agent_id
 * @param {string} [event.tool_id]
 * @param {number} [event.progress] — 0–100
 * @param {object} [event.data]     — extra payload
 * @param {number} [event.ws_id]    — workspace ID, defaults to 1
 * @returns {Promise<void>}         — always resolves
 */
async function emit(event) {
  try {
    const ws_id = event.ws_id || WS_ID;
    const agent = AGENT_DISPLAY[event.agent_id] || { name: event.agent_id || '?', color: '#8892a4' };

    const full = {
      id:          `evt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      type:        event.type,
      ts:          Date.now(),
      ws_id,
      task_id:     event.task_id    || '',
      goal_id:     event.goal_id    || null,
      agent_id:    event.agent_id   || '',
      agent_name:  agent.name,
      agent_color: agent.color,
      tool_id:     event.tool_id    || null,
      progress:    event.progress   ?? null,
      data:        event.data       || {},
      message:     '',
    };

    // Build human-readable message
    const builder = MESSAGES[full.type];
    full.message = builder ? builder(full) : `${full.agent_name}: ${full.type}`;

    const serialized = JSON.stringify(full);

    // All three writes in parallel — any failure is silently swallowed
    await Promise.allSettled([
      // 1. Pub/sub for live SSE
      pub.publish(CHANNEL(ws_id), serialized),

      // 2. Task timeline (per-task ordered log)
      full.task_id
        ? pub.pipeline()
            .rpush(TIMELINE(full.task_id), serialized)
            .ltrim(TIMELINE(full.task_id), -TIMELINE_MAX, -1)
            .expire(TIMELINE(full.task_id), TIMELINE_TTL)
            .exec()
        : Promise.resolve(),

      // 3. Workspace feed (global recent events)
      pub.pipeline()
        .rpush(FEED(ws_id), serialized)
        .ltrim(FEED(ws_id), -FEED_MAX, -1)
        .expire(FEED(ws_id), FEED_TTL)
        .exec(),
    ]);
  } catch (_) {
    // Never propagate — event emission must never break task execution
  }
  // TASK 5.2: evaluate automation triggers asynchronously after every emit
  evaluateAutomationTriggers(event).catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────
// READ — timeline and feed retrieval
// ─────────────────────────────────────────────────────────────────────

/**
 * Get the activity timeline for a single task.
 * Returns events in chronological order.
 */
async function getTimeline(task_id, limit = 100) {
  try {
    // Use the pub client for reads (it's not in subscribe mode)
    const raw = await pub.lrange(TIMELINE(task_id), -Math.min(limit, TIMELINE_MAX), -1);
    return raw.map(r => JSON.parse(r));
  } catch (_) {
    return [];
  }
}

/**
 * Get recent workspace-wide activity feed.
 * Supports filtering by agent_id and/or task_id.
 *
 * @param {object} opts
 * @param {number}   [opts.limit=50]
 * @param {string}   [opts.agent_id]  — filter by agent
 * @param {string}   [opts.task_id]   — filter by task
 * @param {number}   [opts.since_ts]  — unix ms, only events after this
 * @param {number}   [opts.ws_id=1]
 */
async function getFeed({ limit = 50, agent_id, task_id, since_ts, ws_id = WS_ID } = {}) {
  try {
    const raw = await pub.lrange(FEED(ws_id), -Math.min(limit * 3, FEED_MAX), -1);
    let events = raw.map(r => JSON.parse(r));

    if (agent_id) events = events.filter(e => e.agent_id === agent_id);
    if (task_id)  events = events.filter(e => e.task_id  === task_id);
    if (since_ts) events = events.filter(e => e.ts > since_ts);

    return events.slice(-limit).reverse(); // newest first
  } catch (_) {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────
// SUBSCRIBE — for SSE stream handler
// ─────────────────────────────────────────────────────────────────────

/**
 * Subscribe to the workspace activity channel.
 * Returns an unsubscribe function.
 *
 * @param {Function} onEvent  — called with parsed event object
 * @param {number}   ws_id
 * @returns {Function}        — call to unsubscribe
 */
function subscribe(onEvent, ws_id = WS_ID) {
  const sub = getSubscriber();
  const channel = CHANNEL(ws_id);

  sub.subscribe(channel, (err) => {
    if (err) console.warn('[event-bus] subscribe error:', err.message);
  });

  const handler = (ch, message) => {
    if (ch !== channel) return;
    try {
      const event = JSON.parse(message);
      onEvent(event);
    } catch (_) {}
  };

  sub.on('message', handler);

  return function unsubscribe() {
    sub.removeListener('message', handler);
    // Note: don't call sub.unsubscribe() here — other listeners may share the connection
  };
}

// ── TASK 5.2: Automation trigger evaluation ──────────────────────────────
const AUTOMATION_TRIGGER_EVENTS = new Set(['task_completed', 'task_failed']);

async function evaluateAutomationTriggers(event) {
  if (!AUTOMATION_TRIGGER_EVENTS.has(event.type)) return;

  const ws_id      = event.ws_id || WS_ID;
  const cdKey      = `lu:gov:auto_cd:${event.type}:ws${ws_id}`;

  try {
    // Cooldown — minimum 5 minutes between same trigger type per workspace
    const onCooldown = await pub.get(cdKey);
    if (onCooldown) return;

    const wpUrl    = process.env.WP_URL || '';
    const wpSecret = process.env.WP_SECRET || '';
    if (!wpUrl || !wpSecret) return;

    const r = await fetch(
      `${process.env.LARAVEL_BASE_URL || process.env.LARAVEL_URL || wpUrl}/api/internal/automation/sequences?trigger=${encodeURIComponent(event.type)}&status=active`,
      { headers: { 'X-LevelUp-Secret': wpSecret }, signal: AbortSignal.timeout(5000) }
    ).catch(() => null);
    if (!r || !r.ok) return;

    const data = await r.json().catch(() => ({}));
    const sequences = Array.isArray(data.sequences) ? data.sequences : [];
    if (!sequences.length) return;

    // Set cooldown before enqueue to prevent duplicate fires
    const cooldownSecs = Math.max(300, (sequences[0]?.cooldown_minutes || 5) * 60);
    await pub.set(cdKey, '1', 'EX', cooldownSecs);

    const { enqueue } = require('./lu-queues');
    for (const seq of sequences) {
      await enqueue('marketing', 'automation.run_sequence', {
        sequence_id:  seq.id,
        triggered_by: event.task_id || event.type,
        trigger_data: { type: event.type, task_id: event.task_id, agent_id: event.agent_id },
        wp_url:       wpUrl,
        wp_secret:    wpSecret,
      }, { priority: 6 }).catch(() => {});
    }
  } catch (_) {
    // Never propagate — automation evaluation must never break event emission
  }
}


module.exports = {
  emit,
  getTimeline,
  getFeed,
  subscribe,
  AGENT_DISPLAY,
  WS_ID,
  evaluateAutomationTriggers,
};
