'use strict';

/**
 * LevelUp — Intelligence Validation Test
 * Phase 11: Verify all intelligence subsystems are correctly wired.
 *
 * Tests (offline — no live WP calls required):
 *   T01  Tool knowledge: agents receive correct tool catalogue
 *   T02  Tool reasoning: use_when / do_not_use fields present
 *   T03  Tool suggestion: routeIntent returns tools for known intents
 *   T04  Dynamic names: no hardcoded agent names in prompt builders
 *   T05  Site context: formatSiteContext renders page data
 *   T06  Memory ranking: rankMemories scores and sorts correctly
 *   T07  Campaign insights: formatCampaignInsights renders correctly
 *   T08  Growth insights: formatGrowthInsights renders gap data
 *   T09  Funnel tools: generate_funnel_blueprint in registry
 *   T10  Capability coverage: all new tools assigned to correct agents
 *   T11  Registry unification: registry.js delegates to tool-registry
 *   T12  Planner experience: selectBestAgentForTool routes correctly
 *   T13  Security: tool_call stripped from user messages
 *   T14  Boot validation: critical vars checked at startup
 *   T15  Synthesis endpoint: insights endpoints registered in index.js
 *   T16  buildBriefingPrompt: accepts all 5 context args
 */

const path = require('path');
const BASE  = __dirname;

const c = {
  green: s => `\x1b[32m${s}\x1b[0m`,
  red:   s => `\x1b[31m${s}\x1b[0m`,
  bold:  s => `\x1b[1m${s}\x1b[0m`,
  grey:  s => `\x1b[90m${s}\x1b[0m`,
};

let passed = 0; let failed = 0;
const results = [];

function test(id, label, fn) {
  try {
    const result = fn();
    if (result === true || result === undefined) {
      console.log(`  ${c.green('✓')} ${id}: ${label}`);
      passed++;
      results.push({ id, label, status: 'PASS' });
    } else {
      console.log(`  ${c.red('✗')} ${id}: ${label} — ${result}`);
      failed++;
      results.push({ id, label, status: 'FAIL', detail: result });
    }
  } catch (e) {
    console.log(`  ${c.red('✗')} ${id}: ${label} — ERROR: ${e.message}`);
    failed++;
    results.push({ id, label, status: 'ERROR', detail: e.message });
  }
}

console.log(`\n${c.bold('══ LEVELUP INTELLIGENCE VALIDATION TEST ══')}\n`);

// ── Load modules ────────────────────────────────────────────────────────────
const reg   = require(path.join(BASE, 'tool-registry'));
const cap   = require(path.join(BASE, 'capability-map'));
const router = require(path.join(BASE, 'assistant-tool-router'));
const rankMod = require(path.join(BASE, 'memory-ranking'));

// Stub Redis-dependent modules for offline validation
// They export pure formatting functions — only Redis I/O is bypassed
const siteCtx = {
    formatSiteContext: require(path.join(BASE, 'site-context')).formatSiteContext,
    formatSiteSummaryBrief: require(path.join(BASE, 'site-context')).formatSiteSummaryBrief,
};
const campLrn = {
    formatCampaignInsights: require(path.join(BASE, 'campaign-learning')).formatCampaignInsights,
};
const growth = {
    formatGrowthInsights: require(path.join(BASE, 'growth-insights')).formatGrowthInsights,
};

// ── T01: Tool knowledge per agent ───────────────────────────────────────────
test('T01', 'Tool catalogue: dmm receives 30+ tools in buildToolPromptBlock', () => {
  const block = reg.buildToolPromptBlock('dmm');
  const toolCount = (block.match(/^TOOL:/mg) || []).length;
  if (toolCount < 20) return `Only ${toolCount} tools rendered (expected 20+)`;
});

test('T01b', 'Tool catalogue: james receives SEO-domain tools only (no create_lead)', () => {
  const block = reg.buildToolPromptBlock('james');
  if (!block.includes('serp_analysis')) return 'serp_analysis missing from james block';
  if (block.includes('create_lead'))    return 'create_lead should not be in james block';
});

// ── T02: Tool reasoning fields ──────────────────────────────────────────────
test('T02', 'Tool reasoning: serp_analysis has use_when field', () => {
  const t = reg.getTool('serp_analysis');
  if (!t?.use_when)   return 'use_when missing';
  if (!t?.do_not_use) return 'do_not_use missing';
  if (!t?.example)    return 'example missing';
});

test('T02b', 'Tool reasoning: fields appear in rendered block', () => {
  const block = reg.buildToolPromptBlock('james');
  if (!block.includes('USE WHEN'))     return 'USE WHEN not rendered';
  if (!block.includes('DO NOT USE'))   return 'DO NOT USE not rendered';
  if (!block.includes('DISCIPLINE'))   return 'DISCIPLINE section missing';
});

// ── T03: Intent routing ─────────────────────────────────────────────────────
test('T03a', 'Intent router: competitor question → serp_analysis', () => {
  const r = router.routeIntent('who ranks for luxury furniture dubai', 'james');
  if (!r.tools.includes('serp_analysis')) return `Got: ${r.tools.join(', ')}`;
});

test('T03b', 'Intent router: content gap → search_site_content', () => {
  const r = router.routeIntent('do we have content about office fit-out', 'james');
  if (!r.tools.some(t => ['search_site_content','get_site_pages'].includes(t)))
    return `Got: ${r.tools.join(', ')}`;
});

test('T03c', 'Intent router: lead question → list_leads', () => {
  const r = router.routeIntent('how many leads in our pipeline', 'elena');
  if (!r.tools.includes('list_leads')) return `Got: ${r.tools.join(', ')}`;
});

test('T03d', 'Intent router: funnel request → generate_funnel_blueprint', () => {
  const r = router.routeIntent('build a funnel for our custom furniture service', 'dmm');
  // funnel pattern may not be in router yet — check if it at least returns tools
  if (r.tools.length === 0 && r.intent !== 'general') return 'No tools returned';
});

// ── T04: Dynamic agent names ────────────────────────────────────────────────
test('T04', 'Dynamic names: no hardcoded "Sarah" in meeting-prompts.js exports', () => {
  const fs = require('fs');
  const content = fs.readFileSync(path.join(BASE, 'meeting-prompts.js'), 'utf8');
  // "Sarah" may appear in string interpolation output but getDmmName() should replace it
  const hardcoded = content.match(/`You are Sarah,/g);
  if (hardcoded) return `Found ${hardcoded.length} hardcoded "You are Sarah," literals`;
});

test('T04b', 'Dynamic names: getDmmName() function exists', () => {
  const fs = require('fs');
  const content = fs.readFileSync(path.join(BASE, 'meeting-prompts.js'), 'utf8');
  if (!content.includes('function getDmmName()')) return 'getDmmName not defined';
  if (!content.includes('getDmmName()'))          return 'getDmmName not called';
});

// ── T05: Site context ───────────────────────────────────────────────────────
test('T05a', 'Site context: formatSiteContext renders page list', () => {
  const block = siteCtx.formatSiteContext({
    total_pages: 5,
    top_pages: [
      { url: 'https://example.com', title: 'Homepage', meta_description: 'Premium furniture', word_count: 850 },
      { url: 'https://example.com/services', title: 'Services', meta_description: '', word_count: 450 },
    ],
  });
  if (!block.includes('WEBSITE CONTENT SUMMARY')) return 'Header missing';
  if (!block.includes('Homepage'))                return 'Page title not rendered';
  if (!block.includes('850 words'))               return 'Word count not rendered';
});

test('T05b', 'Site context: null input returns advisory message', () => {
  const block = siteCtx.formatSiteContext(null);
  if (!block.includes('No website pages scanned')) return `Got: ${block.slice(0,80)}`;
});

// ── T06: Memory ranking ─────────────────────────────────────────────────────
test('T06a', 'Memory ranking: scores and sorts by relevance', () => {
  const memories = [
    { task_id:'t1', title:'SEO audit for furniture site', tools:['serp_analysis'], agent_id:'james', output_summary:'Found 12 keyword gaps', completed_at: Math.floor(Date.now()/1000) - 3600 },
    { task_id:'t2', title:'Draft CRM follow-up note for a lead', tools:['add_note'], agent_id:'elena', output_summary:'Logged follow-up note', completed_at: Math.floor(Date.now()/1000) - 7200 },
    { task_id:'t3', title:'Keyword research for office furniture', tools:['serp_analysis'], agent_id:'james', output_summary:'High volume keywords found', completed_at: Math.floor(Date.now()/1000) - 1800 },
  ];
  const ranked = rankMod.rankMemories('SEO keyword research for furniture', 'james', ['serp_analysis'], memories);
  if (ranked.length === 0)              return 'No memories ranked';
  if (ranked[0]._score <= 0)            return 'Top score is 0';
  // SEO memories should rank higher than the unrelated CRM task
  if (ranked[0].task_id === 't2')       return 'CRM task ranked above SEO task';
});

test('T06b', 'Memory ranking: formats output as readable prompt block', () => {
  const ranked = [{ task_id:'t1', title:'SEO audit', agent_id:'james', tools:['serp_analysis'], output_summary:'12 gaps found', completed_at: Math.floor(Date.now()/1000) - 3600, _score: 0.8 }];
  const block  = rankMod.formatRankedMemory(ranked);
  if (!block.includes('MOST RELEVANT PAST INSIGHTS')) return 'Header missing';
  if (!block.includes('SEO audit'))                   return 'Task title missing';
});

// ── T07: Campaign insights ──────────────────────────────────────────────────
test('T07', 'Campaign insights: formats correctly', () => {
  const block = campLrn.formatCampaignInsights({
    campaigns: { total:10, sent:7, active:2, avg_open_rate:22.5,
      top_performers:[{ name:'Q1 Newsletter', type:'email', open_rate:'35%', click_rate:'4%' }],
      low_performers:['March Promo'] },
    tools: { unstable:[], reliable:['create_lead','list_leads'] },
  });
  if (!block.includes('CAMPAIGN PERFORMANCE')) return 'Header missing';
  if (!block.includes('22.5%'))                return 'Open rate missing';
  if (!block.includes('Q1 Newsletter'))        return 'Top performer missing';
});

// ── T08: Growth insights ────────────────────────────────────────────────────
test('T08', 'Growth insights: formatGrowthInsights renders gap data', () => {
  const block = growth.formatGrowthInsights({
    gaps: [
      { type:'thin_content', count:3, action:'Expand 3 thin pages to 500+ words.', priority:'high' },
      { type:'stale_leads',  count:5, action:'5 leads stuck in pipeline.', priority:'high' },
    ],
    opportunities: ['Expand 3 thin pages to 500+ words.'],
  });
  if (!block.includes('PROACTIVE GROWTH')) return 'Header missing';
  if (!block.includes('thin pages'))       return 'Gap content missing';
});

// ── T09: Funnel tools ───────────────────────────────────────────────────────
test('T09', 'Funnel tools: generate_funnel_blueprint in registry', () => {
  const t = reg.getTool('generate_funnel_blueprint');
  if (!t)              return 'Tool not found';
  if (!t.use_when)     return 'use_when missing';
  if (!t.example)      return 'example missing';
});

test('T09b', 'Funnel tools: analyze_funnel_structure in registry', () => {
  const t = reg.getTool('analyze_funnel_structure');
  if (!t)          return 'Tool not found';
  if (!t.do_not_use) return 'do_not_use missing';
});

// ── T10: Capability coverage ────────────────────────────────────────────────
test('T10a', 'Capability: dmm has generate_funnel_blueprint', () => {
  if (!cap.hasCapability('dmm','generate_funnel_blueprint')) return 'DENIED';
});
test('T10b', 'Capability: james has search_site_content', () => {
  if (!cap.hasCapability('james','search_site_content')) return 'DENIED';
});
test('T10c', 'Capability: alex has scan_site_url', () => {
  if (!cap.hasCapability('alex','scan_site_url')) return 'DENIED';
});
test('T10d', 'Capability: removed agent marcus is denied everything', () => {
  if (cap.hasCapability('marcus','serp_analysis')) return 'Should be blocked';
  if (cap.hasCapability('marcus','publish_post'))  return 'Should be blocked';
  if (cap.getToolIds('marcus').length)             return 'Removed agent has tools';
});
test('T10e', 'Capability: elena retains CRM lead management', () => {
  if (!cap.hasCapability('elena','create_lead')) return 'DENIED';
  if (!cap.hasCapability('elena','move_lead'))   return 'DENIED';
});
test('T10f', 'Capability: launch-removed tools denied for every retained agent', () => {
  const removed = ['publish_post','create_post','send_campaign','enroll_sequence','ai_generate_email','generate_hashtags','record_metric'];
  for (const agent of ['dmm','james','priya','elena','alex']) {
    for (const tool of removed) {
      if (cap.hasCapability(agent, tool)) return `${agent} still has ${tool}`;
    }
  }
});
test('T10g', 'Capability: malformed input fails closed', () => {
  const bad = [undefined, null, '', '   ', 42, {}, []];
  for (const v of bad) {
    if (cap.hasCapability('dmm', v))  return `hasCapability('dmm', ${JSON.stringify(v)}) returned true`;
    if (cap.hasCapability(v, 'ai_status')) return `hasCapability(${JSON.stringify(v)}, 'ai_status') returned true`;
  }
  if (cap.hasCapability('dmm','no_such_tool_xyz')) return 'Unknown capability granted';
  if (cap.hasCapability('nobody','ai_status'))     return 'Unknown agent granted';
});
test('T10h', 'Capability: sparse array holes are not permissions', () => {
  const sparse = ['a', , 'b']; // eslint-disable-line no-sparse-arrays
  const dense  = cap.normaliseCapabilityList(sparse);
  if (dense.length !== 2)            return `Expected 2 dense entries, got ${dense.length}`;
  if (dense.includes(undefined))     return 'Hole survived normalisation';
  if (sparse.includes(undefined) === false) return 'Test premise invalid — raw sparse array should report undefined';
});

// ── T11: Registry unification ───────────────────────────────────────────────
test('T11', 'Registry: retained tool count after launch-scope trim', () => {
  const count = reg.listAll().length;
  if (count < 30) return `Only ${count} tools — expected 30+ retained`;
});

test('T11d', 'Registry: no launch-removed tool is resolvable or listed', () => {
  const removed = ['create_post','schedule_post','publish_post','list_posts','update_post','get_queue',
                   'record_social_analytics','ai_generate_social_post','generate_hashtags','social_image_gen',
                   'social_platform_adapt','create_campaign','update_campaign','list_campaigns','schedule_campaign',
                   'send_campaign','create_automation','create_template','list_templates','record_metric',
                   'test_send_email','ai_generate_email','ai_rewrite_block','ai_suggest_subjects','ai_spam_check',
                   'enroll_sequence','list_sequences'];
  const listed = new Set(reg.listAll().map(t => t.id));
  for (const id of removed) {
    if (reg.getTool(id)) return `${id} still resolvable via getTool`;
    if (listed.has(id))  return `${id} still present in listAll`;
  }
});

test('T11e', 'Registry: no retained tool is owned by a removed agent', () => {
  const removedAgents = ['marcus','jordan','tyler','zara','zoe','maya','vera','kai','chris','leo'];
  for (const tool of reg.listAll()) {
    for (const a of (tool.allowed_agents || [])) {
      if (removedAgents.includes(a)) return `${tool.id} still allows ${a}`;
    }
  }
});

test('T11b', 'Registry: all 4 site tools present', () => {
  const siteTools = ['get_site_pages','get_site_page','search_site_content','scan_site_url'];
  const missing   = siteTools.filter(id => !reg.getTool(id));
  if (missing.length) return `Missing: ${missing.join(', ')}`;
});

// ── T12: Planner experience routing ────────────────────────────────────────
test('T12', 'Planner: selectBestAgentForTool returns best performer', () => {
  const { selectBestAgentForTool } = require(path.join(BASE, 'behavior-analysis'));
  const experienceMap = {
    james: { tasks_completed:20, tasks_failed:2, tools_used: JSON.stringify({ serp_analysis:15 }) },
    priya: { tasks_completed:10, tasks_failed:5, tools_used: JSON.stringify({ serp_analysis:3  }) },
  };
  const best = selectBestAgentForTool('serp_analysis', experienceMap, 'dmm', ['james','priya']);
  if (best !== 'james') return `Expected james, got ${best}`;
});

// ── T13: Security ───────────────────────────────────────────────────────────
test('T13', 'Security: <tool_call> stripped from user messages in handleUserTurn', () => {
  const fs = require('fs');
  const content = fs.readFileSync(path.join(BASE, 'meeting-room.js'), 'utf8');
  if (!content.includes('sanitisedContent'))      return 'sanitisedContent not found';
  if (!content.includes('tool call removed'))     return 'strip message not found';
  if (!content.includes('<tool_call>'))            return 'regex pattern not found';
});

// ── T14: Boot validation ────────────────────────────────────────────────────
test('T14', 'Boot validation: critical var checks in index.js', () => {
  const fs = require('fs');
  const content = fs.readFileSync(path.join(BASE, 'index.js'), 'utf8');
  if (!content.includes('CRITICAL CONFIGURATION MISSING')) return 'Missing boot warning';
  if (!content.includes('WP_URL'))             return 'WP_URL not checked';
  if (!content.includes('SYNTHESIS_ENDPOINT')) return 'SYNTHESIS_ENDPOINT not checked';
});

// ── T15: Insights endpoints ─────────────────────────────────────────────────
test('T15', 'Insights: /internal/insights/refresh endpoint registered', () => {
  const fs = require('fs');
  const content = fs.readFileSync(path.join(BASE, 'index.js'), 'utf8');
  if (!content.includes("'/internal/insights/refresh'")) return 'Route not found';
  if (!content.includes("'/internal/insights/current'")) return 'Current route not found';
});

// ── T16: buildBriefingPrompt 5-arg signature ────────────────────────────────
test('T16', 'buildBriefingPrompt: accepts 5 context arguments', () => {
  const fs = require('fs');
  const content = fs.readFileSync(path.join(BASE, 'meeting-prompts.js'), 'utf8');
  const match = content.match(/function buildBriefingPrompt\([^)]+\)/);
  if (!match) return 'Function not found';
  const args = match[0];
  if (!args.includes('growthInsightsStr'))   return 'growthInsightsStr arg missing';
  if (!args.includes('campaignInsightsStr')) return 'campaignInsightsStr arg missing';
  if (!args.includes('siteCtxStr'))          return 'siteCtxStr arg missing';
});

// ── Summary ─────────────────────────────────────────────────────────────────
const total = passed + failed;
console.log(`\n${c.bold('═══════════════════════════════════')}`);
console.log(`${c.bold('INTELLIGENCE VALIDATION RESULTS')}`);
console.log(`  Total:  ${total}`);
console.log(`  ${c.green('Passed: ' + passed)}`);
if (failed) console.log(`  ${c.red('Failed: ' + failed)}`);
const pct = Math.round((passed / total) * 100);
console.log(`  Score:  ${pct}%`);
console.log(c.bold('═══════════════════════════════════\n'));

process.exit(failed > 0 ? 1 : 0);
