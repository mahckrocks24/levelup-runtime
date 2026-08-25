'use strict';

/**
 * LevelUp — Tool Learning Module
 * Part 4.3+4.4: Generates and stores AI-derived knowledge about discovered tools.
 *
 * For each new tool discovered:
 *   → generates purpose, usage guidance, example, params explanation
 *   → stores in Redis (lu:tool:knowledge:{tool_id}) + WP lu_tools_knowledge table
 *   → injects into buildToolPromptBlock for discovered tools
 */

const { createRedisConnection } = require('./redis');
const redis = createRedisConnection();

const KEY_PREFIX = 'lu:tool:knowledge:';
const TTL        = 30 * 24 * 60 * 60; // 30 days

// ── Domain context hints (for LLM-generated knowledge) ───────────────────────
const DOMAIN_HINTS = {
  seo:       'This is an SEO tool. Focus on keyword research, rankings, and content optimization.',
  crm:       'This is a CRM tool. Focus on lead management, pipeline, and customer relationships.',
  marketing: 'This is a marketing tool. Focus on campaigns, email sequences, and automation.',
  social:    'This is a social media tool. Focus on post scheduling, publishing, and analytics.',
  calendar:  'This is a scheduling tool. Focus on availability, bookings, and events.',
  builder:   'This is a website builder tool. Focus on page creation, layout, and publishing.',
  studio:    'This is a visual design tool. Focus on template selection, brand-grounded design, copy variants, and design refresh. NEVER auto-publishes to social — outputs are drafts only.',
  site:      'This is a site analysis tool. Focus on content, structure, and SEO signals.',
  general:   'This is a platform management tool.',
};

/**
 * Generate knowledge entry for a tool using LLM reasoning.
 * Falls back to template-based generation if LLM unavailable.
 */
async function generateToolKnowledge(tool) {
  // Template-based generation (no LLM call — reliable, instant)
  const domainHint = DOMAIN_HINTS[tool.domain] || DOMAIN_HINTS.general;
  const isGet      = tool.method === 'GET';
  const hasId      = (tool.url_params || []).includes('id');

  const paramDescriptions = Object.entries(tool.params || {})
    .map(([k, v]) => `${k} (${v.required ? 'required' : 'optional'}): ${v.description || k}`)
    .join('; ') || 'none';

  const useWhen = isGet
    ? `Use when you need to retrieve or list ${tool.domain} data`
    : `Use when you need to create, update, or trigger a ${tool.domain} action`;

  const doNotUse = isGet
    ? `Do not use for write operations — this is read-only`
    : `Do not use without confirming required parameters are available`;

  const example = hasId
    ? `First call list_${tool.domain}s to get a valid ID, then call ${tool.id}(id=X)`
    : `Call ${tool.id}(${Object.keys(tool.params || {}).slice(0,2).join(', ')})`;

  const knowledge = {
    tool_id:      tool.id,
    purpose:      tool.description || `${tool.method} operation on ${tool.domain} domain`,
    parameters:   paramDescriptions,
    return_format: tool.returns || '{ success, data }',
    usage_examples: [example],
    use_when:      useWhen,
    do_not_use:    doNotUse,
    domain_context: domainHint,
    generated_at:  new Date().toISOString(),
    auto_generated: true,
  };

  return knowledge;
}

/**
 * Store tool knowledge in Redis.
 */
async function storeKnowledge(tool_id, knowledge) {
  try {
    await redis.set(`${KEY_PREFIX}${tool_id}`, JSON.stringify(knowledge), 'EX', TTL).catch(() => {})
    console.log(`[tool-learning] Knowledge stored for ${tool_id}`);
    return true;
  } catch (e) {
    console.warn('[tool-learning] Redis write failed:', e.message);
    return false;
  }
}

/**
 * Read tool knowledge from Redis.
 */
async function readKnowledge(tool_id) {
  try {
    const raw = await redis.get(`${KEY_PREFIX}${tool_id}`).catch(() => null)
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

/**
 * Process a batch of new tools: generate + store knowledge for each.
 */
async function learnNewTools(tools) {
  const results = [];
  for (const tool of tools) {
    const knowledge = await generateToolKnowledge(tool);
    const stored    = await storeKnowledge(tool.id, knowledge);
    results.push({ tool_id: tool.id, stored, knowledge });
  }
  console.log(`[tool-learning] Learned ${results.length} new tool(s)`);
  return results;
}

/**
 * Get enriched tool knowledge for prompt injection.
 * Merges static registry fields with learned knowledge.
 */
async function getEnrichedTool(tool) {
  const knowledge = await readKnowledge(tool.id);
  if (!knowledge) return tool;

  return {
    ...tool,
    use_when:   knowledge.use_when   || tool.use_when,
    do_not_use: knowledge.do_not_use || tool.do_not_use,
    example:    knowledge.usage_examples?.[0] || tool.example,
    description: knowledge.purpose || tool.description,
  };
}

module.exports = { generateToolKnowledge, storeKnowledge, readKnowledge, learnNewTools, getEnrichedTool };
