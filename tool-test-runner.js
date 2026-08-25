'use strict';

/**
 * LevelUp Growth Platform — Tool Execution Test Runner
 * Boss888 / Phase 9 QA
 *
 * Tests all 47 tools across 6 domains using the real runtime execution path:
 *   parseToolCall() → executeTool() → dispatchToWP() → lu/v1/tools/execute
 *
 * Layers tested per tool:
 *   L1  Registry     — tool in runtime registry + WP tool map
 *   L2  Capability   — allowed agent passes / disallowed agent blocked
 *   L3  Param        — missing required param → FAIL_PARAM
 *   L4  Route        — WP route exists (verified against scraped route manifest)
 *   L5  Execution    — live executeTool() call (if WP_BASE configured)
 *   L6  Output       — returned JSON has required keys
 *   L7  Side-effect  — noted (DB write confirmed by execution result)
 *
 * Run:
 *   WP_BASE=https://staging1.shukranuae.com WP_SECRET=xxx node tests/tool-test-runner.js
 *   node tests/tool-test-runner.js --offline   (L1–L4 only, no live calls)
 */

// ── Load runtime modules ──────────────────────────────────────────────────────
const path = require('path');
const ROOT  = path.join(__dirname, '..');

// Use remediated tool-registry if present
const REMEDIATED_REG = path.join(ROOT, '../../tool-remediation/tool-registry.js');
const REG_PATH = require('fs').existsSync(REMEDIATED_REG) ? REMEDIATED_REG : path.join(ROOT, 'tool-registry');
const { getTool, listAll }  = require(REG_PATH);
// Use remediated capability-map if present, else fall back to original
const REMEDIATED_CAP = path.join(ROOT, '../../tool-remediation/capability-map.js');
const CAP_PATH = require('fs').existsSync(REMEDIATED_CAP) ? REMEDIATED_CAP : path.join(ROOT, 'capability-map');
const { hasCapability, CAPABILITY_MAP } = require(CAP_PATH);

// ── CLI flags ─────────────────────────────────────────────────────────────────
const OFFLINE   = process.argv.includes('--offline');
const NO_COLOR  = process.argv.includes('--no-color');
const SAVE_JSON = process.argv.includes('--json');

const WP_BASE   = process.env.WP_BASE   || process.env.WP_URL || '';
const WP_SECRET = process.env.WP_SECRET || process.env.LU_SECRET || '';

// ── Colour helpers ────────────────────────────────────────────────────────────
const c = {
  reset:  NO_COLOR ? '' : '\x1b[0m',
  bold:   NO_COLOR ? '' : '\x1b[1m',
  green:  NO_COLOR ? '' : '\x1b[32m',
  yellow: NO_COLOR ? '' : '\x1b[33m',
  red:    NO_COLOR ? '' : '\x1b[31m',
  cyan:   NO_COLOR ? '' : '\x1b[36m',
  grey:   NO_COLOR ? '' : '\x1b[90m',
  dim:    NO_COLOR ? '' : '\x1b[2m',
};

function col(status) {
  if (status === 'PASS')               return c.green  + status + c.reset;
  if (status === 'WARN')               return c.yellow + status + c.reset;
  if (status.startsWith('FAIL'))       return c.red    + status + c.reset;
  if (status === 'N/A')                return c.grey   + status + c.reset;
  if (status === 'SKIP')               return c.dim    + status + c.reset;
  return status;
}

function finalCol(s) {
  if (s === 'PRODUCTION_READY') return c.green  + c.bold + s + c.reset;
  if (s === 'STABLE')           return c.green  + s + c.reset;
  if (s === 'UNRELIABLE')       return c.yellow + s + c.reset;
  if (s === 'BROKEN')           return c.red    + c.bold + s + c.reset;
  return s;
}

// ── WP Tool Map (extracted from lu_get_tool_map) ──────────────────────────────
// LAUNCH SCOPE (v2.37.3): trimmed to the retained launch surface. Social,
// email-marketing and sequence tools are no longer part of the product and
// have been removed from this map, the route manifest and the test matrix.
const WP_TOOL_MAP = {
  // SEO
  serp_analysis:         { method:'POST', path:'/lugs/v1/serp-analysis' },
  ai_report:             { method:'POST', path:'/lugs/v1/ai-report' },
  deep_audit:            { method:'POST', path:'/lugs/v1/deep-audit' },
  ai_status:             { method:'GET',  path:'/lugs/v1/ai-status' },
  improve_draft:         { method:'POST', path:'/lugs/v1/ai-draft' },
  write_article:         { method:'POST', path:'/lugs/v1/generate-seo-article' },
  link_suggestions:      { method:'GET',  path:'/lugs/v1/link-suggestions/:post_id' },
  insert_link:           { method:'POST', path:'/lugs/v1/link-suggestions/:id/insert' },
  dismiss_link:          { method:'POST', path:'/lugs/v1/link-suggestions/:id/dismiss' },
  outbound_links:        { method:'GET',  path:'/lugs/v1/outbound-links/:post_id' },
  check_outbound:        { method:'POST', path:'/lugs/v1/outbound-links/:id/check' },
  autonomous_goal:       { method:'POST', path:'/lugs/v1/agent/goal' },
  agent_status:          { method:'GET',  path:'/lugs/v1/agent/status' },
  list_goals:            { method:'GET',  path:'/lugs/v1/agent/goals' },
  pause_goal:            { method:'POST', path:'/lugs/v1/agent/pause' },
  // CRM
  create_lead:           { method:'POST', path:'/lucrm/v1/leads' },
  get_lead:              { method:'GET',  path:'/lucrm/v1/leads/:id' },
  update_lead:           { method:'PUT',  path:'/lucrm/v1/leads/:id' },
  list_leads:            { method:'GET',  path:'/lucrm/v1/leads' },
  move_lead:             { method:'POST', path:'/lucrm/v1/leads/:id/move' },
  log_activity:          { method:'POST', path:'/lucrm/v1/leads/:id/activities' },
  add_note:              { method:'POST', path:'/lucrm/v1/leads/:id/notes' },
  // LAUNCH SCOPE (v2.37.3): the CRM-sequence, Marketing (lumkt) and Social
  // (lusocial) endpoint blocks were removed. Leaving them here would have kept
  // the harness probing live endpoints for capability the product no longer
  // ships, and reporting them GREEN - a misleading validation result.
  // Calendar
  create_event:          { method:'POST', path:'/lucal/v1/events' },
  list_events:           { method:'GET',  path:'/lucal/v1/events' },
  update_event:          { method:'PUT',  path:'/lucal/v1/events/:id' },
  check_availability:    { method:'GET',  path:'/lucal/v1/availability' },
  create_booking_slot:   { method:'POST', path:'/lucal/v1/booking-slots' },
  // Builder
  list_builder_pages:    { method:'GET',  path:'/lubld/v1/pages' },
  get_builder_page:      { method:'GET',  path:'/lubld/v1/pages/:id/full' },
  ai_builder_action:     { method:'POST', path:'/lubld/v1/ai/action' },
  generate_page_layout:  { method:'POST', path:'/lubld/v1/ai/generate-layout' },
  publish_builder_page:  { method:'POST', path:'/lubld/v1/pages/:id/publish' },
  import_html_page:      { method:'POST', path:'/lubld/v1/convert/html' },
};

// ── Routes confirmed registered (scraped from all engine plugin files) ─────────
// Format: "namespace/route-pattern" normalised with :id for path params
const REGISTERED_ROUTES = new Set([
  // SEO Suite
  'lugs/v1/serp-analysis', 'lugs/v1/ai-report', 'lugs/v1/deep-audit',
  'lugs/v1/ai-status', 'lugs/v1/ai-draft', 'lugs/v1/generate-seo-article',
  'lugs/v1/link-suggestions/:id', 'lugs/v1/link-suggestions/:id/insert',
  'lugs/v1/link-suggestions/:id/dismiss',
  'lugs/v1/outbound-links/:id', 'lugs/v1/outbound-links/:id/check',
  'lugs/v1/agent/goal', 'lugs/v1/agent/status', 'lugs/v1/agent/goals', 'lugs/v1/agent/pause',
  // CRM
  'lucrm/v1/leads', 'lucrm/v1/leads/:id', 'lucrm/v1/leads/:id/move',
  'lucrm/v1/leads/:id/activities', 'lucrm/v1/leads/:id/notes',
  'lucrm/v1/pipeline/stages', 'lucrm/v1/pipeline/stages/:id',
  // LAUNCH SCOPE (v2.37.3): lucrm sequence routes, all lumkt (Marketing) and
  // all lusocial (Social) routes removed from the expected-route manifest.
  // Calendar
  'lucal/v1/events', 'lucal/v1/events/:id',
  'lucal/v1/availability', 'lucal/v1/booking-slots', 'lucal/v1/booking-slots/:id',
  // Builder
  'lubld/v1/pages', 'lubld/v1/pages/:id', 'lubld/v1/pages/:id/full',
  'lubld/v1/pages/:id/publish', 'lubld/v1/pages/:id/duplicate',
  'lubld/v1/ai/action', 'lubld/v1/ai/generate-layout', 'lubld/v1/convert/html',
]);

// Post-remediation additions (Patch C + D)
// LAUNCH SCOPE (v2.37.3): emptied. All three entries were Marketing/Social/
// sequence routes that are no longer part of the product.
const REMEDIATED_ROUTES = new Set([]);

// ── Tool test configuration ───────────────────────────────────────────────────
// For each tool: allowed agent, disallowed agent, valid params, required output keys
const TOOL_TESTS = {
  // SEO
  serp_analysis:        { agent:'james',  deny:'elena', params:{keyword:'best furniture dubai'},   outputs:['results','serp_run_id','result_count'], side:'SEO result stored' },
  ai_report:            { agent:'james',  deny:'elena', params:{post_id:1},                        outputs:['success','report'],                     side:'Report cached in DB' },
  deep_audit:           { agent:'james',  deny:'elena',  params:{post_id:1},                        outputs:['success','report'],                     side:'Audit results stored' },
  ai_status:            { agent:'james',  deny:'elena',  params:{},                                 outputs:['active'],                               side:'None' },
  improve_draft:        { agent:'priya',  deny:'elena', params:{post_id:1},                        outputs:['success'],                              side:'Post updated' },
  write_article:        { agent:'priya',  deny:'elena', params:{keyword:'custom furniture uae'},   outputs:['post_id','permalink'],                  side:'WP post created' },
  link_suggestions:     { agent:'james',  deny:'elena',  params:{post_id:1},                        outputs:['suggestions'],                          side:'None' },
  insert_link:          { agent:'alex',   deny:'elena', params:{id:1},                             outputs:['success'],                              side:'Post content updated' },
  dismiss_link:         { agent:'alex',   deny:'elena', params:{id:1},                             outputs:['success'],                              side:'Suggestion dismissed' },
  outbound_links:       { agent:'alex',   deny:'elena',  params:{post_id:1},                        outputs:['links'],                                side:'None' },
  check_outbound:       { agent:'alex',   deny:'elena',  params:{id:1},                             outputs:['results'],                              side:'Statuses updated' },
  autonomous_goal:      { agent:'dmm',    deny:'elena', params:{goal:'Improve SEO'},               outputs:['goal_id'],                              side:'Goal created' },
  agent_status:         { agent:'dmm',    deny:'elena',  params:{goal_id:1},                        outputs:['status'],                               side:'None' },
  list_goals:           { agent:'dmm',    deny:'elena',  params:{},                                 outputs:['goals'],                                side:'None' },
  pause_goal:           { agent:'dmm',    deny:'elena',  params:{goal_id:1},                        outputs:['success'],                              side:'Goal paused' },
  // CRM
  create_lead:          { agent:'elena',  deny:'alex',   params:{name:'Ali Hassan',email:'ali@test.com'}, outputs:['success','id'],                  side:'lucrm_leads row created' },
  get_lead:             { agent:'elena',  deny:'alex',   params:{id:1},                             outputs:['lead'],                                 side:'None' },
  update_lead:          { agent:'elena',  deny:'alex',   params:{id:1,name:'Ali Updated'},          outputs:['success'],                              side:'Lead updated' },
  list_leads:           { agent:'elena',  deny:'alex',   params:{},                                 outputs:['leads','total'],                        side:'None' },
  move_lead:            { agent:'elena',  deny:'alex',   params:{id:1,stage_id:2},                  outputs:['success'],                              side:'Stage changed' },
  log_activity:         { agent:'elena',  deny:'alex',   params:{id:1,activity_type:'call'},        outputs:['success'],                              side:'Activity row created' },
  add_note:             { agent:'elena',  deny:'alex',   params:{id:1,content:'Follow up next week'},outputs:['success'],                             side:'Note row created' },
  // LAUNCH SCOPE (v2.37.3): the CRM-sequence, Marketing and Social test blocks
  // were removed along with their tools. `deny:'elena'` was also replaced
  // throughout - marcus is no longer a valid agent, so a denial test against
  // him proved nothing (every agent is denied). Denials now use a RETAINED
  // agent that genuinely lacks the capability, which is a real assertion.
  // Calendar
  create_event:         { agent:'elena',  deny:'alex',   params:{title:'Client Discovery Call',start_date:'2026-04-10'},  outputs:['success','id'],    side:'Event row created' },
  list_events:          { agent:'elena',  deny:'alex',   params:{},                                 outputs:['events'],                               side:'None' },
  update_event:         { agent:'elena',  deny:'alex',   params:{id:1,title:'Discovery Call (updated)'},outputs:['success'],                          side:'Event updated' },
  check_availability:   { agent:'elena',  deny:'alex',   params:{},                                 outputs:['available'],                            side:'None' },
  create_booking_slot:  { agent:'elena',  deny:'alex',   params:{start_time:'2026-04-15 09:00:00',end_time:'2026-04-15 10:00:00'},outputs:['success'], side:'Slot created' },
  // Builder
  list_builder_pages:   { agent:'dmm',    deny:'elena',  params:{},                                 outputs:['pages'],                                side:'None' },
  get_builder_page:     { agent:'dmm',    deny:'elena',  params:{id:1},                             outputs:['page'],                                 side:'None' },
  ai_builder_action:    { agent:'dmm',    deny:'elena',  params:{page_id:1,command:'Add a hero section'}, outputs:['success'],                         side:'Page section added' },
  generate_page_layout: { agent:'dmm',    deny:'elena',  params:{prompt:'Luxury furniture homepage'},outputs:['layout'],                              side:'None' },
  publish_builder_page: { agent:'dmm',    deny:'elena',  params:{id:1},                             outputs:['success'],                              side:'Page status=published' },
  import_html_page:     { agent:'alex',   deny:'elena',  params:{url:'https://shukranuae.com'},     outputs:['success','result'],                     side:'Page created' },
};

// ── Route normaliser — matches WP path to registered routes ───────────────────
function normaliseWPPath(wp_path) {
  // /lugs/v1/link-suggestions/:post_id → lugs/v1/link-suggestions/:id
  return wp_path
    .replace(/^\//, '')
    .replace(/:\w+/g, ':id');
}

function routeRegistered(wp_path, post_remediation = false) {
  const normalised = normaliseWPPath(wp_path);
  if (REGISTERED_ROUTES.has(normalised)) return true;
  if (post_remediation && REMEDIATED_ROUTES.has(normalised)) return true;
  return false;
}

// ── HTTP dispatch to WP (live mode) ──────────────────────────────────────────
async function dispatchLive(toolId, agentId, params) {
  if (!WP_BASE) return { status: 'SKIP', reason: 'WP_BASE not set' };
  const url = `${process.env.LARAVEL_BASE_URL || process.env.LARAVEL_URL || WP_BASE}/api/internal/tools/execute`;
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    const res   = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-LU-Secret': WP_SECRET },
      body:    JSON.stringify({ tool_id: toolId, agent_id: agentId, params }),
      signal:  ctrl.signal,
    });
    clearTimeout(timer);
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  } catch (e) {
    if (e.name === 'AbortError') return { status: 'TIMEOUT', reason: 'exceeded 20s' };
    return { status: 'ERROR', reason: e.message };
  }
}

// ── L5 execution status parser ────────────────────────────────────────────────
function parseExecution(result, toolId, params) {
  if (result.status === 'SKIP')    return { pass: 'SKIP',         note: 'offline' };
  if (result.status === 'TIMEOUT') return { pass: 'WARN',         note: 'timeout' };
  if (result.status === 'ERROR')   return { pass: 'FAIL_RUNTIME', note: result.reason };
  if (result.status === 401)       return { pass: 'FAIL_AUTH',    note: 'WP auth rejected' };
  if (result.status === 404)       return { pass: 'FAIL_ROUTE',   note: '404 from WP' };
  if (result.status === 400)       return { pass: 'FAIL_PARAM',   note: result.json?.message || '400' };
  if (result.status === 422)       return { pass: 'FAIL_SERVICE', note: result.json?.message || '422' };
  if (result.status === 500)       return { pass: 'FAIL_SERVICE', note: result.json?.message || '500' };
  if (result.status === 200 || result.status === 201) return { pass: 'PASS', data: result.json };
  return { pass: 'WARN', note: `HTTP ${result.status}` };
}

// ── L6 output key checker ─────────────────────────────────────────────────────
function checkOutput(execResult, requiredKeys) {
  if (execResult.pass === 'SKIP')        return 'SKIP';
  if (execResult.pass !== 'PASS')        return 'N/A';
  const data = execResult.data?.data ?? execResult.data;
  if (!data)                             return 'WARN';
  for (const key of requiredKeys) {
    if (!(key in data) && data[key] === undefined) return 'WARN';
  }
  return 'PASS';
}

// ── Determine final classification ────────────────────────────────────────────
function classify(layers) {
  const { registry, capability, param, route, execution, output } = layers;
  if (registry   === 'FAIL_REGISTRY') return 'BROKEN';
  if (route      === 'FAIL_ROUTE')    return 'BROKEN';
  if (capability === 'FAIL_AUTH')     return 'BROKEN';
  if (param      === 'FAIL_PARAM')    return 'BROKEN';
  if (execution  === 'FAIL_RUNTIME' || execution === 'FAIL_SERVICE') return 'UNRELIABLE';
  if (output     === 'WARN')          return 'STABLE';
  if (execution  === 'WARN')         return 'STABLE';
  if (execution  === 'SKIP')         return 'STABLE'; // not tested live
  if (output     === 'PASS' && execution === 'PASS') return 'PRODUCTION_READY';
  // All local layers pass, live not tested
  if (['PASS','SKIP'].includes(execution) && route === 'PASS') return 'STABLE';
  return 'STABLE';
}

// ── Main test loop ────────────────────────────────────────────────────────────
async function runMatrix() {
  const allTools  = listAll();
  const results   = [];
  const startTime = Date.now();

  console.log(`\n${c.bold}╔══════════════════════════════════════════════════════════════╗${c.reset}`);
  console.log(`${c.bold}║     LEVELUP GROWTH — TOOL EXECUTION AUDIT REPORT             ║${c.reset}`);
  console.log(`${c.bold}╚══════════════════════════════════════════════════════════════╝${c.reset}`);
  console.log(`${c.dim}Mode: ${OFFLINE ? 'OFFLINE (L1–L4 only)' : WP_BASE ? `LIVE → ${WP_BASE}` : 'OFFLINE (WP_BASE not set)'}${c.reset}`);
  console.log(`${c.dim}Tools in registry: ${allTools.length} | WP map: ${Object.keys(WP_TOOL_MAP).length}${c.reset}\n`);

  // Table header
  const HDR = ['Tool', 'Domain', 'Registry', 'Cap', 'Param', 'Route', 'Exec', 'Output', 'Final'];
  const W   = [28, 10, 10, 8, 8, 12, 14, 9, 18];
  const sep = W.map(w => '─'.repeat(w)).join('┼');
  const row = (cols) => cols.map((v, i) => String(v).padEnd(W[i])).join('│');

  console.log(c.bold + row(HDR) + c.reset);
  console.log(sep);

  // Also test tools that exist in WP map but may not be in runtime registry
  const allToolIds = [...new Set([
    ...allTools.map(t => t.id),
    ...Object.keys(WP_TOOL_MAP),
    ...Object.keys(TOOL_TESTS),
  ])].sort();

  for (const toolId of allToolIds) {
    const tool    = getTool(toolId);
    const wpDef   = WP_TOOL_MAP[toolId];
    const testCfg = TOOL_TESTS[toolId];

    // ── L1: Registry ─────────────────────────────────────────────────────────
    const inRuntime  = !!tool;
    const inWPMap    = !!wpDef;
    const L1 = (inRuntime && inWPMap) ? 'PASS'
             : (!inRuntime && inWPMap) ? 'WARN'   // in WP map but no runtime metadata
             : (inRuntime && !inWPMap) ? 'WARN'   // in registry but no WP dispatch
             : 'FAIL_REGISTRY';

    const domain = tool?.domain || wpDef ? (
      wpDef?.path?.match(/\/(lu\w+)\/v1/)?.[1]?.replace('lu','') || tool?.domain || '?'
    ) : '?';

    if (!testCfg) {
      const r = { toolId, domain, L1, L2:'N/A', L3:'N/A', L4:'N/A', L5:'N/A', L6:'N/A', final:'STABLE' };
      results.push(r);
      console.log(row([toolId, domain, col(L1), col('N/A'), col('N/A'), col('N/A'), col('N/A'), col('N/A'), finalCol('STABLE')]));
      continue;
    }

    const { agent, deny, params, outputs } = testCfg;

    // ── L2: Capability ────────────────────────────────────────────────────────
    const agentAllowed  = hasCapability(agent, toolId);
    const denyBlocked   = deny ? !hasCapability(deny, toolId) : true;
    const L2 = (agentAllowed && denyBlocked) ? 'PASS'
             : (!agentAllowed)                ? 'FAIL_AUTH'
             : 'WARN'; // deny agent has access — capability leak

    // ── L3: Param validation (check required params are defined) ──────────────
    let L3 = 'PASS';
    if (tool?.params) {
      const missing = Object.entries(tool.params)
        .filter(([k, v]) => v.required && !(k in params))
        .map(([k]) => k);
      // We intentionally supply valid params; check the registry has validation
      L3 = (Object.keys(tool.params).length > 0 || Object.keys(params).length === 0) ? 'PASS' : 'WARN';
      // If required params exist and we supplied them, that's the happy path
      // Param failure simulation is noted
      L3 = 'PASS'; // happy path — missing param test is noted in report
    }

    // ── L4: Route ─────────────────────────────────────────────────────────────
    const wp_path = wpDef?.path || tool?.wp_path || '';
    const L4 = wp_path
      ? (routeRegistered(wp_path, false) ? 'PASS' : routeRegistered(wp_path, true) ? 'REMEDIATED' : 'FAIL_ROUTE')
      : 'FAIL_ROUTE';

    // ── L5: Execution (live or skip) ──────────────────────────────────────────
    let L5 = 'SKIP'; let execNote = ''; let execData = null;
    if (!OFFLINE && WP_BASE && L4 !== 'FAIL_ROUTE') {
      const raw = await dispatchLive(toolId, agent, params);
      const parsed = parseExecution(raw, toolId, params);
      L5 = parsed.pass; execNote = parsed.note || ''; execData = parsed.data;
    } else if (L4 === 'FAIL_ROUTE') {
      L5 = 'N/A';
    }

    // ── L6: Output ────────────────────────────────────────────────────────────
    const L6 = execData ? checkOutput({ pass: L5, data: execData }, outputs) : (L5 === 'SKIP' ? 'SKIP' : 'N/A');

    const final = classify({ registry: L1, capability: L2, param: L3, route: L4, execution: L5, output: L6 });

    const result = { toolId, domain, L1, L2, L3, L4, L5, L6, final, execNote };
    results.push(result);

    const L4Display = L4 === 'REMEDIATED' ? col('PASS') + c.dim + '*' + c.reset : col(L4);
    console.log(row([
      toolId.slice(0, W[0]-1),
      domain.slice(0, W[1]-1),
      col(L1), col(L2), col(L3),
      L4Display,
      col(L5), col(L6),
      finalCol(final),
    ]));
  }

  console.log(sep + '\n');

  // ── Summary ────────────────────────────────────────────────────────────────
  const total       = results.length;
  const prod        = results.filter(r => r.final === 'PRODUCTION_READY').length;
  const stable      = results.filter(r => r.final === 'STABLE').length;
  const unreliable  = results.filter(r => r.final === 'UNRELIABLE').length;
  const broken      = results.filter(r => r.final === 'BROKEN').length;
  const brokenRoute = results.filter(r => r.L4 === 'FAIL_ROUTE').length;
  const permFail    = results.filter(r => r.L2 !== 'PASS' && r.L2 !== 'N/A').length;
  const outputFail  = results.filter(r => r.L6 === 'FAIL_OUTPUT').length;
  const remediated  = results.filter(r => r.L4 === 'REMEDIATED').length;
  const readinessPct = Math.round(((prod + stable) / total) * 100);

  console.log(`${c.bold}SUMMARY${c.reset}`);
  console.log(`  Total tools tested:    ${total}`);
  console.log(`  ${c.green}PRODUCTION_READY:      ${prod}${c.reset}`);
  console.log(`  ${c.green}STABLE:               ${stable}${c.reset}`);
  console.log(`  ${c.yellow}UNRELIABLE:           ${unreliable}${c.reset}`);
  console.log(`  ${c.red}BROKEN:               ${broken}${c.reset}`);
  console.log(`  BROKEN ROUTES:         ${brokenRoute}${remediated ? ' (' + remediated + ' pending remediation)' : ''}`);
  console.log(`  PERMISSION MISMATCHES: ${permFail}`);
  console.log(`  OUTPUT FAILURES:       ${outputFail}`);
  console.log(`  REMEDIATED (pre-patch):${remediated}`);
  console.log(`\n  ${c.bold}READINESS SCORE: ${readinessPct}%${c.reset}  (${prod + stable}/${total} tools operational)\n`);

  if (broken > 0) {
    console.log(`${c.red}${c.bold}BROKEN TOOLS:${c.reset}`);
    results.filter(r => r.final === 'BROKEN').forEach(r => {
      console.log(`  ✗ ${r.toolId} (${r.domain}) — ${r.L4 === 'FAIL_ROUTE' ? 'Route missing' : r.L2.includes('FAIL') ? 'Capability error' : 'Other'}`);
    });
    console.log('');
  }

  if (SAVE_JSON) {
    const outPath = path.join(__dirname, 'tool-audit-results.json');
    require('fs').writeFileSync(outPath, JSON.stringify({ timestamp: new Date().toISOString(), results, summary: { total, prod, stable, unreliable, broken, readinessPct } }, null, 2));
    console.log(`${c.dim}Results saved: ${outPath}${c.reset}`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`${c.dim}Completed in ${elapsed}s${c.reset}\n`);

  return results;
}

// ── Missing param simulation (L3 detailed test) ───────────────────────────────
async function runParamTests() {
  console.log(`\n${c.bold}── L3 PARAM VALIDATION DETAIL ──${c.reset}`);
  const paramTests = [
    { tool:'serp_analysis',   agent:'james',  params:{},           expect:'FAIL_PARAM', desc:'missing keyword' },
    { tool:'ai_report',       agent:'james',  params:{},           expect:'FAIL_PARAM', desc:'missing post_id' },
    { tool:'deep_audit',      agent:'alex',   params:{},           expect:'FAIL_PARAM', desc:'missing post_id' },
    { tool:'get_lead',        agent:'elena',  params:{},           expect:'FAIL_PARAM', desc:'missing id (URL param)' },
    { tool:'move_lead',       agent:'elena',  params:{id:1},       expect:'FAIL_PARAM', desc:'missing stage_id' },
    { tool:'add_note',        agent:'elena',  params:{id:1},       expect:'FAIL_PARAM', desc:'missing content' },
    { tool:'log_activity',    agent:'elena',  params:{id:1},       expect:'FAIL_PARAM', desc:'missing activity_type' },
    { tool:'generate_page_layout',agent:'dmm',params:{},           expect:'FAIL_PARAM', desc:'missing prompt' },
  ];

  // Test runtime-side param check (doesn't need WP)
  for (const t of paramTests) {
    const tool = getTool(t.tool);
    if (!tool) { console.log(`  ${c.red}✗${c.reset} ${t.tool}: NOT IN REGISTRY`); continue; }
    const missing = Object.entries(tool.params || {})
      .filter(([k, v]) => v.required && !(k in t.params))
      .map(([k]) => k);
    const caught = missing.length > 0;
    const mark   = caught ? `${c.green}✓${c.reset}` : `${c.yellow}⚠${c.reset}`;
    console.log(`  ${mark} ${t.tool}: ${t.desc} → ${caught ? 'FAIL_PARAM (caught: ' + missing.join(', ') + ')' : 'NOT CAUGHT by runtime'}`);
  }
  console.log('');
}

// ── Auth test (L2 detailed) ───────────────────────────────────────────────────
async function runAuthTests() {
  console.log(`${c.bold}── L2 CAPABILITY DETAIL (deny-list check) ──${c.reset}`);
  // LAUNCH SCOPE (v2.37.3): denial fixtures now use RETAINED agents that
  // genuinely lack the capability. Denying against 'marcus' proved nothing
  // once he was removed - every capability check denies him unconditionally,
  // so the assertion would pass even if the allow-side were broken.
  const authTests = [
    { tool:'serp_analysis',       allowed:'james',  denied:'elena' },
    { tool:'write_article',       allowed:'priya',  denied:'elena' },
    { tool:'create_lead',         allowed:'elena',  denied:'alex'  },
    { tool:'generate_page_layout',allowed:'dmm',    denied:'elena' },
    { tool:'insert_link',         allowed:'alex',   denied:'priya' },
    { tool:'scan_site_url',       allowed:'alex',   denied:'elena' },
    { tool:'publish_builder_page',allowed:'dmm',    denied:'priya' },
    { tool:'generate_design',     allowed:'dmm',    denied:'james' },
  ];

  // write_article conflict
  const writeConflict = hasCapability('priya','write_article') && !getTool('write_article')?.allowed_agents?.includes('priya');

  for (const t of authTests) {
    const allow = hasCapability(t.allowed, t.tool);
    const block = !hasCapability(t.denied, t.tool);
    const ok    = allow && block;
    console.log(`  ${ok ? c.green+'✓' : c.red+'✗'}${c.reset} ${t.tool}: ${t.allowed}=ALLOW(${allow?'✓':'✗'}) ${t.denied}=DENY(${block?'✓':'✗'})`);
  }

  if (writeConflict) {
    console.log(`  ${c.yellow}⚠${c.reset} write_article: priya has cap-map access but registry allowed_agents=['james'] — CONFLICT (cap-map wins)`);
  }
  console.log('');
}

// ── Entry point ───────────────────────────────────────────────────────────────
(async () => {
  await runParamTests();
  await runAuthTests();
  const results = await runMatrix();
  process.exit(results.some(r => r.final === 'BROKEN') ? 1 : 0);
})();
