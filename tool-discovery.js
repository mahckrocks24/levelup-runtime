'use strict';

/**
 * LevelUp — Tool Discovery Engine
 * Part 4: Automatically discovers tools from WP REST routes and plugin metadata.
 *
 * Flow:
 *   scanPlatformTools()
 *   → fetches /wp-json from WordPress (lists all registered namespaces + routes)
 *   → filters to lu* namespaces (lugs, lucrm, lumkt, lusocial, lucal, lubld, lu/v1)
 *   → for each route: derives tool_id, method, params, domain
 *   → cross-references against known tool-registry.js entries
 *   → returns: { known, new, total }
 *
 * autoRegister(tool):
 *   → adds dynamically discovered tool to runtime registry
 *   → assigns capability based on domain → agent role mapping
 */

const { getTool, listAll } = require('./tool-registry');
const { hasCapability }    = require('./capability-map');
const launchScope          = require('./launch-scope');

// ── Domain → agent role mapping (no hardcoded names — uses role identifiers) ─
//
// LAUNCH SCOPE (2026-07-21, v2.37.3): `social` and `marketing` map to NO agent.
// Discovery walks the live WP REST manifest and auto-registers anything it
// finds, so an un-filtered `lusocial`/`lumkt` namespace was a live route back
// to removed capability — it could re-attach social/email tools to agents at
// runtime, after the static registry had been cleaned. Empty owner lists mean
// anything discovered in those namespaces is owned by nobody and selectable by
// nobody; the hard filter in scanPlatformTools() drops it outright.
const DOMAIN_AGENT_MAP = {
  seo:       ['james', 'alex'],   // SEO Strategist + Technical SEO
  content:   ['priya', 'james'],  // Content Manager + SEO
  social:    [],                  // OUT OF LAUNCH SCOPE — no owner
  crm:       ['elena', 'dmm'],    // CRM Specialist + DMM
  marketing: [],                  // OUT OF LAUNCH SCOPE — no owner
  calendar:  ['elena', 'dmm'],    // CRM/Calendar
  builder:   ['priya', 'dmm', 'alex'], // Builder tools
  site:      ['alex', 'james'],   // Technical SEO
  funnel:    ['dmm', 'elena'],    // DMM + CRM
  analytics: ['james', 'dmm'],    // Data analysis
  general:   ['dmm'],             // Default to DMM
};

// Domains whose entire surface is out of launch scope — nothing discovered in
// them may be registered, regardless of the derived tool id.
const OUT_OF_SCOPE_DOMAINS = new Set(['social', 'marketing']);

// ── Namespace → domain map ────────────────────────────────────────────────────
const NAMESPACE_DOMAIN = {
  'lugs':    'seo',
  'lucrm':   'crm',
  'lumkt':   'marketing',
  'lusocial':'social',
  'lucal':   'calendar',
  'lubld':   'builder',
  'lu':      'general',
};

// ── Dynamic registry (discovered tools not in static registry) ───────────────
const _dynamicTools = new Map();
let   _lastScan     = 0;
const SCAN_INTERVAL = 30 * 60 * 1000; // rescan every 30 min

/**
 * Derive a tool_id from a REST path.
 * e.g. /lubld/v1/pages/:id/publish → publish_page
 */
function deriveToodId(namespace, path, method) {
  // Strip namespace prefix + version
  const clean = path.replace(/^\/?(lu\w+)\/v\d+\/?/, '').replace(/^\/?/, '');
  const parts = clean.split('/').filter(Boolean);

  // Remove path params like :id, (?P<id>\d+)
  const segments = parts.filter(p => !p.startsWith(':') && !p.startsWith('(?'));

  if (!segments.length) return null;

  const resource = segments[0]; // e.g. 'campaigns'
  const action   = segments.slice(1).join('_'); // e.g. 'schedule', 'analytics'

  if (!action) {
    // Root resource
    if (method === 'GET')    return `list_${resource}`;
    if (method === 'POST')   return `create_${resource.replace(/s$/, '')}`;
    return null;
  }

  return `${action}_${resource.replace(/s$/, '')}`;
}

/**
 * Fetch the WordPress REST route manifest and extract lu* routes.
 */
async function fetchWPRoutes(wp_url, wp_secret) {
  if (!wp_url) return [];
  try {
    const res = await fetch(`${wp_url}/wp-json/`, {
      headers: { 'X-LU-Secret': wp_secret || '', Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const routes = data.routes || {};

    const discovered = [];
    for (const [path, routeInfo] of Object.entries(routes)) {
      // Only lu* namespaces
      const nsMatch = path.match(/^\/(lu\w*?)\/v(\d+)\//);
      if (!nsMatch) continue;
      const namespace = nsMatch[1];
      const domain    = NAMESPACE_DOMAIN[namespace] || 'general';

      const endpoints = routeInfo.endpoints || [];
      for (const ep of endpoints) {
        const methods = ep.methods || [];
        for (const method of methods) {
          // Skip OPTIONS, PUT (usually paired with POST for updates)
          if (['OPTIONS'].includes(method)) continue;

          // Build parameter list from args
          const params = {};
          for (const [key, arg] of Object.entries(ep.args || {})) {
            params[key] = {
              type:        arg.type || 'string',
              required:    arg.required || false,
              description: arg.description || key,
            };
          }

          discovered.push({
            path, method, namespace, domain, params,
            has_id_param: path.includes(':id') || path.includes('(?P<id>'),
          });
        }
      }
    }
    return discovered;
  } catch (e) {
    console.warn('[tool-discovery] Route fetch failed:', e.message);
    return [];
  }
}

/**
 * Scan platform and return new tools not in the current registry.
 */
async function scanPlatformTools(wp_url, wp_secret) {
  const now = Date.now();
  if (now - _lastScan < SCAN_INTERVAL && _dynamicTools.size > 0) {
    return {
      known:   listAll().length,
      dynamic: [..._dynamicTools.values()],
      new:     0,
      cached:  true,
    };
  }

  console.log('[tool-discovery] Scanning WP REST routes...');
  const wpRoutes  = await fetchWPRoutes(wp_url, wp_secret);
  const knownIds  = new Set(listAll().map(t => t.id));
  const newTools  = [];

  let skippedOutOfScope = 0;
  for (const route of wpRoutes) {
    const tool_id = deriveToodId(route.namespace, route.path, route.method);
    if (!tool_id)             continue;
    if (knownIds.has(tool_id)) continue;  // already in static registry
    if (_dynamicTools.has(tool_id)) continue; // already discovered this session

    // ── LAUNCH SCOPE GATE ──
    // Drop anything in an out-of-scope domain, anything whose derived id is a
    // removed tool, and anything that would end up with no eligible owner.
    if (OUT_OF_SCOPE_DOMAINS.has(route.domain) || launchScope.isRemovedTool(tool_id)) {
      skippedOutOfScope++;
      continue;
    }

    const agents = launchScope.filterAgentIds(DOMAIN_AGENT_MAP[route.domain] || DOMAIN_AGENT_MAP.general);
    if (!agents.length) { skippedOutOfScope++; continue; }
    const tool   = {
      id:          tool_id,
      domain:      route.domain,
      name:        tool_id.split('_').map(w => w[0].toUpperCase() + w.slice(1)).join(' '),
      description: `Auto-discovered: ${route.method} ${route.path}`,
      wp_path:     route.path.replace(/\(\?P<(\w+)>\\d\+\)/g, ':$1'),
      method:      route.method,
      url_params:  route.has_id_param ? ['id'] : [],
      params:      route.params,
      returns:     '{ success, data }',
      requires_approval: route.method !== 'GET', // GET = safe, mutations need approval
      allowed_agents: agents,
      auto_discovered: true,
      discovered_at:   new Date().toISOString(),
    };

    _dynamicTools.set(tool_id, tool);
    newTools.push(tool);
    console.log(`[tool-discovery] New tool: ${tool_id} (${route.domain}, ${route.method})`);
  }

  _lastScan = now;
  if (skippedOutOfScope) {
    console.log(`[tool-discovery] Launch scope: skipped ${skippedOutOfScope} out-of-scope route(s)`);
  }
  return {
    known:   knownIds.size,
    dynamic: [..._dynamicTools.values()],
    new:     newTools.length,
    skipped_out_of_scope: skippedOutOfScope,
    cached:  false,
  };
}

/**
 * Get all tools: static registry + dynamically discovered.
 */
function getAllTools(agentId) {
  if (launchScope.isRemovedAgent(agentId)) return []; // removed agent owns nothing

  const staticTools  = agentId
    ? require('./tool-registry').getToolsForAgent(agentId)
    : listAll();

  const dynamicAll = [..._dynamicTools.values()].filter(t => !launchScope.isRemovedTool(t.id));

  if (!agentId) return [...staticTools, ...dynamicAll];

  const dynamic = dynamicAll.filter(t => (t.allowed_agents || []).includes(agentId));
  return [...staticTools, ...dynamic];
}

/**
 * Format newly discovered tools for prompt injection.
 */
function formatDiscoveredToolsBlock(agentId) {
  if (launchScope.isRemovedAgent(agentId)) return '';
  const dynamic = [..._dynamicTools.values()].filter(t =>
    !launchScope.isRemovedTool(t.id) && (t.allowed_agents || []).includes(agentId)
  );
  if (!dynamic.length) return '';

  const lines = ['NEWLY DISCOVERED TOOLS (auto-detected from platform):'];
  for (const t of dynamic.slice(0, 5)) {
    lines.push(`  TOOL: ${t.id}`);
    lines.push(`  PURPOSE: ${t.description}`);
    lines.push(`  METHOD: ${t.method} ${t.wp_path}`);
    if (Object.keys(t.params).length) {
      lines.push(`  PARAMS: ${Object.keys(t.params).join(', ')}`);
    }
    lines.push(`  ${t.requires_approval ? '⚠ Requires approval' : '✓ Auto-executes'}`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Get dynamic tools for a specific agent (for capability check).
 */
function getDynamicToolsForAgent(agentId) {
  if (launchScope.isRemovedAgent(agentId)) return [];
  return [..._dynamicTools.values()].filter(t =>
    !launchScope.isRemovedTool(t.id) && (t.allowed_agents || []).includes(agentId)
  );
}

module.exports = {
  scanPlatformTools,
  getAllTools,
  formatDiscoveredToolsBlock,
  getDynamicToolsForAgent,
  DOMAIN_AGENT_MAP,
  OUT_OF_SCOPE_DOMAINS,
};
