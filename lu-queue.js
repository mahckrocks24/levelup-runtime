/**
 * LevelUp — Task Queue (BullMQ)
 * Single source of truth for queue config, connection, and queue objects.
 *
 * Queue: lu-tasks
 * DLQ:   lu-tasks-dead   (jobs exhausted all retries land here)
 */

'use strict';

const { Queue, QueueEvents } = require('bullmq');

// ── Redis connection ─────────────────────────────────────────────────
const connection = {
  url: process.env.REDIS_URL,                 // Railway injects this
  maxRetriesPerRequest: null,                 // Required by BullMQ
  enableReadyCheck: false,
  tls: process.env.REDIS_URL?.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined,
};

// ── Queue names ──────────────────────────────────────────────────────
const QUEUE_NAME     = 'lu-tasks';
const DLQ_NAME       = 'lu-tasks-dead';
const QUEUE_PREFIX   = 'lu';                  // Redis key prefix

// ── Retry / backoff policy ───────────────────────────────────────────
const RETRY_CONFIG = {
  attempts: 4,                                // 1 initial + 3 retries
  backoff: {
    type: 'exponential',
    delay: 8_000,                             // 8s, 16s, 32s, 64s
  },
};

// ── Stall / lock ─────────────────────────────────────────────────────
const LOCK_DURATION  = 45_000;               // Worker holds lock for 45s
const STALL_INTERVAL = 15_000;               // Check stalls every 15s

// ── Job options ──────────────────────────────────────────────────────
const JOB_OPTIONS = {
  ...RETRY_CONFIG,
  removeOnComplete: { count: 500, age: 60 * 60 * 24 * 7 },   // keep 500, 7d
  removeOnFail:     { count: 200, age: 60 * 60 * 24 * 30 },  // keep DLQ 30d
};

// ── Queue instances ──────────────────────────────────────────────────
const taskQueue = new Queue(QUEUE_NAME, {
  connection,
  prefix: QUEUE_PREFIX,
  defaultJobOptions: JOB_OPTIONS,
});

const deadQueue = new Queue(DLQ_NAME, {
  connection,
  prefix: QUEUE_PREFIX,
  defaultJobOptions: { removeOnFail: false },
});

const queueEvents = new QueueEvents(QUEUE_NAME, {
  connection,
  prefix: QUEUE_PREFIX,
});

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Enqueue a task job.
 * @param {object} payload
 * @param {string} payload.task_id
 * @param {string} payload.goal_id
 * @param {string} payload.agent_id
 * @param {string[]} payload.tools
 * @param {object}  payload.params
 * @param {string}  payload.title
 * @param {string}  payload.wp_url      — WP REST base URL (staging or prod)
 * @param {string}  payload.wp_secret   — LU runtime secret
 * @param {string}  payload.callback_url — lu/v1/agent/result endpoint
 * @returns {Promise<import('bullmq').Job>}
 */
async function enqueueTask(payload) {
  const job = await taskQueue.add('agent-task', payload, {
    jobId: payload.task_id,           // Idempotent: same task_id = same job
    ...JOB_OPTIONS,
  });
  return job;
}

/**
 * Cancel a queued (not yet running) task.
 * Running jobs cannot be cancelled — they must complete or fail.
 */
async function cancelTask(task_id) {
  const job = await taskQueue.getJob(task_id);
  if (!job) return { cancelled: false, reason: 'not_found' };
  const state = await job.getState();
  if (state === 'active') return { cancelled: false, reason: 'already_running' };
  await job.remove();
  return { cancelled: true };
}

/**
 * Get raw BullMQ job counts for a queue health snapshot.
 */
async function getQueueCounts() {
  const [waiting, active, completed, failed, delayed, paused] = await Promise.all([
    taskQueue.getWaitingCount(),
    taskQueue.getActiveCount(),
    taskQueue.getCompletedCount(),
    taskQueue.getFailedCount(),
    taskQueue.getDelayedCount(),
    taskQueue.getPausedCount(),
  ]);
  return { waiting, active, completed, failed, delayed, paused };
}

/**
 * Get recent failed jobs for the dead-letter view.
 */
async function getDeadJobs(limit = 20) {
  const jobs = await taskQueue.getFailed(0, limit - 1);
  return jobs.map(j => ({
    task_id:    j.id,
    agent_id:   j.data?.agent_id,
    title:      j.data?.title,
    failed_at:  j.finishedOn,
    attempts:   j.attemptsMade,
    error:      j.failedReason,
  }));
}

module.exports = {
  connection,
  taskQueue,
  deadQueue,
  queueEvents,
  QUEUE_NAME,
  DLQ_NAME,
  LOCK_DURATION,
  STALL_INTERVAL,
  enqueueTask,
  cancelTask,
  getQueueCounts,
  getDeadJobs,
};
