/**
 * LevelUp Runtime — Phase 8 Bootstrap
 *
 * Drop all lu-*.js files into your existing Railway runtime repo root
 * (alongside index.js, agents.js, etc.), then wire in these lines:
 *
 *   In your index.js / server.js:
 *
 *     // 1. Start worker + crash recovery
 *     require('./lu-bootstrap');
 *
 *     // 2. Phase 6 — task queue routes
 *     const taskQueueRoutes = require('./lu-task-queue-routes');
 *     app.use('/internal/task', taskQueueRoutes);
 *
 *     // 3. Phase 7 — intelligence routes
 *     const intelligenceRoutes = require('./lu-intelligence-routes');
 *     app.use('/internal/intelligence', intelligenceRoutes);
 *
 *     // 4. Backward-compat alias for PHP lu_agent_plan_create
 *     const { handlePlan } = require('./lu-intelligence-routes');
 *     app.post('/internal/agent/plan', handlePlan);
 *
 *     // 5. Phase 8 — activity stream routes
 *     const activityRoutes = require('./lu-activity-routes');
 *     app.use('/internal/activity', activityRoutes);
 *
 * Required env vars (add to Railway):
 *   WP_URL             — https://staging1.shukranuae.com
 *   WORKER_CONCURRENCY — 3  (optional, default 3)
 *   SYNTHESIS_ENDPOINT — http://localhost:PORT/internal/agent/run  (optional)
 *
 * Already set on Railway (no action needed):
 *   REDIS_URL / LU_SECRET / WP_CALLBACK_URL / DEEPSEEK_API_KEY
 */

'use strict';

// ── 1. Start BullMQ worker (Phase 6 + 7 + 8) ─────────────────────────
require('./lu-task-worker');

// ── 2. Crash recovery scan on startup + every 60s ─────────────────────
const { startRecovery } = require('./lu-recovery');
startRecovery().catch(e => console.error('[bootstrap] Recovery failed:', e.message));

console.log('[bootstrap] Phase 8 activity visualization initialized');
