'use strict';

/**
 * LevelUp Capability Map
 *
 * Defines which tools each agent is permitted to use.
 * This is the single source of truth for agent permissions.
 *
 * When new tools are added (CRM, Builder, Studio, etc.),
 * add them to the relevant agent's list here.
 *
 * ── LAUNCH SCOPE (2026-07-21, v2.37.3, Workstream 3 runtime sanitation) ──
 * Social automation/intelligence and email marketing are OUT of launch scope.
 * Marcus (social) is removed entirely. Sarah (dmm), Priya and Elena keep their
 * retained work but their social/email/sequence grants are revoked here to
 * match the Laravel `agent_capabilities` revocation (42 rows soft-disabled in
 * W3). The runtime must never SELECT a tool the Laravel kernel will deny.
 *
 * The retained blog-article-share sliver is deliberately NOT granted to any
 * agent: the article-distribution service executes it with no agent_id and is
 * governed by the kernel's article-share context check. See launch-scope.js.
 *
 * Agents:
 *   dmm     → Sarah  (DMM Director — orchestration + goals)   [constrained]
 *   james   → James  (SEO Strategist)
 *   priya   → Priya  (Content Manager)                        [constrained]
 *   elena   → Elena  (CRM & Lead Manager)                     [constrained]
 *   alex    → Alex   (Technical SEO Engineer)
 */

const launchScope = require('./launch-scope');

const CAPABILITY_MAP = {

    // Marcus — Social Media Manager (restored v2.37.10, DEC-0028). Execution is Laravel-native;
    // these grants let the planner/roster route social work to him.
    marcus: [
        'ai_status', 'list_goals', 'agent_status',
        'create_post', 'schedule_post', 'publish_post', 'list_posts', 'update_post', 'get_queue',
        'ai_generate_social_post', 'generate_hashtags', 'social_platform_adapt',
        'list_events', 'check_availability',
        'generate_design', 'pick_design_template', 'list_design_templates',
        'system_health_check', 'memory_context',
    ],

    // Sarah — DMM Director (orchestration, growth management, coordination)
    dmm: [
        // Goals / orchestration
        'autonomous_goal', 'list_goals', 'agent_status', 'pause_goal', 'ai_status',
        // CRM — retained (lead management, no email sequences)
        'create_lead', 'get_lead', 'update_lead', 'list_leads', 'move_lead',
        'log_activity', 'add_note',
        // Calendar
        'create_event', 'list_events', 'update_event', 'check_availability', 'create_booking_slot',
        // Studio (Visual Design) — direct creative generation is RETAINED
        'generate_design', 'pick_design_template', 'list_design_templates',
        // Builder
        'list_builder_pages', 'get_builder_page', 'ai_builder_action',
        'generate_page_layout', 'publish_builder_page', 'import_html_page',
        // Site intelligence
        'get_site_pages', 'get_site_page', 'search_site_content', 'scan_site_url',
        // Funnel intelligence
        'generate_funnel_blueprint', 'analyze_funnel_structure',
        // System intelligence
        'system_health_check', 'list_previews', 'proactive_status', 'memory_context',
    ],

    // James — SEO Strategist
    james: [
        // SEO — full access including link analysis
        'serp_analysis', 'ai_report', 'deep_audit', 'ai_status', 'list_goals', 'agent_status', 'pause_goal',
        'link_suggestions', 'outbound_links', 'check_outbound',
        // CRM — read only
        'get_lead', 'list_leads',
        // Calendar
        'list_events', 'check_availability', 'create_event', 'update_event',
        // Builder — read only
        'list_builder_pages', 'get_builder_page',
        // Site intelligence
        'get_site_pages', 'get_site_page', 'search_site_content', 'scan_site_url',
        // Funnel analysis
        'analyze_funnel_structure',
    ],

    // Priya — Content Manager (blog/article creation + content analysis)
    priya: [
        // Content / SEO
        'write_article', 'improve_draft', 'ai_report', 'ai_status', 'list_goals', 'agent_status',
        // Calendar
        'list_events', 'check_availability', 'create_event', 'update_event',
        // Builder — content generation
        'list_builder_pages', 'get_builder_page', 'ai_builder_action', 'generate_page_layout',
        // Site intelligence — read only
        'get_site_pages', 'get_site_page', 'search_site_content',
        // Funnel
        'generate_funnel_blueprint', 'analyze_funnel_structure',
    ],

    // Elena — CRM & Lead Manager (no email sequences / campaigns at launch)
    elena: [
        // Utility
        'ai_status', 'list_goals', 'agent_status',
        // CRM — full lead management
        'create_lead', 'get_lead', 'update_lead', 'list_leads', 'move_lead',
        'log_activity', 'add_note',
        // Calendar — full access
        'create_event', 'list_events', 'update_event', 'check_availability', 'create_booking_slot',
    ],

    // Alex — Technical SEO Engineer
    alex: [
        // SEO — full technical access
        'deep_audit', 'link_suggestions', 'insert_link', 'dismiss_link', 'outbound_links', 'check_outbound',
        'ai_status', 'list_goals', 'agent_status', 'pause_goal',
        // Calendar
        'list_events', 'check_availability', 'create_event', 'update_event',
        // Builder — full technical access
        'list_builder_pages', 'get_builder_page', 'import_html_page',
        'hydrate_page', 'export_page', 'export_website', 'publish_builder_page', 'ai_builder_action',
        // Site intelligence — full access for technical SEO
        'get_site_pages', 'get_site_page', 'search_site_content', 'scan_site_url',
    ],
};

/**
 * Normalise a capability array into a clean, dense list of valid tool ids.
 *
 * Defends against the malformed-literal class of bug that previously existed
 * in this file: array elisions (`['a', , 'b']`) create SPARSE HOLES which read
 * back as `undefined`, and `Array.prototype.includes(undefined)` returns TRUE
 * for a hole. That made `hasCapability(agent, undefined)` grant permission.
 * Holes, non-strings, blanks and launch-removed tools are all dropped here.
 */
function normaliseCapabilityList(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    // Index-based loop + hasOwnProperty: skips holes explicitly rather than
    // relying on iteration-order semantics.
    for (let i = 0; i < list.length; i++) {
        if (!Object.prototype.hasOwnProperty.call(list, i)) continue; // sparse hole
        const raw = list[i];
        if (typeof raw !== 'string') continue;
        const id = raw.trim();
        if (id === '') continue;
        if (launchScope.isRemovedTool(id)) continue; // defence in depth
        if (!out.includes(id)) out.push(id);
    }
    return out;
}

// Pre-normalised map — every list is dense, deduped and launch-scope clean.
const _NORMALISED = Object.keys(CAPABILITY_MAP).reduce((acc, agentId) => {
    if (launchScope.isRemovedAgent(agentId)) return acc; // never expose removed agents
    acc[agentId] = normaliseCapabilityList(CAPABILITY_MAP[agentId]);
    return acc;
}, {});

/**
 * Get the list of tool IDs an agent can use.
 * Unknown or removed agent → [] (deny by default).
 * @param {string} agentId
 * @returns {string[]}
 */
function getToolIds(agentId) {
    if (typeof agentId !== 'string') return [];
    const id = agentId.trim().toLowerCase();
    if (id === '') return [];
    if (launchScope.isRemovedAgent(id)) return [];
    const list = _NORMALISED[id];
    return Array.isArray(list) ? list.slice() : [];
}

/**
 * Check if an agent has a specific capability.
 *
 * DENY BY DEFAULT. Returns false for: undefined, null, '', whitespace-only,
 * non-string input, unknown capability, unknown agent, removed agent, removed
 * tool, and malformed/sparse capability arrays. Garbage input is NEVER coerced
 * into a valid permission.
 *
 * @param {string} agentId
 * @param {string} toolId
 * @returns {boolean}
 */
function hasCapability(agentId, toolId) {
    if (typeof agentId !== 'string' || typeof toolId !== 'string') return false;

    const agent = agentId.trim().toLowerCase();
    const tool = toolId.trim();
    if (agent === '' || tool === '') return false;

    if (launchScope.isRemovedAgent(agent)) return false;
    if (launchScope.isRemovedTool(tool)) return false;

    const list = _NORMALISED[agent];
    if (!Array.isArray(list)) return false; // unknown or malformed agent → fail closed

    return list.includes(tool);
}

/**
 * Get a human-readable capability summary for an agent (for debugging/UI).
 * @param {string} agentId
 * @returns {object}
 */
function getAgentCapabilitySummary(agentId) {
    const registry = require('./tool-registry');
    const toolIds = getToolIds(agentId);
    const tools = toolIds.map(id => registry.getTool(id)).filter(Boolean);

    return {
        agent: agentId,
        tool_count: tools.length,
        tools: tools.map(t => ({ id: t.id, name: t.name, domain: t.domain, requires_approval: t.requires_approval })),
        domains: [...new Set(tools.map(t => t.domain))],
    };
}

/**
 * Get full capability map (for admin/debugging).
 * @returns {object}
 */
function getAllCapabilities() {
    return Object.keys(_NORMALISED).reduce((acc, agentId) => {
        acc[agentId] = getAgentCapabilitySummary(agentId);
        return acc;
    }, {});
}

module.exports = {
    CAPABILITY_MAP: _NORMALISED,
    getToolIds,
    hasCapability,
    getAgentCapabilitySummary,
    getAllCapabilities,
    normaliseCapabilityList,
};
