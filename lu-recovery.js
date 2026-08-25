/**
 * LevelUp — Crash Recovery
 *
 * Runs once on process startup before the worker begins accepting jobs.
 * Finds jobs that were "running" in Redis state but are no longer active
 * in BullMQ (process crashed mid-job). Resets them to "queued" so
 * BullMQ's stall detection can pick them up and retry.
 *
 * Also cleans up any "queued" state entries whose BullMQ job no longer
 * exists (manual queue clears, Redis flush, etc.).
 */

'use strict';

const { redis }    = require('./lu-lifecycle');
const { taskQueue } = require('./lu-queue');

const RECOVERY_SCAN_PATTERN = 'lu:task:*:state';
const RECOVERY_INTERVAL_MS  = 60_000;   // scan every 60s for safety

async function recoverOrphanedJobs() {
  console.log('[recovery] Scanning for orphaned jobs…');
  let cursor = '0';
  let orphaned = 0;
  let recovered = 0;

  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', RECOVERY_SCAN_PATTERN, 'COUNT', 100);
    cursor = next;

    for (const key of keys) {
      const state = await redis.get(key);
      if (state !== 'running' && state !== 'queued') continue;

      // Extract task_id from key pattern lu:task:{id}:state
      const task_id = key.split(':')[2];
      if (!task_id) continue;

      const bullJob = await taskQueue.getJob(task_id);

      if (!bullJob) {
        // Redis says running/queued but BullMQ has no record — orphaned
        orphaned++;
        const meta = await redis.hgetall(`lu:task:${task_id}:meta`);
        const payload = meta._job_payload ? JSON.parse(meta._job_payload) : null;

        if (state === 'running' || state === 'queued') {
          // Both running-crash and queued-orphan follow the same recovery path:
          // requeue from stored payload, or mark failed if payload is gone.
          if (payload) {
            try {
              await taskQueue.add('agent-task', payload, { jobId: task_id });
              await redis.set(key, 'queued');
              await redis.hset(`lu:task:${task_id}:meta`, {
                state:         'queued',
                recovery_at:   Math.floor(Date.now() / 1000),
                recovery_from: state === 'running' ? 'crash' : 'queued_orphan',
              });
              recovered++;
              console.log(`[recovery] Re-queued orphaned task ${task_id} (was: ${state})`);
            } catch (e) {
              // Job may already exist in BullMQ (race condition) — ignore duplicate
              if (!e.message.includes('already exists')) {
                console.error(`[recovery] Failed to requeue ${task_id}:`, e.message);
              } else {
                recovered++;
              }
            }
          } else {
            // No payload stored — cannot recover, mark explicitly failed
            await redis.set(key, 'failed');
            await redis.hset(`lu:task:${task_id}:meta`, {
              state:       'failed',
              last_error:  `Unrecoverable orphan (was: ${state}): no stored job payload`,
              finished_at: Math.floor(Date.now() / 1000),
            });
            console.warn(`[recovery] Marked ${task_id} as failed — orphaned with no payload (was: ${state})`);
          }
        }
      } else {
        // BullMQ job exists — check for mismatch
        const bullState = await bullJob.getState();
        if (bullState === 'completed' && state !== 'complete' && state !== 'partial') {
          // BullMQ says done but Redis lifecycle didn't update — fix it
          await redis.set(key, 'complete');
          console.log(`[recovery] Fixed state mismatch for ${task_id}: ${state} → complete`);
          recovered++;
        } else if (bullState === 'failed' && state !== 'failed') {
          await redis.set(key, 'failed');
          await redis.hset(`lu:task:${task_id}:meta`, {
            last_error: bullJob.failedReason || 'Failed in BullMQ',
            finished_at: Math.floor(Date.now() / 1000),
          });
          console.log(`[recovery] Fixed state mismatch for ${task_id}: ${state} → failed`);
          recovered++;
        }
      }
    }
  } while (cursor !== '0');

  console.log(`[recovery] Scan complete. Orphaned: ${orphaned}, Recovered: ${recovered}`);
  return { orphaned, recovered };
}

/**
 * Store job payload in Redis meta when job is enqueued.
 * This enables crash recovery to requeue without hitting WP.
 */
async function storeJobPayload(task_id, payload) {
  await redis.hset(`lu:task:${task_id}:meta`, {
    _job_payload: JSON.stringify(payload),
  });
}

/**
 * Run recovery on startup, then periodically.
 */
async function startRecovery() {
  // Run immediately on startup
  try {
    await recoverOrphanedJobs();
  } catch (e) {
    console.error('[recovery] Startup scan failed:', e.message);
  }

  // Then repeat on interval as background safety net
  setInterval(async () => {
    try {
      await recoverOrphanedJobs();
    } catch (e) {
      console.error('[recovery] Interval scan failed:', e.message);
    }
  }, RECOVERY_INTERVAL_MS);
}

module.exports = { startRecovery, recoverOrphanedJobs, storeJobPayload };
