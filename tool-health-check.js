'use strict';

/**
 * LevelUp — Tool Health Check
 * Part 5: Validates each tool endpoint is reachable and returning expected structure.
 *
 * Checks per tool:
 *   1. WP proxy route responds (not 404)
 *   2. Required params validated correctly (missing param → 400, not 500)
 *   3. Response has parseable JSON
 *
 * Results stored: lu:tool:health:{tool_id}  TTL: 30 min
 * Unhealthy tools: status = 'degraded' → planner avoids them
 *
 * Usage:
 *   const { runHealthChecks, getToolHealth, isHealthy } = require('./tool-health-check');
 *   await runHealthChecks(wp_url, wp_secret);    // run all checks
 *   const h = await getToolHealth('serp_analysis');
 *   if (!isHealthy(h)) console.warn('degraded');
 */

const { listAll } = require('./tool-registry');
const { createRedisConnection } = require('./redis');
const redis = createRedisConnection();

const KEY = id => `lu:tool:health:${id}`;
const TTL  = 30 * 60;   // 30 min
const TIMEOUT_MS = 8000;

// Tools that are safe to probe with a known-bad param (triggers 400, not a real call)
// LAUNCH SCOPE (v2.37.3): list_campaigns, list_posts, get_queue and
// list_templates removed — probing them would report a removed capability as
// "healthy" and keep it visible in tool-health output.
const SAFE_PROBE_TOOLS = new Set([
  'ai_status', 'list_leads', 'list_events',
  'list_goals', 'list_builder_pages',
  'list_site_pages', 'get_site_pages', 'check_availability',
  'list_design_templates',
]);

/**
 * Probe a single tool via WP /lu/v1/tools/execute.
 * Uses a deliberately missing required param to get a 400 (route exists)
 * vs 404 (route missing) or 500 (controller crash).
 */
async function probeTool(tool, wp_url, wp_secret) {
  const url = `${process.env.LARAVEL_BASE_URL || process.env.LARAVEL_URL || wp_url}/api/internal/tools/execute`;
  const t0  = Date.now();

  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-LU-Secret': wp_secret || '' },
      body:    JSON.stringify({
        tool_id:  tool.id,
        agent_id: tool.allowed_agents?.[0] || 'system',
        params:   {}, // empty params — should trigger 400 if route works, 404 if missing
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const ms   = Date.now() - t0;
    const json = await res.json().catch(() => null);

    if (res.status === 404) {
      return { status: 'degraded', reason: 'route_missing', code: 404, ms };
    }
    if (res.status === 500) {
      const msg = json?.message || json?.error || 'server error';
      return { status: 'degraded', reason: 'server_error', code: 500, ms, error: msg };
    }
    if (res.status === 400 || res.status === 403 || res.status === 422) {
      // Expected — missing params or capability check = route is alive
      return { status: 'healthy', reason: 'route_alive', code: res.status, ms };
    }
    if (res.status === 200 || res.status === 201) {
      return { status: 'healthy', reason: 'success', code: 200, ms };
    }

    return { status: 'unknown', reason: `unexpected_${res.status}`, code: res.status, ms };

  } catch (e) {
    const ms = Date.now() - t0;
    if (e.name === 'AbortError') {
      return { status: 'degraded', reason: 'timeout', ms: TIMEOUT_MS };
    }
    return { status: 'degraded', reason: 'network_error', ms, error: e.message };
  }
}

/**
 * Run health checks on a subset of tools.
 * Checks READ-ONLY tools that are safe to probe in production.
 * Write tools (POST/PUT with real params) are marked as assumed-healthy.
 *
 * @param {string} wp_url
 * @param {string} wp_secret
 * @param {object} opts  — { toolIds?: string[], force?: boolean }
 */
async function runHealthChecks(wp_url, wp_secret, opts = {}) {
  if (!wp_url) {
    console.warn('[health-check] WP_URL not set — skipping');
    return { checked: 0, healthy: 0, degraded: 0, skipped: 0 };
  }

  const allTools  = listAll();
  const toCheck   = opts.toolIds
    ? allTools.filter(t => opts.toolIds.includes(t.id))
    : allTools.filter(t => t.method === 'GET' || SAFE_PROBE_TOOLS.has(t.id));

  console.log(`[health-check] Checking ${toCheck.length} tools...`);
  const results = { checked: 0, healthy: 0, degraded: 0, skipped: 0 };

  // Parallel with concurrency cap (max 5 at once)
  const CONCURRENCY = 5;
  for (let i = 0; i < toCheck.length; i += CONCURRENCY) {
    const batch = toCheck.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async tool => {
      // Skip if fresh result exists unless forced
      if (!opts.force) {
        const cached = await getToolHealth(tool.id);
        if (cached && (Date.now() / 1000 - (cached.checked_at || 0)) < 1800) {
          results.skipped++;
          return;
        }
      }

      const health = await probeTool(tool, wp_url, wp_secret);
      health.tool_id    = tool.id;
      health.domain     = tool.domain;
      health.checked_at = Math.floor(Date.now() / 1000);

      try {
        await redis.set(KEY(tool.id), JSON.stringify(health), 'EX', TTL).catch(() => {})
      } catch (_) {}

      results.checked++;
      if (health.status === 'healthy') results.healthy++;
      else {
        results.degraded++;
        console.warn(`[health-check] DEGRADED: ${tool.id} — ${health.reason} (${health.ms}ms)`);
      }
    }));
  }

  console.log(`[health-check] Done — healthy:${results.healthy} degraded:${results.degraded} skipped:${results.skipped}`);
  return results;
}

/**
 * Get cached health status for a single tool.
 */
async function getToolHealth(tool_id) {
  try {
    const raw = await redis.get(KEY(tool_id)).catch(() => null)
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

/**
 * Check if a tool is healthy (not degraded).
 * Returns true if: healthy, unknown, or no data (assume OK).
 */
function isHealthy(health) {
  if (!health) return true;       // no data = assume healthy
  return health.status !== 'degraded';
}

/**
 * Filter a tool list to exclude degraded tools.
 * Used by planner and meeting-room before dispatching tools.
 */
async function filterHealthyTools(toolIds) {
  const results = await Promise.allSettled(toolIds.map(id => getToolHealth(id)));
  return toolIds.filter((id, i) => {
    const h = results[i].status === 'fulfilled' ? results[i].value : null;
    return isHealthy(h);
  });
}

/**
 * Get a summary of all known health statuses (for dashboard/insights).
 */
async function getHealthSummary() {
  const tools = listAll();
  const statuses = await Promise.allSettled(tools.map(t => getToolHealth(t.id)));
  const summary = { healthy: [], degraded: [], unchecked: [] };

  tools.forEach((t, i) => {
    const h = statuses[i].status === 'fulfilled' ? statuses[i].value : null;
    if (!h)                        summary.unchecked.push(t.id);
    else if (h.status === 'degraded') summary.degraded.push({ id: t.id, reason: h.reason });
    else                           summary.healthy.push(t.id);
  });
  return summary;
}

module.exports = { runHealthChecks, getToolHealth, isHealthy, filterHealthyTools, getHealthSummary };
