'use strict';

/**
 * LevelUp — Site Context Module
 * Phase 3: Automatic website content injection into meetings and assistant.
 *
 * Fetches recently scanned pages from WP and builds a summary for prompt injection.
 * Agents stop being content-blind when site data is available.
 *
 * Redis cache: lu:site:context:1  TTL: 30 minutes
 */

const { createRedisConnection } = require('./redis');
const redis = createRedisConnection();

const CACHE_KEY = 'lu:site:context:1';
const CACHE_TTL = 30 * 60;  // 30 min

/**
 * Fetch site page summaries from WP REST.
 * Returns top pages by word count: homepage, services, key landing pages.
 */
async function fetchSiteContext(wp_url, wp_secret) {
  if (!wp_url) return null;

  // Check cache
  try {
    const cached = await redis.get(CACHE_KEY).catch(() => null)
    if (cached) return JSON.parse(cached);
  } catch (_) {}

  try {
    const res = await fetch(`${process.env.LARAVEL_BASE_URL || process.env.LARAVEL_URL || wp_url}/api/internal/site/pages?limit=20`, {
      headers: { 'X-LU-Secret': wp_secret || '', Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const pages = data.pages || [];

    if (!pages.length) return null;

    // Build context: sort by word count desc, keep top 10
    const sorted = [...pages].sort((a, b) => (b.word_count || 0) - (a.word_count || 0));
    const context = {
      total_pages: pages.length,
      last_scanned: data.last_scanned || null,
      top_pages: sorted.slice(0, 8).map(p => ({
        url:              p.url,
        title:            p.title || '(no title)',
        meta_description: p.meta_description || '',
        word_count:       p.word_count || 0,
      })),
    };

    // Cache
    await redis.set(CACHE_KEY, JSON.stringify(context), 'EX', CACHE_TTL).catch(() => {})
    return context;
  } catch (e) {
    console.warn('[site-context] fetch failed:', e.message);
    return null;
  }
}

/**
 * Invalidate site context cache (call after a scan completes).
 */
async function invalidateSiteCache() {
  try { await redis.del(CACHE_KEY); } catch (_) {}
}

/**
 * Format site context as a prompt block.
 * Injected into meeting briefing and specialist prompts when site data exists.
 */
function formatSiteContext(siteCtx) {
  if (!siteCtx || !siteCtx.top_pages?.length) {
    return '(No website pages scanned yet. Ask agents to call get_site_pages or scan_site_url to read the website.)';
  }

  const pageLines = siteCtx.top_pages.map(p => {
    const desc = p.meta_description ? ` — ${p.meta_description.slice(0, 100)}` : '';
    return `  • ${p.title}${desc} [${p.word_count} words] (${p.url})`;
  }).join('\n');

  return [
    `WEBSITE CONTENT SUMMARY (${siteCtx.total_pages} pages scanned):`,
    pageLines,
    '',
    'Before recommending new content or pages, check if existing pages already cover the topic.',
    'Use search_site_content(q="topic") or get_site_page(id=X) to read full page content.',
  ].join('\n');
}

/**
 * Quick site summary for briefing prompt (shorter version).
 */
function formatSiteSummaryBrief(siteCtx) {
  if (!siteCtx || !siteCtx.top_pages?.length) return '';
  const pages = siteCtx.top_pages.slice(0, 5).map(p => p.title).join(', ');
  return `Website pages scanned: ${siteCtx.total_pages} total. Key pages: ${pages}. Agents can use get_site_pages() and search_site_content() to read actual page content.`;
}

module.exports = { fetchSiteContext, invalidateSiteCache, formatSiteContext, formatSiteSummaryBrief };
