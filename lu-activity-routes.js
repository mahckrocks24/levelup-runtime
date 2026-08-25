/**
 * LevelUp — Activity Stream Service & Routes (Phase 8)
 *
 * Mount on your Express app:
 *   app.use('/internal/activity', activityRoutes);
 *
 * All routes require X-LevelUp-Secret header.
 *
 * ── REAL-TIME ────────────────────────────────────────────────────────
 * GET /internal/activity/stream
 *   Server-Sent Events stream for a workspace.
 *   Query params: ws_id (default 1), agent (filter), task (filter)
 *   Response: text/event-stream, keep-alive
 *   Each SSE event: data: {JSON event object}\n\n
 *
 * ── POLLING (SPA primary interface) ──────────────────────────────────
 * GET /internal/activity/feed
 *   Recent workspace events (polling fallback, 2–3s interval).
 *   Query params: limit, agent, task, since (unix ms), ws_id
 *   Response: { events: [...], count, ts }
 *
 * ── TIMELINE ─────────────────────────────────────────────────────────
 * GET /internal/activity/timeline/:task_id
 *   Ordered event log for a single task.
 *   Query params: limit (default 100)
 *   Response: { task_id, events: [...], count }
 *
 * GET /internal/activity/timeline/:task_id/summary
 *   Condensed timeline: just type, message, ts, progress per event.
 *   Suitable for compact UI rendering.
 */

'use strict';

const express = require('express');
const router  = express.Router();
const { emit, getTimeline, getFeed, subscribe, AGENT_DISPLAY } = require('./lu-event-bus');

// ── Auth ─────────────────────────────────────────────────────────────
router.use((req, res, next) => {
  const secret = process.env.LU_SECRET || process.env.lucore_runtime_secret || '';
  const header = req.headers['x-levelup-secret'] || req.headers['x-lu-secret'] || '';
  if (!secret || header !== secret) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
});

// ── SSE helpers ───────────────────────────────────────────────────────

const SSE_PING_INTERVAL   = 25_000;   // keep connection alive every 25s
const SSE_MAX_DURATION    = 5 * 60 * 1000;  // auto-close after 5 min (Railway 30s idle is handled by ping)

function sseHeaders(res) {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');     // nginx: disable proxy buffering
  res.flushHeaders();
}

function sendSSE(res, event, id) {
  if (res.writableEnded) return;
  if (id)     res.write(`id: ${id}\n`);
  res.write(`event: activity\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function sendSSEComment(res, comment) {
  if (!res.writableEnded) res.write(`: ${comment}\n\n`);
}

// ── GET /internal/activity/stream ────────────────────────────────────
router.get('/stream', async (req, res) => {
  const ws_id    = parseInt(req.query.ws_id || '1', 10);
  const agentFlt = req.query.agent  || null;
  const taskFlt  = req.query.task   || null;

  sseHeaders(res);

  // Send recent events on connect so client has context immediately
  const recent = await getFeed({ limit: 20, agent_id: agentFlt, task_id: taskFlt, ws_id });
  for (const evt of recent.reverse()) {
    sendSSE(res, evt, evt.id);
  }

  // Subscribe to live events
  const unsubscribe = subscribe((event) => {
    // Apply client-side filters
    if (agentFlt && event.agent_id !== agentFlt) return;
    if (taskFlt  && event.task_id  !== taskFlt)  return;
    sendSSE(res, event, event.id);
  }, ws_id);

  // Keepalive ping
  const pingTimer = setInterval(() => sendSSEComment(res, 'ping'), SSE_PING_INTERVAL);

  // Auto-close after max duration
  const closeTimer = setTimeout(() => {
    sendSSEComment(res, 'stream-closed');
    cleanup();
  }, SSE_MAX_DURATION);

  function cleanup() {
    clearInterval(pingTimer);
    clearTimeout(closeTimer);
    unsubscribe();
    if (!res.writableEnded) res.end();
  }

  req.on('close',   cleanup);
  req.on('aborted', cleanup);
  res.on('finish',  cleanup);
});

// ── GET /internal/activity/feed ──────────────────────────────────────
router.get('/feed', async (req, res) => {
  const limit    = Math.min(parseInt(req.query.limit   || '50',  10), 200);
  const agent_id = req.query.agent  || undefined;
  const task_id  = req.query.task   || undefined;
  const since_ts = req.query.since  ? parseInt(req.query.since, 10) : undefined;
  const ws_id    = parseInt(req.query.ws_id || '1', 10);

  const events = await getFeed({ limit, agent_id, task_id, since_ts, ws_id });

  return res.json({
    events,
    count: events.length,
    ts:    Date.now(),
  });
});

// ── GET /internal/activity/timeline/:task_id ─────────────────────────
router.get('/timeline/:task_id', async (req, res) => {
  const { task_id } = req.params;
  const limit = Math.min(parseInt(req.query.limit || '100', 10), 200);

  const events = await getTimeline(task_id, limit);

  return res.json({
    task_id,
    events,
    count: events.length,
  });
});

// ── GET /internal/activity/timeline/:task_id/summary ─────────────────
router.get('/timeline/:task_id/summary', async (req, res) => {
  const { task_id } = req.params;
  const events = await getTimeline(task_id, 100);

  const summary = events.map(e => ({
    id:         e.id,
    type:       e.type,
    ts:         e.ts,
    agent_id:   e.agent_id,
    agent_name: e.agent_name,
    agent_color:e.agent_color,
    tool_id:    e.tool_id   || null,
    progress:   e.progress  ?? null,
    message:    e.message,
  }));

  // Derive overall task progress from events
  const started    = events.find(e => e.type === 'task_started');
  const finished   = events.find(e => ['task_completed','task_partial','task_failed'].includes(e.type));
  const tool_events = events.filter(e => e.type === 'tool_completed');
  const tools_ok   = tool_events.filter(e => e.data?.status === 'ok').length;
  const tools_err  = tool_events.filter(e => e.data?.status !== 'ok').length;

  return res.json({
    task_id,
    events: summary,
    count:  summary.length,
    stats:  {
      started_at:  started?.ts  || null,
      finished_at: finished?.ts || null,
      duration_ms: (started && finished) ? finished.ts - started.ts : null,
      tools_total: tool_events.length,
      tools_ok,
      tools_err,
      final_status: finished?.type?.replace('task_', '') || 'running',
    },
  });
});

// ── POST /internal/activity/test-emit ────────────────────────────────
// Dev/debug only — emit a test event to verify the bus is working
if (process.env.NODE_ENV !== 'production') {
  router.post('/test-emit', async (req, res) => {
    const { type = 'task_started', agent_id = 'james', task_id = 'test_task' } = req.body || {};
    await emit({ type, agent_id, task_id, data: { title: 'Test event', ts: Date.now() } });
    return res.json({ ok: true, emitted: type });
  });
}

module.exports = router;
