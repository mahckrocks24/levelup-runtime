'use strict';

/**
 * LevelUp — Assistant Tool Router
 * Phase 2: Pre-reasoning intent detection → recommended tools
 * Phase 3: Execution Priority Enforcement — execution intents ALWAYS outrank advisory ones
 *
 * Detects user intent from message text and injects relevant tool suggestions
 * into the assistant prompt before the LLM reasons. This dramatically improves
 * tool selection accuracy without requiring the LLM to discover tools from scratch.
 *
 * PRIORITY SYSTEM:
 *   EXECUTION intents (create, build, send, publish…) = priority 100
 *   ADVISORY intents  (analyze, suggest, optimize…)   = priority 50
 *   Ranking = priority × pattern_hit_count
 *   Execution ALWAYS beats advisory unless advisory has 2× more hits.
 *
 * Usage:
 *   const { routeIntent } = require('./assistant-tool-router');
 *   const result = routeIntent(message, agentId);
 *   // result: { primary_intent, tools, reasoning, secondary_intents[], post_execution_suggestions[] }
 */

const { hasCapability } = require('./capability-map');
const launchScope       = require('./launch-scope');

// ── Intent type classification ─────────────────────────────────────────────────
// EXECUTION = the system can DO something for the user right now (priority 100)
// ADVISORY  = analysis, suggestions, recommendations (priority 50)
// LAUNCH SCOPE (v2.37.3): social_create, social_queue, social_report,
// social_builder_chain, seo_social_chain, marketing_campaign, lead_nurture,
// send_email_campaign and create_email_campaign were REMOVED — they classified
// out-of-scope work as executable. seo_content_chain replaces seo_social_chain.
const INTENT_TYPE = {
  // EXECUTION intents
  page_building:         'execution',
  website_building:      'execution',
  crm_create:            'execution',
  seo_content_chain:     'execution',
  publish_action:        'execution',
  funnel_strategy:       'execution',
  content_generation:    'execution',
  visual_create:         'execution',

  // ADVISORY intents (read/analyze/suggest — no write action)
  seo_advisory:          'advisory',
  competitor_research:   'advisory',
  seo_audit:             'advisory',
  content_gap:           'advisory',
  keyword_research:      'advisory',
  internal_links:        'advisory',
  outbound_links:        'advisory',
  site_content:          'advisory',
  crm_query:             'advisory',
  crm_report:            'advisory',
  template_browse:       'advisory',
  analytics_report:      'advisory',
  calendar:              'advisory',
  platform_status:       'advisory',
  memory_query:          'advisory',
  approval_queue:        'advisory',
};

// ── OUT-OF-SCOPE INTENT DETECTION (v2.37.3) ───────────────────────────────
// Checked BEFORE the pattern catalogue. A match short-circuits routing: the
// assistant is told the capability isn't part of the product and given a
// genuinely retained alternative to offer, instead of being handed tools that
// the Laravel kernel would refuse a moment later.
const OUT_OF_SCOPE_PATTERNS = [
  // v2.37.10 (DEC-0028): the social-media entry and the Marcus entry are REMOVED — social posting,
  // scheduling, publishing and hashtags are in the product. Social listening / comment replies /
  // engagement analytics stay out. Email marketing stays out.
  {
    patterns: [/reply.*to.*comment|respond.*to.*comment|engagement.*rate|social.*listening|social.*monitoring|competitor.*(?:social|monitoring)/i],
    reason: 'Social listening, comment replies and engagement analytics are not part of this product.',
    alternative: 'Offer instead: draft, schedule or publish a social post (Marcus), or write a blog article.',
  },
  {
    patterns: [/email.*(?:campaign|blast|marketing|newsletter|sequence|drip|automation|template|subject.*line)|newsletter|send.*email|blast.*email|drip.*campaign|nurture.*sequence|enroll.*sequence|subject.*line|spam.*(?:check|score)|open.*rate|click.*rate/i],
    reason: 'Email marketing (campaigns, newsletters, sequences, drips, subject-line and email-copy generation) is not part of this product.',
    alternative: 'Offer instead: a CRM follow-up task for the owner to action, or a blog article covering the same message.',
  },
  {
    patterns: [/\b(zara|tyler|zoe|jordan|maya|vera|kai|chris|leo)\b/i],
    reason: 'That specialist is not part of the LevelUp Growth team.',
    alternative: 'Redirect to the agents who are: Sarah (orchestration), James (SEO), Alex (technical SEO), Priya (content), Marcus (social), Elena (CRM).',
  },
];

function detectOutOfScope(message) {
  if (typeof message !== 'string' || message.trim() === '') return null;
  for (const entry of OUT_OF_SCOPE_PATTERNS) {
    if (entry.patterns.some(p => p.test(message))) return entry;
  }
  return null;
}

const INTENT_PRIORITY = { execution: 100, advisory: 50 };

// ── Intent pattern catalogue ──────────────────────────────────────────────────
// Each entry: { patterns[], intent, tools[], reasoning }
// intent_type is derived from INTENT_TYPE map above.
const INTENT_PATTERNS = [

  // ── SEO ──────────────────────────────────────────────────────────────────
  {
    patterns: [/competitor|rank|ranking|serp|who.*ranks|top.*result|search.*result/i],
    intent:   'competitor_research',
    tools:    ['serp_analysis'],
    reasoning: 'User is asking about search rankings or competitors — serp_analysis returns live SERP data.',
  },
  {
    patterns: [/audit.*site|site.*audit|seo.*audit|technical.*seo|crawl.*error|page.*speed/i],
    intent:   'seo_audit',
    tools:    ['deep_audit', 'get_site_pages'],
    reasoning: 'User wants an SEO audit — deep_audit provides full technical + content analysis.',
  },
  {
    patterns: [/optimi[sz]e.*(?:seo|search|ranking|content)|improve.*(?:seo|search|ranking)|seo.*(?:strateg|plan|recommend|tip|improvement|help)|better.*(?:ranking|seo)/i],
    intent:   'seo_advisory',
    tools:    ['serp_analysis', 'deep_audit'],
    reasoning: 'User wants SEO optimization advice — serp_analysis + deep_audit provide the data needed.',
  },
  {
    patterns: [/write.*article|create.*post|generate.*blog|draft.*content|seo.*article/i],
    intent:   'content_generation',
    tools:    ['write_article', 'serp_analysis'],
    reasoning: 'User wants content generated — write_article creates SEO-optimised articles.',
  },
  {
    patterns: [/content.*gap|missing.*content|what.*pages|existing.*content|do we.*cover|already.*written|do we have content|have.*content.*about|content.*about|pages.*about|written.*about/i],
    intent:   'content_gap',
    tools:    ['search_site_content', 'get_site_pages'],
    reasoning: 'User is checking content coverage — search_site_content finds existing pages on a topic.',
  },
  {
    patterns: [/keyword|volume|difficulty|what.*keyword|target.*keyword|focus.*keyword/i],
    intent:   'keyword_research',
    tools:    ['serp_analysis', 'ai_status'],
    reasoning: 'User needs keyword intelligence — serp_analysis returns keyword and competitor data.',
  },
  {
    patterns: [/internal.*link|link.*suggestion|link.*opportunity|linking.*strategy/i],
    intent:   'internal_links',
    tools:    ['link_suggestions', 'get_site_pages'],
    reasoning: 'User is asking about internal linking — link_suggestions finds link opportunities.',
  },
  {
    patterns: [/outbound.*link|external.*link|broken.*link|link.*check/i],
    intent:   'outbound_links',
    tools:    ['outbound_links', 'check_outbound'],
    reasoning: 'User wants to audit outbound links.',
  },

  // ── Website / Content ─────────────────────────────────────────────────────
  {
    patterns: [/what.*page|what.*site|homepage|services.*page|about.*page|read.*website|site.*content|scan.*url/i],
    intent:   'site_content',
    tools:    ['get_site_pages', 'scan_site_url', 'search_site_content'],
    reasoning: 'User wants to know about website content — get_site_pages lists scanned pages.',
  },
  {
    patterns: [/build.*(?:website|site|web\s*presence)|create.*(?:website|site)|make.*(?:website|site)|set.*up.*(?:website|site)|(?:website|site)\s+for.*(?:company|business|agency|brand|startup)/i],
    intent:   'website_building',
    tools:    ['create_website'],
    reasoning: 'User wants a full website built for their business — create_website generates all pages.',
  },
  {
    patterns: [/build.*(?:page|landing.*page)|create.*(?:page|landing)|new.*(?:page)|generate.*layout|make.*(?:page)/i],
    intent:   'page_building',
    tools:    ['generate_page_layout', 'list_builder_pages'],
    reasoning: 'User wants a single page or landing page built — generate_page_layout creates AI layouts.',
  },

  // ── CRM ──────────────────────────────────────────────────────────────────
  {
    patterns: [/lead|prospect|pipeline|crm|contact.*list|how many.*lead|show.*lead/i],
    intent:   'crm_query',
    tools:    ['list_leads'],
    reasoning: 'User is asking about CRM data — list_leads returns current pipeline.',
  },
  {
    patterns: [/add.*lead|new.*lead|create.*contact|add.*prospect/i],
    intent:   'crm_create',
    tools:    ['create_lead'],
    reasoning: 'User wants to add a lead to CRM.',
  },

  // ── Studio (Visual Design) — Sarah × Studio Phase 1 2026-06-03 ────────────
  {
    patterns: [/visual|design|graphic|poster|banner|flyer|carousel|story.*image|reel.*cover|IG.*image|insta.*image|create.*image|need.*(?:a\s)?(?:graphic|visual|image|design)/i],
    intent:   'visual_create',
    tools:    ['generate_design'],
    reasoning: 'User wants a visual asset created — generate_design picks the right template, applies brand, and produces a draft for approval.',
  },
  {
    patterns: [/list.*template|browse.*(?:design|template)|design.*library|template.*library|show.*template|what.*template/i],
    intent:   'template_browse',
    tools:    ['list_design_templates'],
    reasoning: 'User wants to see available templates — list_design_templates returns the full catalog with industry/format tags.',
  },

  // ── Social (v2.37.10, DEC-0028) — execution is Laravel-native (Sarah → create_tasks →
  //    social engine); the router only classifies the intent so the assistant answers truthfully.
  {
    patterns: [/social.*(?:post|media|campaign|calendar|content|strategy)|post.*(?:on|to).*(?:linkedin|instagram|facebook|tiktok|twitter|x\b)|(?:linkedin|instagram|facebook|tiktok).*post|hashtag|caption.*for|cross.?post|repurpose.*for.*(?:linkedin|insta|tiktok)/i],
    intent:   'social_content',
    tools:    [],
    reasoning: 'User wants a social post drafted, scheduled or published — Marcus (social) handles it through the platform\'s social engine; publishing needs a connected account and the owner\'s approval.',
  },
  // ── OUT OF LAUNCH SCOPE (v2.37.3) ────────────────────────────────────────
  // The social-composing, social-analytics, email-marketing and sequence
  // intents that used to live here have been REMOVED. Their trigger patterns
  // now resolve through OUT_OF_SCOPE_PATTERNS below, which returns an explicit
  // "not part of the product" result plus a retained alternative — rather than
  // routing to tools the kernel will refuse. See launch-scope.js.

  // ── Calendar ──────────────────────────────────────────────────────────────
  {
    patterns: [/schedule|calendar|booking|event|meeting.*time|available.*slot/i],
    intent:   'calendar',
    tools:    ['list_events', 'check_availability'],
    reasoning: 'User is asking about scheduling — list_events shows upcoming calendar.',
  },

  // ── Platform status ───────────────────────────────────────────────────────
  {
    patterns: [/status|health|platform.*ok|ai.*ready|system.*check/i],
    intent:   'platform_status',
    tools:    ['ai_status'],
    reasoning: 'User wants platform status — ai_status returns engine readiness.',
  },

  // ── Analytics / Reports ───────────────────────────────────────────────────
  {
    patterns: [/how.*perform|analytics|report|metrics|stats|results/i],
    intent:   'analytics_report',
    tools:    ['list_leads', 'proactive_status'],
    reasoning: 'User wants performance data — list tools return current counts and status.',
  },
  {
    patterns: [/how many.*lead|lead.*count|pipeline.*status|crm.*status|lead.*stage/i],
    intent:   'crm_report',
    tools:    ['list_leads'],
    reasoning: 'User wants CRM data — list_leads returns pipeline counts and stages.',
  },

  // ── Cross-domain workflows ────────────────────────────────────────────────
  {
    patterns: [/write.*article.*publish|article.*publish|blog.*publish/i],
    intent:   'seo_content_chain',
    tools:    ['write_article', 'serp_analysis'],
    reasoning: 'Cross-domain: SEO + Content chain — research the SERP then write the article.',
  },

  // ── Funnel ────────────────────────────────────────────────────────────────
  {
    patterns: [/funnel|buyer.*journey|conversion.*path|marketing.*funnel|growth.*plan/i],
    intent:   'funnel_strategy',
    tools:    ['generate_funnel_blueprint', 'analyze_funnel_structure'],
    reasoning: 'User wants funnel strategy — generate_funnel_blueprint creates an AI marketing funnel.',
  },

  // ── Publishing ────────────────────────────────────────────────────────────
  {
    patterns: [/go.*live|push.*live|publish.*page|publish.*site|publish.*website/i],
    intent:   'publish_action',
    tools:    ['publish_builder_page', 'export_website'],
    reasoning: 'User wants to publish — publish_builder_page deploys pages, export_website ships the site.',
  },

  // ── System / Memory ───────────────────────────────────────────────────────
  {
    patterns: [/what.*remember|memory|context|history|what.*know|previous|last.*time/i],
    intent:   'memory_query',
    tools:    ['memory_context', 'proactive_status'],
    reasoning: 'User asking about stored context — memory_context returns agent memory for a domain.',
  },
  {
    patterns: [/pending|awaiting.*approval|review.*action|approve|preview/i],
    intent:   'approval_queue',
    tools:    ['list_previews'],
    reasoning: 'User asking about pending actions — list_previews shows actions awaiting approval.',
  },
];

/**
 * Detect intent from message and return recommended tools for that agent.
 * Uses priority scoring: execution (100) always outranks advisory (50).
 *
 * @param {string} message   — user message text
 * @param {string} agentId   — agent executing (for capability filter)
 * @returns {{
 *   primary_intent: string,
 *   intent: string,          // alias for backward compat
 *   tools: string[],
 *   reasoning: string,
 *   intent_type: string,     // 'execution' | 'advisory'
 *   secondary_intents: Array<{intent, tools, reasoning, intent_type}>,
 *   post_execution_suggestions: string[]
 * }}
 */
function routeIntent(message, agentId = 'dmm') {
  // ── LAUNCH SCOPE SHORT-CIRCUIT ──
  // Out-of-scope requests never reach the pattern catalogue. Returning an
  // explicit `out_of_scope` intent with zero tools means the assistant states
  // the limitation and offers a retained alternative, rather than selecting a
  // tool that would be denied downstream.
  const outOfScope = detectOutOfScope(message);
  if (outOfScope) {
    return {
      primary_intent:            'out_of_scope',
      intent:                    'out_of_scope',
      intent_type:               'unavailable',
      out_of_scope:              true,
      tools:                     [],
      reasoning:                 `${outOfScope.reason} ${outOfScope.alternative}`,
      unavailable_reason:        outOfScope.reason,
      suggested_alternative:     outOfScope.alternative,
      secondary_intents:         [],
      post_execution_suggestions: [],
    };
  }

  const matched = [];

  for (const entry of INTENT_PATTERNS) {
    const hits = entry.patterns.filter(p => p.test(message));
    if (!hits.length) continue;

    // Filter tools to only those this agent can use. hasCapability() is now
    // launch-scope aware and denies removed tools outright, so a stale entry
    // can never survive this filter.
    const allowedTools = entry.tools.filter(t => !launchScope.isRemovedTool(t) && hasCapability(agentId, t));
    if (!allowedTools.length) continue;

    const intent_type = INTENT_TYPE[entry.intent] || 'advisory';
    const priority    = INTENT_PRIORITY[intent_type] || 50;

    matched.push({
      intent:      entry.intent,
      intent_type,
      priority,
      tools:       allowedTools,
      reasoning:   entry.reasoning,
      strength:    hits.length,
      // Composite score: priority × hits. Execution needs 2× advisory hits to lose.
      score:       priority * hits.length,
    });
  }

  if (!matched.length) {
    return {
      primary_intent:            'general',
      intent:                    'general',
      intent_type:               'advisory',
      tools:                     [],
      reasoning:                 '',
      secondary_intents:         [],
      post_execution_suggestions: [],
    };
  }

  // Sort by composite score (execution × hits always > advisory × hits unless ratio > 2:1)
  matched.sort((a, b) => b.score - a.score);

  const primary       = matched[0];
  const secondaries   = matched.slice(1);

  // Separate secondary execution and advisory intents
  const secondaryExec    = secondaries.filter(m => m.intent_type === 'execution');
  const secondaryAdvisory = secondaries.filter(m => m.intent_type === 'advisory');

  // Post-execution suggestions: advisory intents deduped
  const postExecSuggestions = [...new Set(secondaryAdvisory.flatMap(m => m.tools))].slice(0, 3);

  // Primary tools + any secondary execution tools queued for chaining (deduped, max 4)
  const chainTools = [...new Set([
    ...primary.tools,
    ...secondaryExec.flatMap(m => m.tools),
  ])].slice(0, 4);

  const reasonParts = [primary.reasoning, ...secondaryExec.map(m => m.reasoning)]
    .filter(Boolean)
    .slice(0, 2);

  return {
    primary_intent:             primary.intent,
    intent:                     primary.intent,   // backward compat
    intent_type:                primary.intent_type,
    tools:                      chainTools,
    reasoning:                  reasonParts.join(' Then: '),
    secondary_intents:          secondaries.map(m => ({
      intent:      m.intent,
      intent_type: m.intent_type,
      tools:       m.tools,
      reasoning:   m.reasoning,
    })),
    post_execution_suggestions: postExecSuggestions,
  };
}

/**
 * Format tool suggestions as a prompt injection block.
 * Execution intents clearly marked as EXECUTE, not suggest.
 */
function formatToolSuggestions(suggestions) {
  if (!suggestions.tools.length) return '';

  const isExecution = suggestions.intent_type === 'execution';
  const directive   = isExecution
    ? 'EXECUTE this action now using the tool below. Do NOT explain or suggest first.'
    : 'Use this tool to gather data before responding.';

  const postExecBlock = suggestions.post_execution_suggestions?.length
    ? `
AFTER SUCCESSFUL EXECUTION, you may suggest: ${suggestions.post_execution_suggestions.join(', ')}`
    : '';

  return `
${isExecution ? '⚡ EXECUTION INTENT DETECTED — Act, do not advise.' : '📊 ADVISORY INTENT — Use tool for data.'}
PRIMARY ACTION: ${directive}
${suggestions.tools.map(t => `  • ${t}`).join('\n')}
Reasoning: ${suggestions.reasoning}${postExecBlock}`;
}

module.exports = { routeIntent, formatToolSuggestions };
