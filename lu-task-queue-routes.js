/**
 * LevelUp — Task Queue Express Routes
 *
 * These routes are mounted on the existing Railway Express server
 * under /internal/task/
 *
 * All routes require X-LevelUp-Secret header.
 *
 * POST /internal/task/enqueue        — add job to BullMQ, return queued
 * GET  /internal/task/poll/:task_id  — return Redis lifecycle state
 * GET  /internal/task/log/:task_id   — return full event log
 * POST /internal/task/cancel/:task_id — cancel a queued job
 * GET  /internal/task/queue/stats    — BullMQ queue health
 * GET  /internal/task/queue/dead     — failed jobs list
 * POST /internal/task/queue/retry/:task_id — retry a failed job
 */

'use strict';

const express  = require('express');
const router   = express.Router();

const { enqueueTask, cancelTask, getQueueCounts, getDeadJobs, taskQueue } = require('./lu-queue');
const { getState, transition, getLog, redis, TERMINAL }  = require('./lu-lifecycle');
const { storeJobPayload }                       = require('./lu-recovery');
const { emit }                                  = require('./lu-event-bus');  // Phase 8

// ── Auth middleware ──────────────────────────────────────────────────
router.use((req, res, next) => {
  const secret = process.env.LU_SECRET || process.env.lucore_runtime_secret || '';
  const header = req.headers['x-levelup-secret'] || req.headers['x-lu-secret'] || '';
  if (!secret || header !== secret) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
});

// ── POST /internal/task/enqueue ──────────────────────────────────────
router.post('/enqueue', async (req, res) => {
  const {
    task_id, goal_id, agent_id, tools = [], params = {},
    title, wp_url, wp_secret, callback_url,
  } = req.body;

  if (!task_id || !agent_id) {
    return res.status(400).json({ error: 'task_id and agent_id required' });
  }

  // Idempotency: if already queued/running/complete, return current state
  const existing = await getState(task_id);
  if (existing && existing.state !== 'pending') {
    return res.json({
      task_id,
      status: existing.state,
      queued: false,
      reason: 'already_exists',
    });
  }

  const payload = {
    task_id, goal_id, agent_id, tools, params, title,
    wp_url:       wp_url || process.env.WP_URL || '',
    wp_secret:    wp_secret || process.env.WP_SECRET || '',
    callback_url: callback_url || process.env.WP_CALLBACK_URL || '',
  };

  try {
    // Write lifecycle state before enqueuing (visible immediately for polling)
    await transition(task_id, 'queued', { agent_id, title: title || task_id, goal_id: goal_id || '' });

    // Phase 8: emit task_created
    emit({ type: 'task_created', task_id, goal_id, agent_id,
      data: { title: title || task_id, tools } }).catch(() => {});

    // Store payload for crash recovery
    await storeJobPayload(task_id, payload);

    // Add to BullMQ
    const job = await enqueueTask(payload);

    console.log(`[routes] Enqueued task=${task_id} agent=${agent_id} tools=${tools.join(',')}`);

    return res.status(202).json({
      task_id,
      job_id:  job.id,
      status:  'queued',
      queued:  true,
    });
  } catch (e) {
    console.error('[routes] Enqueue failed:', e.message);
    return res.status(500).json({ error: 'enqueue_failed', message: e.message });
  }
});

// ── GET /internal/task/poll/:task_id ─────────────────────────────────
router.get('/poll/:task_id', async (req, res) => {
  const { task_id } = req.params;
  const state = await getState(task_id);

  if (!state) {
    return res.status(404).json({ task_id, state: null, error: 'not_found' });
  }

  // Progress only exists when the worker is actively executing tools.
  // Returning it during 'queued' is misleading — the job hasn't started yet.
  let progress = null;
  if (state.state === 'running') {
    try {
      const job = await taskQueue.getJob(task_id);
      if (job) progress = job.progress;
    } catch (_) {}
  }

  return res.json({ ...state, progress });
});

// ── GET /internal/task/log/:task_id ──────────────────────────────────
router.get('/log/:task_id', async (req, res) => {
  const { task_id } = req.params;
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const log = await getLog(task_id, limit);
  return res.json({ task_id, count: log.length, entries: log });
});

// ── POST /internal/task/cancel/:task_id ──────────────────────────────
router.post('/cancel/:task_id', async (req, res) => {
  const { task_id } = req.params;

  // Check current state before attempting cancel
  const currentState = await getState(task_id);
  if (!currentState) {
    return res.status(404).json({ task_id, cancelled: false, reason: 'not_found' });
  }

  // Cannot cancel terminal or already-cancelled tasks
  if (TERMINAL.has(currentState.state) || currentState.state === 'cancelled') {
    return res.status(400).json({
      task_id,
      cancelled: false,
      reason: currentState.state === 'cancelled' ? 'already_cancelled' : 'already_terminal',
      current_state: currentState.state,
    });
  }

  // Cannot cancel a running job — it must complete or fail
  if (currentState.state === 'running') {
    return res.status(409).json({
      task_id,
      cancelled: false,
      reason: 'already_running',
      current_state: 'running',
    });
  }

  // Attempt BullMQ removal (queued/retrying state)
  const result = await cancelTask(task_id);

  if (!result.cancelled) {
    // cancelTask checks BullMQ job state — if it transitioned to active between
    // our check and the removal, report honestly
    return res.status(409).json({
      task_id,
      cancelled: false,
      reason: result.reason || 'cancel_failed',
    });
  }

  // BullMQ removal succeeded — now update Redis lifecycle
  try {
    await transition(task_id, 'cancelled');
  } catch (e) {
    // Should not happen given state checks above, but log it
    console.error(`[routes] cancel lifecycle transition failed for ${task_id}:`, e.message);
  }

  return res.json({ task_id, cancelled: true });
});

// ── GET /internal/task/queue/stats ───────────────────────────────────
router.get('/queue/stats', async (req, res) => {
  const counts = await getQueueCounts();
  return res.json({
    queue:    'lu-tasks',
    counts,
    healthy:  counts.failed === 0 && counts.waiting < 50,
    ts:       Math.floor(Date.now() / 1000),
  });
});

// ── GET /internal/task/queue/dead ────────────────────────────────────
router.get('/queue/dead', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
  const jobs  = await getDeadJobs(limit);
  return res.json({ count: jobs.length, jobs });
});

// ── POST /internal/task/queue/retry/:task_id ─────────────────────────
router.post('/queue/retry/:task_id', async (req, res) => {
  const { task_id } = req.params;
  try {
    // Check Redis state first — only failed tasks can be retried
    const redisState = await getState(task_id);
    if (!redisState) {
      return res.status(404).json({ error: 'task_not_found', task_id });
    }
    if (redisState.state !== 'failed') {
      return res.status(400).json({
        error: 'only_failed_tasks_can_be_retried',
        current_state: redisState.state,
        task_id,
      });
    }

    // Confirm BullMQ also has the job in failed state
    const job = await taskQueue.getJob(task_id);
    if (!job) {
      // Job was removed from BullMQ (e.g. removeOnFail age expiry) but Redis
      // still says failed. Re-enqueue from stored payload.
      const meta = await redis.hgetall(`lu:task:${task_id}:meta`);
      const payload = meta._job_payload ? JSON.parse(meta._job_payload) : null;
      if (!payload) {
        return res.status(422).json({
          error: 'unrecoverable_no_payload',
          task_id,
          message: 'Job payload expired from BullMQ and Redis meta. Cannot retry.',
        });
      }
      // Re-enqueue with fresh job (no jobId lock — old job is gone)
      const newJob = await taskQueue.add('agent-task', payload);
      await transition(task_id, 'queued', { retry_manual: 'true', new_job_id: newJob.id });
      return res.json({ task_id, status: 'requeued', method: 'reenqueued', job_id: newJob.id });
    }

    const bullState = await job.getState();
    if (bullState !== 'failed') {
      return res.status(400).json({
        error: 'bullmq_job_not_in_failed_state',
        bullmq_state: bullState,
        task_id,
      });
    }

    // job.retry() moves the job back to waiting — do this BEFORE lifecycle transition
    await job.retry();

    // Confirm the job actually moved out of failed state
    const stateAfter = await job.getState();
    if (stateAfter === 'failed') {
      // retry() silently failed — do not update Redis
      return res.status(500).json({
        error: 'bullmq_retry_failed',
        task_id,
        message: 'BullMQ job.retry() did not move job out of failed state.',
      });
    }

    // Transition failed → retrying (job exists, BullMQ will execute it)
    // This is more accurate than failed → queued because BullMQ counts this
    // as a retry attempt, not a fresh enqueue.
    await transition(task_id, 'retrying', { retry_manual: 'true' });

    return res.json({ task_id, status: 'requeued', job_id: job.id });
  } catch (e) {
    console.error(`[routes] retry error for ${task_id}:`, e.message);
    return res.status(500).json({ error: e.message, task_id });
  }
});

module.exports = router;
