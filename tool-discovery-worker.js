'use strict';

/**
 * LevelUp — Tool Discovery Background Worker
 * Phases 1–5: Deferred, guarded, non-blocking discovery + health checks.
 *
 * Boot contract: this module does NOTHING at require() time.
 * All work happens in the background, deferred after server is live.
 *
 * Call start() exactly once from index.js after app.listen() succeeds.
 */

let _started = false;

function start() {
  if (_started) return;
  _started = true;

  // Phase 2: Wait 30s before first discovery (server must be fully live first)
  setTimeout(() => _runDiscovery(), 30 * 1000);

  // Phase 2: Repeat every 30 minutes
  setInterval(() => _runDiscovery(), 30 * 60 * 1000);

  // Phase 5: Health checks start at 90s, repeat every 30 min
  setTimeout(() => _runHealthChecks(), 90 * 1000);
  setInterval(() => _runHealthChecks(), 30 * 60 * 1000);

  console.log('[WORKER] Background discovery scheduled: first run in 30s');
}

// Phase 3+4: Fully guarded discovery
async function _runDiscovery() {
  const wp_url = process.env.WP_URL || '';
  const secret = process.env.WP_SECRET || '';
  if (!wp_url) {
    console.warn('[WORKER] WP_URL not set — skipping tool discovery');
    return;
  }

  try {
    // Lazy require — only loaded when actually needed, never at boot
    const { scanPlatformTools } = require('./tool-discovery');
    const result = await scanPlatformTools(wp_url, secret);
    console.log(`[WORKER] Discovery: ${result.known} known, ${result.new} new, cached=${result.cached}`);

    if (result.new > 0) {
      try {
        const { learnNewTools } = require('./tool-learning');
        const newOnes = (result.dynamic || []).filter(t => t.auto_discovered);
        await learnNewTools(newOnes);
        console.log(`[WORKER] Learned ${newOnes.length} new tool(s)`);
      } catch (e) {
        // Phase 3: learning failure never crashes worker
        console.warn('[WORKER] Tool learning failed (non-fatal):', e.message);
      }
    }
  } catch (e) {
    // Phase 3: discovery failure is always non-fatal
    console.warn('[WORKER] Tool discovery failed (non-fatal):', e.message);
  }
}

// Phase 5: Guarded health checks
async function _runHealthChecks() {
  const wp_url = process.env.WP_URL || '';
  const secret = process.env.WP_SECRET || '';
  if (!wp_url) return;

  try {
    const { runHealthChecks } = require('./tool-health-check');
    const result = await runHealthChecks(wp_url, secret);
    if (result.degraded > 0) {
      console.warn(`[WORKER] Health: ${result.healthy} healthy, ${result.degraded} DEGRADED`);
    } else {
      console.log(`[WORKER] Health: ${result.healthy} healthy, ${result.skipped} skipped`);
    }
  } catch (e) {
    // Phase 3: health check failure is always non-fatal
    console.warn('[WORKER] Health check failed (non-fatal):', e.message);
  }
}

module.exports = { start };
