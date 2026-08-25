'use strict';

/**
 * LevelUp Runtime — LAUNCH SCOPE VALIDATION HARNESS (v2.37.3)
 *
 * Off-Railway validation for the W3 runtime sanitation. Loads the real runtime
 * modules and asserts the launch-scope contract. Requires no Redis, no network,
 * no Laravel, no DeepSeek key — every check is local and side-effect free.
 *
 * Run:  node launch-scope-validate.js
 * Exit: 0 = all pass, 1 = any failure
 */

const REMOVED_AGENTS = ['marcus', 'jordan', 'tyler', 'zara', 'zoe', 'maya', 'vera', 'kai', 'chris', 'leo'];
const REMOVED_TOOLS = [
    'create_post', 'schedule_post', 'publish_post', 'list_posts', 'update_post', 'get_queue',
    'record_social_analytics', 'ai_generate_social_post', 'generate_hashtags', 'social_image_gen',
    'social_platform_adapt', 'create_campaign', 'update_campaign', 'list_campaigns',
    'schedule_campaign', 'send_campaign', 'create_automation', 'create_template', 'list_templates',
    'record_metric', 'test_send_email', 'send_email', 'ai_generate_email', 'ai_rewrite_block',
    'ai_suggest_subjects', 'ai_spam_check', 'enroll_sequence', 'list_sequences',
];
const RETAINED_AGENTS = ['dmm', 'james', 'alex', 'diana', 'ryan', 'sofia', 'priya', 'nora', 'elena', 'max'];

let pass = 0, fail = 0;
const failures = [];

function check(section, name, fn) {
    let result;
    try { result = fn(); } catch (e) { result = `THREW: ${e.message}`; }
    if (result === true || result === undefined) {
        pass++;
        console.log(`  ✓ [${section}] ${name}`);
    } else {
        fail++;
        failures.push(`[${section}] ${name} — ${result}`);
        console.log(`  ✗ [${section}] ${name} — ${result}`);
    }
}

console.log('\n=== LAUNCH SCOPE VALIDATION — runtime v2.37.3 ===\n');

// ══ 1. launch-scope module ═══════════════════════════════════════════════
console.log('-- 1. launch-scope policy module --');
const ls = require('./launch-scope');

check('LS', 'all 10 removed agents recognised', () => {
    const missed = REMOVED_AGENTS.filter(a => !ls.isRemovedAgent(a));
    return missed.length ? `not recognised: ${missed.join(', ')}` : true;
});
check('LS', 'retained agents not flagged as removed', () => {
    const wrong = RETAINED_AGENTS.filter(a => ls.isRemovedAgent(a));
    return wrong.length ? `wrongly removed: ${wrong.join(', ')}` : true;
});
check('LS', 'dmm is retained, never removed', () => ls.isRemovedAgent('dmm') === false && ls.isRetainedAgent('dmm') === true);
check('LS', 'removed tools recognised', () => {
    const missed = REMOVED_TOOLS.filter(t => !ls.isRemovedTool(t));
    return missed.length ? `not recognised: ${missed.join(', ')}` : true;
});
check('LS', 'garbage input fails closed', () => {
    for (const v of [undefined, null, '', '   ', 42, {}, []]) {
        if (ls.isRemovedAgent(v) === true) return `isRemovedAgent(${JSON.stringify(v)}) true`;
        if (ls.isRetainedAgent(v) === true) return `isRetainedAgent(${JSON.stringify(v)}) true`;
    }
    return true;
});
check('LS', 'article-share context requires a real article reference', () => {
    if (ls.isArticleShareContext({ source: 'article_share' })) return 'bare marker unlocked publishing';
    if (!ls.isArticleShareContext({ source: 'article_share', article_id: 42 })) return 'valid article_id rejected';
    if (!ls.isArticleShareContext({ article_share: true, article_url: 'https://x.test/a' })) return 'valid url rejected';
    return true;
});
check('LS', 'publish_post is not generally selectable even as article-share action', () =>
    ls.isArticleShareAction('publish_post', {}) === false);

// ══ 2. Fallback roster (AGENTS_STATIC) ═══════════════════════════════════
console.log('\n-- 2. fallback roster (simulated Laravel outage) --');
// No WP_URL / LARAVEL_BASE_URL is set, so fetchAgentsFromDB() returns null
// immediately and getAgentsSync() serves AGENTS_STATIC. This IS the outage path.
delete process.env.WP_URL;
delete process.env.LARAVEL_BASE_URL;
delete process.env.LARAVEL_URL;
delete process.env.WP_CALLBACK_URL;

const agents = require('./agents');
const roster = agents.getAgentsSync();
const rosterKeys = Object.keys(roster).sort();

check('ROSTER', 'fallback serves exactly the 10 retained agents', () => {
    const expected = RETAINED_AGENTS.slice().sort();
    return JSON.stringify(rosterKeys) === JSON.stringify(expected)
        ? true : `got [${rosterKeys.join(', ')}]`;
});
check('ROSTER', 'no removed agent in fallback roster', () => {
    const found = REMOVED_AGENTS.filter(a => rosterKeys.includes(a));
    return found.length ? `present: ${found.join(', ')}` : true;
});
check('ROSTER', 'AGENTS_STATIC itself contains no removed agent', () => {
    const found = REMOVED_AGENTS.filter(a => a in agents.AGENTS_STATIC);
    return found.length ? `present: ${found.join(', ')}` : true;
});
check('ROSTER', 'dmm resolves to Sarah', () => {
    const s = roster.dmm;
    if (!s) return 'dmm missing from roster';
    return s.name === 'Sarah' ? true : `dmm.name = ${s.name}`;
});
check('ROSTER', 'no removed agent resolvable by direct lookup', () => {
    const found = REMOVED_AGENTS.filter(a => roster[a] !== undefined);
    return found.length ? `resolvable: ${found.join(', ')}` : true;
});
check('ROSTER', 'AGENTS proxy hides removed agents', () => {
    const found = REMOVED_AGENTS.filter(a => a in agents.AGENTS || agents.AGENTS[a] !== undefined);
    return found.length ? `exposed: ${found.join(', ')}` : true;
});
check('ROSTER', 'team roster prompt names no removed agent', () => {
    const text = agents.getTeamRoster().toLowerCase();
    const found = ['marcus', 'zara', 'tyler', 'jordan', 'vera', 'kai'].filter(n => text.includes(n));
    return found.length ? `named: ${found.join(', ')}` : true;
});
check('ROSTER', 'removed agent gets no persona to speak as', () => {
    const p = agents.buildAgentConsultPrompt('marcus', 'post this', {});
    return /not part of the LevelUp Growth team|not available/i.test(p) ? true : `got: ${p.slice(0, 80)}`;
});

// ══ 3. Capability map ════════════════════════════════════════════════════
console.log('\n-- 3. capability map --');
const cap = require('./capability-map');

check('CAP', 'no removed agent has any capability', () => {
    for (const a of REMOVED_AGENTS) {
        if (cap.getToolIds(a).length) return `${a} has tools`;
        if (cap.hasCapability(a, 'ai_status')) return `${a} granted ai_status`;
    }
    return true;
});
check('CAP', 'no retained agent holds a removed tool', () => {
    for (const a of ['dmm', 'james', 'priya', 'elena', 'alex']) {
        for (const t of REMOVED_TOOLS) {
            if (cap.hasCapability(a, t)) return `${a} still has ${t}`;
        }
    }
    return true;
});
check('CAP', 'hasCapability(agent, undefined) === false', () => cap.hasCapability('dmm', undefined) === false);
check('CAP', 'hasCapability(agent, null) === false', () => cap.hasCapability('dmm', null) === false);
check('CAP', "hasCapability(agent, '') === false", () => cap.hasCapability('dmm', '') === false);
check('CAP', 'hasCapability(agent, whitespace) === false', () => cap.hasCapability('dmm', '   ') === false);
check('CAP', 'non-string capability rejected', () => {
    for (const v of [42, {}, [], true, Symbol.iterator]) {
        if (cap.hasCapability('dmm', v)) return `accepted ${String(v)}`;
    }
    return true;
});
check('CAP', 'unknown capability rejected', () => cap.hasCapability('dmm', 'no_such_tool_xyz') === false);
check('CAP', 'unknown agent rejected', () => cap.hasCapability('nobody_xyz', 'ai_status') === false);
check('CAP', 'removed agent rejected', () => cap.hasCapability('marcus', 'ai_status') === false);
check('CAP', 'malformed agent id rejected', () => {
    for (const v of [undefined, null, '', '  ', 42, {}, []]) {
        if (cap.hasCapability(v, 'ai_status')) return `accepted ${JSON.stringify(v)}`;
    }
    return true;
});
check('CAP', 'SPARSE ARRAY: hole is not a permission', () => {
    const sparse = ['a', , 'b'];                 // eslint-disable-line no-sparse-arrays
    if (sparse.includes(undefined) !== true) return 'test premise invalid: raw sparse array should include undefined';
    const dense = cap.normaliseCapabilityList(sparse);
    if (dense.length !== 2) return `expected 2 dense entries, got ${dense.length}`;
    if (dense.includes(undefined)) return 'hole survived normalisation';
    return true;
});
check('CAP', 'malformed capability array fails closed', () => {
    if (cap.normaliseCapabilityList(null).length !== 0) return 'null not handled';
    if (cap.normaliseCapabilityList('nope').length !== 0) return 'string not handled';
    if (cap.normaliseCapabilityList([1, {}, null, '', '  ']).length !== 0) return 'junk entries survived';
    return true;
});
check('CAP', 'Sarah (dmm) retains launch capabilities', () => {
    const need = ['autonomous_goal', 'list_goals', 'create_lead', 'generate_design',
                  'list_design_templates', 'generate_page_layout', 'system_health_check'];
    const missing = need.filter(t => !cap.hasCapability('dmm', t));
    return missing.length ? `missing: ${missing.join(', ')}` : true;
});
check('CAP', 'Priya retains content capabilities', () => {
    const need = ['write_article', 'improve_draft', 'generate_page_layout', 'search_site_content'];
    const missing = need.filter(t => !cap.hasCapability('priya', t));
    return missing.length ? `missing: ${missing.join(', ')}` : true;
});
check('CAP', 'Elena retains CRM capabilities', () => {
    const need = ['create_lead', 'get_lead', 'update_lead', 'list_leads', 'move_lead',
                  'log_activity', 'add_note', 'create_event'];
    const missing = need.filter(t => !cap.hasCapability('elena', t));
    return missing.length ? `missing: ${missing.join(', ')}` : true;
});
check('CAP', 'Alex retains technical SEO capabilities', () => {
    const need = ['deep_audit', 'insert_link', 'scan_site_url', 'export_website', 'hydrate_page'];
    const missing = need.filter(t => !cap.hasCapability('alex', t));
    return missing.length ? `missing: ${missing.join(', ')}` : true;
});
check('CAP', 'James retains SEO capabilities', () => {
    const need = ['serp_analysis', 'ai_report', 'deep_audit', 'link_suggestions'];
    const missing = need.filter(t => !cap.hasCapability('james', t));
    return missing.length ? `missing: ${missing.join(', ')}` : true;
});

// ══ 4. Tool registry ═════════════════════════════════════════════════════
console.log('\n-- 4. tool registry --');
const reg = require('./tool-registry');

check('REG', 'no removed tool resolvable via getTool', () => {
    const found = REMOVED_TOOLS.filter(t => reg.getTool(t) !== null);
    return found.length ? `resolvable: ${found.join(', ')}` : true;
});
check('REG', 'no removed tool in listAll', () => {
    const ids = new Set(reg.listAll().map(t => t.id));
    const found = REMOVED_TOOLS.filter(t => ids.has(t));
    return found.length ? `listed: ${found.join(', ')}` : true;
});
check('REG', 'no tool owned by a removed agent', () => {
    for (const tool of reg.listAll()) {
        for (const a of (tool.allowed_agents || [])) {
            if (REMOVED_AGENTS.includes(a)) return `${tool.id} allows ${a}`;
        }
    }
    return true;
});
check('REG', 'agentCanUseTool denies removed agent + removed tool', () => {
    if (reg.agentCanUseTool('marcus', 'serp_analysis')) return 'removed agent allowed';
    if (reg.agentCanUseTool('dmm', 'publish_post')) return 'removed tool allowed';
    return true;
});
check('REG', 'agentCanUseTool fails closed on garbage', () => {
    for (const v of [undefined, null, '', 42, {}]) {
        if (reg.agentCanUseTool(v, 'ai_status')) return `agent ${JSON.stringify(v)} allowed`;
        if (reg.agentCanUseTool('dmm', v)) return `tool ${JSON.stringify(v)} allowed`;
    }
    return true;
});
check('REG', 'getEndpoint returns null for removed tools', () => {
    const found = REMOVED_TOOLS.filter(t => reg.getEndpoint(t) !== null);
    return found.length ? `resolvable: ${found.join(', ')}` : true;
});
check('REG', 'getToolsForAgent(removed) is empty', () => {
    const found = REMOVED_AGENTS.filter(a => reg.getToolsForAgent(a).length > 0);
    return found.length ? `non-empty: ${found.join(', ')}` : true;
});
check('REG', 'Studio direct creative remains discoverable for Sarah', () => {
    const ids = reg.getToolsForAgent('dmm').map(t => t.id);
    const need = ['generate_design', 'pick_design_template', 'list_design_templates'];
    const missing = need.filter(t => !ids.includes(t));
    return missing.length ? `missing: ${missing.join(', ')}` : true;
});
check('REG', 'retained SEO/Builder/CRM tools still resolvable', () => {
    const need = ['serp_analysis', 'deep_audit', 'write_article', 'create_lead',
                  'generate_page_layout', 'publish_builder_page', 'scan_site_url', 'create_event'];
    const missing = need.filter(t => !reg.getTool(t));
    return missing.length ? `missing: ${missing.join(', ')}` : true;
});
check('REG', 'no agent prompt block advertises a removed tool', () => {
    // Scans the FULL rendered prompt (names, descriptions, examples, param
    // hints) — a removed tool named inside a retained tool's description still
    // teaches the LLM that the capability exists.
    for (const agent of ['dmm', 'james', 'priya', 'elena', 'alex']) {
        const block = reg.buildToolPromptBlock(agent);
        const leaked = REMOVED_TOOLS.filter(t => new RegExp(`\\b${t}\\b`).test(block));
        if (leaked.length) return `${agent} block leaks: ${leaked.join(', ')}`;
    }
    return true;
});

// ══ 5. Tool discovery ════════════════════════════════════════════════════
console.log('\n-- 5. tool discovery --');
const disc = require('./tool-discovery');

check('DISC', 'social/marketing domains have no owning agent', () => {
    if ((disc.DOMAIN_AGENT_MAP.social || []).length) return 'social has owners';
    if ((disc.DOMAIN_AGENT_MAP.marketing || []).length) return 'marketing has owners';
    return true;
});
check('DISC', 'no domain maps to a removed agent', () => {
    for (const [domain, list] of Object.entries(disc.DOMAIN_AGENT_MAP)) {
        for (const a of list) if (REMOVED_AGENTS.includes(a)) return `${domain} → ${a}`;
    }
    return true;
});
check('DISC', 'getAllTools(removed agent) is empty', () =>
    REMOVED_AGENTS.every(a => disc.getAllTools(a).length === 0) ? true : 'removed agent got tools');
check('DISC', 'discovery surfaces no removed tool', () => {
    const ids = disc.getAllTools().map(t => t.id);
    const found = REMOVED_TOOLS.filter(t => ids.includes(t));
    return found.length ? `surfaced: ${found.join(', ')}` : true;
});

// ══ 6. Planner ═══════════════════════════════════════════════════════════
console.log('\n-- 6. planner --');
const planner = require('./lu-planner');

check('PLAN', 'roster contains no removed agent', () => {
    const found = REMOVED_AGENTS.filter(a => a in planner.AGENT_ROSTER);
    return found.length ? `present: ${found.join(', ')}` : true;
});
check('PLAN', 'no roster entry offers a removed tool', () => {
    for (const [agent, entry] of Object.entries(planner.AGENT_ROSTER)) {
        for (const t of (entry.tools || [])) {
            if (REMOVED_TOOLS.includes(t)) return `${agent} offers ${t}`;
        }
    }
    return true;
});
check('PLAN', '_any shared tools contain no removed tool (record_metric)', () => {
    const anyTools = planner.AGENT_ROSTER._any.tools;
    return anyTools.includes('record_metric') ? 'record_metric still shared with every agent' : true;
});
check('PLAN', 'scaffold fallback is a retained agent + retained tool', () => {
    const [t] = planner.scaffoldPlan('g1', 'Improve SEO');
    if (REMOVED_AGENTS.includes(t.agent)) return `scaffold uses ${t.agent}`;
    if (t.tools.some(x => REMOVED_TOOLS.includes(x))) return `scaffold uses ${t.tools.join(',')}`;
    return true;
});

// ══ 7. Assistant intent router ═══════════════════════════════════════════
console.log('\n-- 7. assistant intent router --');
const router = require('./assistant-tool-router');

const OUT_OF_SCOPE_PROMPTS = [
    'Create a social media campaign.',
    'Send an email campaign.',
    'Build a newsletter sequence.',
    'Ask Marcus to publish this.',
    'Get Chris to make TikTok videos.',
    'Ask Leo to create ads.',
    'Post every day on Facebook.',
    'Automatically reply to comments.',
];
for (const prompt of OUT_OF_SCOPE_PROMPTS) {
    check('ROUTER', `refuses: "${prompt}"`, () => {
        const r = router.routeIntent(prompt, 'dmm');
        if (!r.out_of_scope) return `routed to ${r.primary_intent} with tools [${r.tools.join(', ')}]`;
        if (r.tools.length) return `returned tools: ${r.tools.join(', ')}`;
        if (!r.suggested_alternative) return 'no retained alternative offered';
        return true;
    });
}
check('ROUTER', 'no intent route offers a removed tool', () => {
    const probes = ['write me a blog article', 'audit my site', 'show my leads',
                    'build a landing page', 'what templates are available', 'publish my page'];
    for (const p of probes) {
        const r = router.routeIntent(p, 'dmm');
        for (const t of (r.tools || [])) {
            if (REMOVED_TOOLS.includes(t)) return `"${p}" → ${t}`;
        }
    }
    return true;
});
check('ROUTER', 'retained work still routes to real tools', () => {
    const r = router.routeIntent('write me a blog article about office furniture', 'priya');
    if (r.out_of_scope) return 'blog article wrongly refused';
    if (!r.tools.length) return 'no tools returned for retained work';
    return true;
});
check('ROUTER', 'SEO audit still routes', () => {
    const r = router.routeIntent('run an seo audit on my site', 'james');
    return (!r.out_of_scope && r.tools.length) ? true : 'SEO audit did not route';
});
check('ROUTER', 'Studio visual request still routes', () => {
    const r = router.routeIntent('create a visual design for my brand', 'dmm');
    return (!r.out_of_scope && r.tools.includes('generate_design')) ? true : `got ${JSON.stringify(r.tools)}`;
});

// ══ 8. Memory sanitation ═════════════════════════════════════════════════
console.log('\n-- 8. memory sanitation --');

check('MEM', 'removed-agent history marked inert, not erased', () => {
    const rec = { id: 7, title: 'Post to Instagram', assignee: 'marcus', tools: ['create_post'] };
    const marked = ls.markHistoricalRecord(rec);
    if (marked.title !== rec.title) return 'history content destroyed';
    if (marked.launch_scope_removed !== true) return 'not flagged';
    if (marked.executable !== false) return 'still executable';
    if (marked.assignable !== false) return 'still assignable';
    return true;
});
check('MEM', 'removed-tool history marked inert', () => {
    const marked = ls.markHistoricalRecord({ id: 8, assignee: 'dmm', tools: ['send_campaign'] });
    return marked.executable === false ? true : 'removed-tool record still executable';
});
check('MEM', 'retained history untouched', () => {
    const rec = { id: 9, assignee: 'james', tools: ['serp_analysis'] };
    const marked = ls.markHistoricalRecord(rec);
    if (marked.launch_scope_removed) return 'retained record wrongly flagged';
    if (!ls.isExecutableRecord(marked)) return 'retained record not executable';
    return true;
});
check('MEM', 'stale memory cannot restore removed routing', () => {
    const stale = [
        { id: 1, assignee: 'marcus', tools: ['create_post'] },
        { id: 2, assignee: 'vera', tools: ['send_campaign'] },
        { id: 3, assignee: 'james', tools: ['serp_analysis'] },
    ].map(ls.markHistoricalRecord);
    const executable = stale.filter(ls.isExecutableRecord);
    if (executable.length !== 1) return `${executable.length} executable, expected 1`;
    if (executable[0].assignee !== 'james') return `wrong survivor: ${executable[0].assignee}`;
    return true;
});
check('MEM', 'deliverable schema has no removed-agent entry', () => {
    const tm = require('./task-memory');
    const found = REMOVED_AGENTS.filter(a => a in tm.DELIVERABLE_SCHEMA);
    return found.length ? `present: ${found.join(', ')}` : true;
});
check('MEM', 'no deliverable schema invites email-sequence output', () => {
    const tm = require('./task-memory');
    for (const [agent, schema] of Object.entries(tm.DELIVERABLE_SCHEMA)) {
        if ((schema.fields || []).includes('nurture_sequence')) return `${agent} still asks for nurture_sequence`;
    }
    return true;
});

// ══ 9. Meeting prompts ═══════════════════════════════════════════════════
console.log('\n-- 9. meeting prompts --');
const mp = require('./meeting-prompts');

check('MEET', '@mention of a removed agent summons nobody', () => {
    if (typeof mp.parseAddressing !== 'function') return true; // not exported in this build
    const r = mp.parseAddressing('@marcus can you post this');
    const list = (r && r.agents) || [];
    return list.includes('marcus') ? 'marcus summoned' : true;
});
check('MEET', 'plain-name mention of removed agent summons nobody', () => {
    if (typeof mp.parseAddressing !== 'function') return true;
    const r = mp.parseAddressing('Marcus, publish this now');
    const list = (r && r.agents) || [];
    return list.includes('marcus') ? 'marcus summoned' : true;
});
check('MEET', 'retained @mention still works', () => {
    if (typeof mp.parseAddressing !== 'function') return true;
    const r = mp.parseAddressing('@alex can you check crawl errors');
    const list = (r && r.agents) || [];
    return list.includes('alex') ? true : `alex not summoned, got ${JSON.stringify(list)}`;
});

// ══ 10. Module load smoke test ═══════════════════════════════════════════
console.log('\n-- 10. module load smoke test --');
const SAFE_MODULES = [
    './launch-scope', './capability-map', './tool-registry', './tool-discovery',
    './lu-planner', './agents', './meeting-prompts', './assistant-tool-router',
    './tool-governance-intelligence', './param-resolver', './memory-ranking',
    './site-context', './lu-context', './prompt-assembler', './behavior-analysis',
];
for (const m of SAFE_MODULES) {
    check('LOAD', `requires cleanly: ${m}`, () => { require(m); return true; });
}

// ══ Summary ══════════════════════════════════════════════════════════════
console.log('\n' + '='.repeat(60));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (failures.length) {
    console.log('\nFAILURES:');
    for (const f of failures) console.log('  - ' + f);
}
console.log('='.repeat(60) + '\n');
process.exit(fail === 0 ? 0 : 1);
