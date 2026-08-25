'use strict';

/**
 * LevelUp — Campaign Learning Module
 * Phase 6: Extract performance patterns from campaigns, tools, and exec logs.
 *
 * Reads from WP REST (lu_exec_log, lumkt_campaigns, lu_tool_log).
 * Writes summaries to workspace long-term memory: lu:mem:ws:1:campaign_insights
 *
 * Called:
 *  - After every meeting synthesis (non-blocking background job)
 *  - On demand via /internal/insights/refresh endpoint (Phase 9)
 */

const { createRedisConnection } = require('./redis');
const redis = createRedisConnection();

// TODO (Intervention 2 deploy): set LARAVEL_URL in Railway env (e.g.
// LARAVEL_URL=https://staging.levelupgrowth.io). Without it, fetchCampaigns
// and fetchToolStats fall back to wp_url and continue hitting the dead WP
// endpoints. See memory-loop-patch-report.md for the canonical contract.

// Pre-Intervention 0: per-workspace key. Legacy callers default to 1.
const memKey = (ws_id = 1) => `lu:mem:ws:${ws_id}:campaign_insights`;
const MEM_TTL  = 90 * 24 * 60 * 60;
const CACHE_TTL = 6 * 60 * 60; // re-compute at most every 6h

/**
 * Fetch campaign data from Laravel /api/internal/campaigns.
 * Memory Loop Patch 2026-04-25: replaced dead /wp-json/lumkt/v1/campaigns endpoint.
 * If LARAVEL_URL env var is unset, falls back to wp_url (deprecated).
 */
async function fetchCampaigns(wp_url, wp_secret) {
  try {
    const base = process.env.LARAVEL_BASE_URL || process.env.LARAVEL_URL || wp_url;
    const res = await fetch(`${base}/api/internal/campaigns?limit=50`, {
      headers: { 'X-LU-Secret': wp_secret || '', Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.campaigns || [];
  } catch (_) { return []; }
}

/**
 * Fetch tool reliability stats from Laravel /api/internal/tools/status.
 * Memory Loop Patch 2026-04-25: replaced dead /wp-json/lu/v1/tools/status endpoint.
 */
async function fetchToolStats(wp_url, wp_secret) {
  try {
    const base = process.env.LARAVEL_BASE_URL || process.env.LARAVEL_URL || wp_url;
    const res = await fetch(`${base}/api/internal/tools/status`, {
      headers: { 'X-LU-Secret': wp_secret || '', Accept: 'application/json' },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return {};
    const data = await res.json();
    return data.stats || {};
  } catch (_) { return {}; }
}

/**
 * Analyse campaigns and build insight object.
 */
function analyseCampaigns(campaigns) {
  if (!campaigns.length) return null;

  const sent   = campaigns.filter(c => c.status === 'sent');
  const active = campaigns.filter(c => ['active','scheduled'].includes(c.status));

  // Find high-performing (sent, non-zero open rate)
  const withMetrics = sent.filter(c => c.open_rate > 0 || c.click_rate > 0);
  const topPerformers = withMetrics
    .sort((a, b) => (b.open_rate || 0) - (a.open_rate || 0))
    .slice(0, 3);
  const lowPerformers = withMetrics
    .filter(c => (c.open_rate || 0) < 0.15)
    .slice(0, 2);

  const avgOpenRate = withMetrics.length
    ? (withMetrics.reduce((s, c) => s + (c.open_rate || 0), 0) / withMetrics.length)
    : 0;

  return {
    total:           campaigns.length,
    sent:            sent.length,
    active:          active.length,
    avg_open_rate:   Math.round(avgOpenRate * 1000) / 10,  // %
    top_performers:  topPerformers.map(c => ({
      name:       c.name,
      type:       c.campaign_type,
      open_rate:  Math.round((c.open_rate || 0) * 100) + '%',
      click_rate: Math.round((c.click_rate || 0) * 100) + '%',
    })),
    low_performers: lowPerformers.map(c => c.name),
  };
}

/**
 * Analyse tool reliability for planner context.
 */
function analyseToolStats(stats) {
  if (!Object.keys(stats).length) return null;
  const unstable = [];
  const reliable = [];

  for (const [toolId, stat] of Object.entries(stats)) {
    const total       = stat.call_count || 0;
    if (total < 3) continue;
    const successRate = (total - (stat.error_count || 0)) / total;
    if (successRate < 0.4) unstable.push({ tool: toolId, rate: Math.round(successRate * 100) });
    if (successRate > 0.9 && total >= 10) reliable.push(toolId);
  }
  return { unstable, reliable };
}

/**
 * Compute and store campaign + tool insights.
 * Non-blocking — errors are caught and logged.
 * Pre-Intervention 0: ws_id parameter added.
 */
async function refreshInsights(wp_url, wp_secret, ws_id = 1) {
  if (!wp_url) return null;

  const key = memKey(ws_id);
  // Check cache — skip if computed recently
  try {
    const cached = await redis.get(key + ':ts').catch(() => null)
    if (cached && (Date.now() / 1000 - parseInt(cached)) < CACHE_TTL) {
      console.log(`[campaign-learning] Insights current for ws ${ws_id} — skip refresh`);
      return null;
    }
  } catch (_) {}

  console.log(`[campaign-learning] Refreshing insights for ws ${ws_id}...`);
  const [campaigns, toolStats] = await Promise.allSettled([
    fetchCampaigns(wp_url, wp_secret),
    fetchToolStats(wp_url, wp_secret),
  ]);

  const campaignData = campaigns.status === 'fulfilled' ? campaigns.value : [];
  const toolData     = toolStats.status === 'fulfilled'  ? toolStats.value  : {};

  const insights = {
    ws_id,
    refreshed_at:  Math.floor(Date.now() / 1000),
    campaigns:     analyseCampaigns(campaignData),
    tools:         analyseToolStats(toolData),
  };

  try {
    await redis.set(key,       JSON.stringify(insights), 'EX', MEM_TTL).catch(() => {})
    await redis.set(key + ':ts', String(Math.floor(Date.now() / 1000)), 'EX', MEM_TTL).catch(() => {})
    console.log(`[campaign-learning] Insights stored for ws ${ws_id}`);
  } catch (e) {
    console.error('[campaign-learning] Redis write failed:', e.message);
  }
  return insights;
}

/**
 * Read current campaign insights from memory.
 * Pre-Intervention 0: ws_id parameter added.
 */
async function readInsights(ws_id = 1) {
  try {
    const raw = await redis.get(memKey(ws_id)).catch(() => null)
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

/**
 * Format campaign insights as prompt block for meeting briefing.
 */
function formatCampaignInsights(insights) {
  if (!insights) return '';
  const parts = ['CAMPAIGN PERFORMANCE INSIGHTS (from live data):'];

  const c = insights.campaigns;
  if (c) {
    parts.push(`  Campaigns: ${c.total} total, ${c.sent} sent, ${c.active} active. Avg open rate: ${c.avg_open_rate}%.`);
    if (c.top_performers?.length) {
      parts.push(`  Top performing: ${c.top_performers.map(p => `${p.name} (${p.open_rate} open)`).join(', ')}.`);
    }
    if (c.low_performers?.length) {
      parts.push(`  Underperforming: ${c.low_performers.join(', ')} — review or pause.`);
    }
  }

  const t = insights.tools;
  if (t?.unstable?.length) {
    parts.push(`  Tool warnings: ${t.unstable.map(u => `${u.tool} (${u.rate}% success)`).join(', ')} — use alternatives.`);
  }

  if (parts.length <= 1) return '';
  parts.push('Use these findings to ground recommendations in actual performance, not assumptions.');
  return parts.join('\n');
}

module.exports = { refreshInsights, readInsights, formatCampaignInsights };
