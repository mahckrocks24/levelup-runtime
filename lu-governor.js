'use strict';

/**
 * lu-governor.js — Agent Task Governance Monitor (Phase 6)
 *
 * Runs every 30s in the runtime process.
 * Detects: queue backlog overflow, failure spikes.
 * Response: sets WP transients via POST /lu/v1/governance/flag.
 * WP dispatch reads those transients before every enqueue.
 */

const { getAllQueueCounts } = require('./lu-queues');

const WP_URL    = process.env.WP_URL    || '';
const WP_SECRET = process.env.WP_SECRET || '';

// ── Notify WP: set a governance transient ───────────────────────────────
async function setWpFlag(key, ttlSeconds) {
    const LV_BASE = process.env.LARAVEL_BASE_URL || process.env.LARAVEL_URL || WP_URL;
    if (!LV_BASE || !WP_SECRET) return;
    await fetch(`${LV_BASE}/api/internal/governance/flag`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-LevelUp-Secret': WP_SECRET },
        body:    JSON.stringify({ key, ttl: ttlSeconds }),
        signal:  AbortSignal.timeout(5000),
    }).catch(e => console.warn('[governor] WP flag failed:', e.message));
}

// ── Main governance cycle ────────────────────────────────────────────────
async function runGovernorCycle() {
    try {
        const counts = await getAllQueueCounts();

        for (const [domain, c] of Object.entries(counts)) {
            const waiting = c.waiting || 0;
            const failed  = c.failed  || 0;

            // Backlog overflow — pause background execution for workspace 1
            if (waiting > 50) {
                console.warn(`[governor] Backlog overflow: domain=${domain} waiting=${waiting} — pausing background`);
                await setWpFlag('lu_gov_pause_background_1', 1800); // 30 min
            }

            // Failure spike — log alert (future: notify admin)
            if (failed > 10) {
                console.warn(`[governor] Failure spike: domain=${domain} failed=${failed}`);
            }
        }

        // Check agent:auto backlog specifically — if > 100, throttle auto agents
        const autoQ = counts.agent_auto || {};
        if ((autoQ.waiting || 0) > 100) {
            console.warn('[governor] Agent auto queue > 100 — throttling autonomous execution');
            await setWpFlag('lu_gov_pause_background_1', 3600); // 1 hour
        }

    } catch (e) {
        console.error('[governor] Cycle error:', e.message);
    }
}

// ── Start ────────────────────────────────────────────────────────────────
let _interval = null;

function start(intervalMs = 30_000) {
    if (_interval) return;
    runGovernorCycle(); // run immediately on startup
    _interval = setInterval(runGovernorCycle, intervalMs);
    console.log('[governor] Started — interval=' + intervalMs + 'ms');
}

function stop() {
    if (_interval) { clearInterval(_interval); _interval = null; }
}

process.on('SIGTERM', stop);
process.on('SIGINT',  stop);

module.exports = { start, stop, runGovernorCycle };
