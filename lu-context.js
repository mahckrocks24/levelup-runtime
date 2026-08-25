/**
 * LevelUp — Workspace Context Injection
 *
 * Before any task executes, this module assembles the full workspace
 * context from two sources:
 *
 *   1. WordPress options  — fetched via GET /wp-json/lu/v1/workspace/context
 *      Contains: business_name, industry, goals, brand_voice, target_audience,
 *                services, website_url, business_desc
 *
 *   2. Redis long-term memory — augments WP data with runtime-learned context
 *      Contains: past_campaigns, learned_tone, custom fields from agents
 *
 * The assembled context is injected into:
 *   - Task planning (lu-planner.js)
 *   - Task execution params
 *   - LLM synthesis prompt
 *   - Reasoning trace
 *
 * Context is cached in Redis for 15 minutes to avoid hammering WP REST.
 */

'use strict';

const https = require('https');
const http  = require('http');
const { URL } = require('url');
const { redis } = require('./lu-lifecycle');
const { longTermReadAll, longTermWriteAll } = require('./lu-memory');

// Pre-Intervention 0: cache key is now per-workspace.
// Legacy callers that pass no ws_id default to 1 to preserve old behavior.
const cacheKey = (ws_id = 1) => `lu:ctx:workspace:${ws_id}`;
const CONTEXT_CACHE_TTL = 15 * 60;   // 15 minutes

// ─────────────────────────────────────────────────────────────────────
// HTTP GET helper (reuse pattern from tool-executor, read-only)
// ─────────────────────────────────────────────────────────────────────

function httpGet(url_string, headers, timeout_ms = 10_000) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url_string);
    const isHttps = parsed.protocol === 'https:';
    const lib     = isHttps ? https : http;

    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      headers,
      timeout:  timeout_ms,
    };

    const req = lib.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: { raw } }); }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error(`Context fetch timeout`)); });
    req.on('error', reject);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────
// FETCH FROM WORDPRESS
// ─────────────────────────────────────────────────────────────────────

async function fetchWPContext(wp_url, wp_secret, ws_id = 1) {
  if (!wp_url) {
    console.warn('[lu-context] WP_URL not set — returning empty context');
    return {};
  }
  try {
    const endpoint = `${(process.env.LARAVEL_BASE_URL || process.env.LARAVEL_URL || wp_url).replace(/\/$/, '')}/api/internal/workspace/${ws_id}/context`;
    const res = await httpGet(endpoint, {
      'X-LU-Secret': wp_secret || '',
      'Accept':      'application/json',
    });
    if (res.status === 200 && res.body && !res.body.error) {
      return res.body;
    }
  } catch (e) {
    console.warn('[context] WP context fetch failed:', e.message);
  }
  return {};
}

// ─────────────────────────────────────────────────────────────────────
// ASSEMBLE CONTEXT
// ─────────────────────────────────────────────────────────────────────

/**
 * Assemble full workspace context.
 *
 * Priority: Redis cache > WP REST + Redis long-term merge
 *
 * @param {string} wp_url
 * @param {string} wp_secret
 * @param {boolean} force_refresh — bypass cache
 * @returns {Promise<object>} context
 */
async function getWorkspaceContext(wp_url, wp_secret, force_refresh = false, ws_id = 1) {
  // Pre-Intervention 0: ws_id parameter added. Default 1 preserves legacy behavior.
  const ck = cacheKey(ws_id);
  // Check cache first
  if (!force_refresh) {
    try {
      const cached = await redis.get(ck);
      if (cached) return JSON.parse(cached);
    } catch (_) {}
  }

  // Fetch from WP and Redis in parallel
  const [wp_context, redis_context] = await Promise.all([
    fetchWPContext(wp_url, wp_secret, ws_id),
    longTermReadAll(ws_id),
  ]);

  // Merge: WP is authoritative for core fields; Redis adds enrichment
  const context = {
    // Core identity (from WP)
    business_name:   wp_context.business_name   || redis_context.business_name   || '',
    industry:        wp_context.industry         || redis_context.industry         || '',
    business_desc:   wp_context.business_desc    || redis_context.business_desc    || '',
    website_url:     wp_context.website_url      || redis_context.website_url      || '',
    location:        wp_context.location         || redis_context.location         || '',

    // Brand & audience (from WP, enriched by Redis)
    brand_voice:     wp_context.brand_voice      || redis_context.brand_voice      || '',
    target_audience: wp_context.target_audience  || redis_context.target_audience  || '',
    services:        wp_context.services         || redis_context.services         || [],
    goals:           wp_context.goals            || redis_context.goals            || '',
    competitors:     wp_context.competitors      || redis_context.competitors      || '',

    // Runtime-enriched fields (Redis only)
    past_campaigns:  redis_context.past_campaigns || [],
    learned_tone:    redis_context.learned_tone   || null,
    custom:          redis_context.custom         || {},

    // Metadata
    assembled_at: Math.floor(Date.now() / 1000),
  };

  // Write back to Redis long-term memory (keeps it synced with WP)
  if (Object.values(wp_context).some(v => v)) {
    await longTermWriteAll(wp_context, ws_id).catch(() => {});
  }

  // Cache for 15 minutes
  try {
    await redis.set(ck, JSON.stringify(context), 'EX', CONTEXT_CACHE_TTL);
  } catch (_) {}

  return context;
}

/**
 * Invalidate the context cache (call after workspace settings update).
 * Pre-Intervention 0: ws_id parameter added. Default 1 preserves legacy behavior.
 */
async function invalidateContextCache(ws_id = 1) {
  await redis.del(cacheKey(ws_id));
}

/**
 * Build a concise context string for LLM prompt injection.
 * Keeps token count low while preserving essential identity.
 */
function buildContextPrompt(context) {
  if (!context || !context.business_name) return '';

  const lines = [];
  lines.push(`Business: ${context.business_name}`);
  if (context.industry)         lines.push(`Industry: ${context.industry}`);
  if (context.location)         lines.push(`Location: ${context.location}`);
  if (context.business_desc)    lines.push(`Description: ${context.business_desc}`);
  if (context.website_url)      lines.push(`Website: ${context.website_url}`);

  const services = Array.isArray(context.services) ? context.services : [];
  if (services.length) {
    lines.push(`Services:\n${services.map(s => `  • ${s}`).join('\n')}`);
  }

  if (context.target_audience)  lines.push(`Target market: ${context.target_audience}`);
  if (context.brand_voice)      lines.push(`Brand voice: ${context.brand_voice}`);
  if (context.competitors)      lines.push(`Competitors: ${context.competitors}`);
  if (context.goals)            lines.push(`Goals: ${context.goals}`);

  return lines.length ? `[WORKSPACE CONTEXT]\n${lines.join('\n')}\n[/WORKSPACE CONTEXT]\n` : '';
}

module.exports = {
  getWorkspaceContext,
  invalidateContextCache,
  buildContextPrompt,
};
