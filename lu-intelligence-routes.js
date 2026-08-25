/**
 * LevelUp — Intelligence Layer Routes (Phase 7)
 *
 * Mount on your Express app:
 *   app.use('/internal/intelligence', intelligenceRoutes);
 *
 * All routes require X-LevelUp-Secret header.
 *
 * POST /internal/intelligence/plan
 *   Generate a multi-agent task plan for a goal.
 *   Body: { goal_id, goal, context?, extra_ctx? }
 *
 * GET  /internal/intelligence/trace/:task_id
 *   Retrieve the full reasoning trace for a task.
 *
 * GET  /internal/intelligence/memory/workspace
 *   Read all long-term workspace memory.
 *
 * POST /internal/intelligence/memory/workspace
 *   Write one or more workspace memory fields.
 *   Body: { field: value, ... }  OR  { fields: { field: value } }
 *
 * GET  /internal/intelligence/memory/task/:task_id
 *   Read persisted task memory record.
 *
 * GET  /internal/intelligence/memory/recent
 *   Recent completed task summaries (last N).
 *
 * GET  /internal/intelligence/collab/:goal_id
 *   All inter-agent messages for a goal.
 *
 * POST /internal/intelligence/context/invalidate
 *   Invalidate the workspace context cache (call after settings update).
 *
 * GET  /internal/agent/plan  (new — replaces stub)
 *   Alias for /internal/intelligence/plan (backward compat with PHP)
 */

'use strict';

const express = require('express');
const router  = express.Router();

const { createPlan }               = require('./lu-planner');
const { getWorkspaceContext,
        invalidateContextCache }   = require('./lu-context');
const { longTermReadAll,
        longTermWriteAll,
        taskMemoryRead,
        recentTaskMemory }         = require('./lu-memory');
const { traceRead }                = require('./lu-reasoning');
const { getGoalMessages,
        getDelegations }           = require('./lu-collaborator');

// ── Auth ─────────────────────────────────────────────────────────────
router.use((req, res, next) => {
  const secret = process.env.LU_SECRET || process.env.lucore_runtime_secret || '';
  const header = req.headers['x-levelup-secret'] || req.headers['x-lu-secret'] || '';
  if (!secret || header !== secret) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
});

// ── POST /internal/intelligence/plan ─────────────────────────────────
// Also handles POST /internal/agent/plan (legacy alias used by PHP)
async function handlePlan(req, res) {
  const { goal_id, goal, extra_ctx } = req.body;
  if (!goal_id || !goal) {
    return res.status(400).json({ error: 'goal_id and goal required' });
  }

  // Load workspace context (cached 15min)
  const wp_url    = process.env.WP_URL || '';
  const wp_secret = process.env.LU_SECRET || '';
  const context   = await getWorkspaceContext(wp_url, wp_secret).catch(() => ({}));

  const { tasks, used_llm, error } = await createPlan({ goal_id, goal, context, extra_ctx: extra_ctx || '' });

  return res.json({ goal_id, goal, tasks, used_llm, error: error || null });
}

router.post('/plan', handlePlan);

// ── GET /internal/intelligence/trace/:task_id ─────────────────────────
router.get('/trace/:task_id', async (req, res) => {
  const trace = await traceRead(req.params.task_id);
  if (!trace) return res.status(404).json({ error: 'trace_not_found', task_id: req.params.task_id });
  return res.json(trace);
});

// ── GET /internal/intelligence/memory/workspace ───────────────────────
router.get('/memory/workspace', async (req, res) => {
  const memory = await longTermReadAll();
  return res.json({ ws_id: 1, fields: memory });
});

// ── POST /internal/intelligence/memory/workspace ──────────────────────
router.post('/memory/workspace', async (req, res) => {
  const body = req.body;
  // Accept { field: value } or { fields: { field: value } }
  const to_write = body.fields || body;
  if (!to_write || typeof to_write !== 'object') {
    return res.status(400).json({ error: 'body must be a field map' });
  }
  await longTermWriteAll(to_write);
  await invalidateContextCache();
  return res.json({ ok: true, fields_written: Object.keys(to_write).length });
});

// ── GET /internal/intelligence/memory/task/:task_id ───────────────────
router.get('/memory/task/:task_id', async (req, res) => {
  const record = await taskMemoryRead(req.params.task_id);
  if (!record) return res.status(404).json({ error: 'not_found' });
  return res.json(record);
});

// ── GET /internal/intelligence/memory/recent ─────────────────────────
router.get('/memory/recent', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '10', 10), 50);
  const tasks = await recentTaskMemory(limit);
  return res.json({ count: tasks.length, tasks });
});

// ── GET /internal/intelligence/collab/:goal_id ────────────────────────
router.get('/collab/:goal_id', async (req, res) => {
  const [messages, delegations] = await Promise.all([
    getGoalMessages(req.params.goal_id),
    getDelegations(req.params.goal_id),
  ]);
  return res.json({ goal_id: req.params.goal_id, messages, delegations });
});

// ── POST /internal/intelligence/context/invalidate ───────────────────
router.post('/context/invalidate', async (req, res) => {
  await invalidateContextCache();
  return res.json({ ok: true });
});

// ── Workspace context read (used by worker before dispatch) ──────────
router.get('/context', async (req, res) => {
  const wp_url    = process.env.WP_URL || '';
  const wp_secret = process.env.LU_SECRET || '';
  const force     = req.query.refresh === '1';
  const context   = await getWorkspaceContext(wp_url, wp_secret, force);
  return res.json(context);
});

module.exports = router;

// Export handlePlan for use as backward-compat alias in server.js:
// app.post('/internal/agent/plan', (req, res) => handlePlan(req, res));
module.exports.handlePlan = handlePlan;
