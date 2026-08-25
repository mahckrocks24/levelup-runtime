'use strict';

/**
 * LevelUp — Growth Insights Engine
 * Phase 9: Proactive insight generation from SEO gaps, campaign performance,
 *          site content gaps, and competitor activity.
 *
 * Insights stored: lu:mem:growth_insights:1  TTL: 12h
 * Exposed via: GET /internal/insights/current
 *              POST /internal/insights/refresh
 */

const { createRedisConnection } = require('./redis');
const redis = createRedisConnection();

// Pre-Intervention 0: per-workspace keys. Legacy callers default to 1.
const insightsKey = (ws_id = 1) => `lu:mem:growth_insights:${ws_id}`;
const campaignKey = (ws_id = 1) => `lu:mem:ws:${ws_id}:campaign_insights`;
const INSIGHTS_TTL  = 12 * 60 * 60;   // 12 hours

// ── Data fetchers ─────────────────────────────────────────────────────────

async function fetchJson(url, secret, timeout = 8000) {
  const res = await fetch(url, {
    headers: { 'X-LU-Secret': secret || '', Accept: 'application/json' },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchSiteGaps(wp_url, secret) {
  try {
    const data = await fetchJson(`${process.env.LARAVEL_BASE_URL || process.env.LARAVEL_URL || wp_url}/api/internal/site/pages?limit=50`, secret);
    const pages = data.pages || [];
    const gaps  = [];

    // Detect thin pages (< 300 words)
    const thinPages = pages.filter(p => (p.word_count || 0) < 300 && p.word_count > 0);
    if (thinPages.length) {
      gaps.push({
        type:    'thin_content',
        count:   thinPages.length,
        pages:   thinPages.slice(0, 3).map(p => p.title || p.url),
        action:  'Expand these pages to 500+ words with keyword-rich content.',
        priority: 'high',
      });
    }

    // Detect pages missing meta description
    const noMeta = pages.filter(p => !p.meta_description);
    if (noMeta.length) {
      gaps.push({
        type:    'missing_meta',
        count:   noMeta.length,
        pages:   noMeta.slice(0, 3).map(p => p.title || p.url),
        action:  'Add meta descriptions (150 chars, include target keyword).',
        priority: 'medium',
      });
    }

    return gaps;
  } catch (_) { return []; }
}

async function fetchCampaignGaps(wp_url, secret) {
  try {
    const data = await fetchJson(`${process.env.LARAVEL_BASE_URL || process.env.LARAVEL_URL || wp_url}/api/internal/campaigns?limit=30`, secret);
    const camps = (data.campaigns || []).filter(c => c.status === 'sent');
    if (!camps.length) return [];

    const gaps = [];
    const lowOpen  = camps.filter(c => (c.open_rate  || 0) < 0.15);
    const lowClick = camps.filter(c => (c.click_rate || 0) < 0.02 && (c.open_rate || 0) > 0.2);

    if (lowOpen.length) {
      gaps.push({
        type:    'low_open_rate',
        count:   lowOpen.length,
        names:   lowOpen.slice(0, 2).map(c => c.name),
        action:  'A/B test subject lines; experiment with personalisation and send time.',
        priority: 'high',
      });
    }
    if (lowClick.length) {
      gaps.push({
        type:    'low_click_rate',
        count:   lowClick.length,
        names:   lowClick.slice(0, 2).map(c => c.name),
        action:  'Strengthen CTAs; ensure email content matches landing page promise.',
        priority: 'medium',
      });
    }
    return gaps;
  } catch (_) { return []; }
}

async function fetchCRMGaps(wp_url, secret) {
  try {
    const data = await fetchJson(`${process.env.LARAVEL_BASE_URL || process.env.LARAVEL_URL || wp_url}/api/internal/crm/leads?limit=50`, secret);
    const leads = data.leads || [];
    const gaps  = [];

    // Leads stuck in first stage for too long
    const stale = leads.filter(l => {
      if (!l.created_at) return false;
      const ageDays = (Date.now() - new Date(l.created_at).getTime()) / 86400000;
      return ageDays > 14 && l.stage_order <= 1;
    });
    if (stale.length) {
      gaps.push({
        type:    'stale_leads',
        count:   stale.length,
        action:  `${stale.length} leads stuck in early stage for 14+ days. Enrol in nurture sequence or reassign.`,
        priority: 'high',
      });
    }
    return gaps;
  } catch (_) { return []; }
}

// ── Insight generation ────────────────────────────────────────────────────

async function generateInsights(wp_url, secret, ws_id = 1) {
  if (!wp_url) return null;

  console.log(`[growth-insights] Generating proactive insights for ws ${ws_id}...`);
  const t0 = Date.now();

  // Parallel gap detection
  const [siteGaps, campaignGaps, crmGaps] = await Promise.allSettled([
    fetchSiteGaps(wp_url, secret),
    fetchCampaignGaps(wp_url, secret),
    fetchCRMGaps(wp_url, secret),
  ]);

  const allGaps = [
    ...(siteGaps.status     === 'fulfilled' ? siteGaps.value     : []),
    ...(campaignGaps.status === 'fulfilled' ? campaignGaps.value : []),
    ...(crmGaps.status      === 'fulfilled' ? crmGaps.value      : []),
  ].sort((a, b) => (a.priority === 'high' ? -1 : 1));

  // Priority opportunities (high gaps become suggested actions)
  const opportunities = allGaps
    .filter(g => g.priority === 'high')
    .map(g => g.action)
    .slice(0, 5);

  const insights = {
    ws_id,
    generated_at:  Math.floor(Date.now() / 1000),
    duration_ms:   Date.now() - t0,
    gap_count:     allGaps.length,
    gaps:          allGaps,
    opportunities,
    summary: allGaps.length
      ? `${allGaps.length} growth gaps detected. Top priority: ${opportunities[0] || 'none'}`
      : 'No significant gaps detected — platform is performing well.',
  };

  try {
    await redis.set(insightsKey(ws_id), JSON.stringify(insights), 'EX', INSIGHTS_TTL).catch(() => {})
    console.log(`[growth-insights] ws ${ws_id}: ${allGaps.length} gaps, ${opportunities.length} opportunities stored`);
  } catch (e) {
    console.error('[growth-insights] Redis write:', e.message);
  }
  return insights;
}

async function readInsights(ws_id = 1) {
  try {
    const raw = await redis.get(insightsKey(ws_id)).catch(() => null)
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

/**
 * Format growth insights for meeting briefing injection.
 */
function formatGrowthInsights(insights) {
  if (!insights || !insights.gaps?.length) return '';
  const lines = ['PROACTIVE GROWTH INSIGHTS (auto-detected):'];
  const high   = insights.gaps.filter(g => g.priority === 'high').slice(0, 3);
  const medium = insights.gaps.filter(g => g.priority === 'medium').slice(0, 2);
  for (const g of high)   lines.push(`  🔴 ${g.action}`);
  for (const g of medium) lines.push(`  🟡 ${g.action}`);
  if (insights.opportunities?.length) {
    lines.push(`Top recommended action: ${insights.opportunities[0]}`);
  }
  return lines.join('\n');
}

module.exports = { generateInsights, readInsights, formatGrowthInsights };
