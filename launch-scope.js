'use strict';

/**
 * LevelUp Runtime — LAUNCH SCOPE POLICY
 *
 * Runtime mirror of Laravel `app/Core/LaunchScope/LaunchScopePolicy.php`.
 * Created 2026-07-21 (Workstream 3 — runtime sanitation, v2.37.3).
 *
 * WHY THIS EXISTS
 * ---------------
 * W3 removed social automation / social intelligence / email marketing and 10
 * agents from the AUTHORITATIVE Laravel layer. The runtime was neutralised only
 * at the Laravel boundary (`RuntimeClient` sanitizer). This module moves the
 * same decision INTO the runtime so that:
 *
 *   - a Laravel/API outage cannot restore removed agents via AGENTS_STATIC,
 *   - the planner cannot select a tool the kernel will always deny,
 *   - tool-discovery cannot auto-register a removed tool from a WP namespace,
 *   - stale Redis task memory cannot re-route work to a removed agent.
 *
 * DESIGN: deny-by-name, fail-closed. Every helper returns the SAFE answer when
 * given garbage input. This file must stay in sync with the Laravel policy —
 * if one changes, change both.
 */

// ── Agents removed from launch ────────────────────────────────────────────
// Runtime keys. NOTE: Sarah's runtime key is `dmm`, NOT `sarah` — ~25 call
// sites depend on `dmm`. She is RETAINED (constrained), never removed.
const REMOVED_AGENTS = Object.freeze([
    'marcus', 'jordan', 'tyler', 'zara', 'zoe', 'maya', // social
    'vera', 'kai',                                       // email
    'chris', 'leo',                                      // video / ad copy
]);

// ── Agents retained at launch (runtime keys) ──────────────────────────────
const RETAINED_AGENTS = Object.freeze([
    'dmm',                                    // Sarah — orchestrator
    'james', 'alex', 'diana', 'ryan', 'sofia', // SEO
    'priya', 'nora',                          // content
    'elena', 'max',                           // CRM / growth
]);

// ── Agents retained but CONSTRAINED (social/email grants revoked in W3) ────
const CONSTRAINED_AGENTS = Object.freeze(['dmm', 'priya', 'elena', 'max', 'nora', 'sofia']);

// ── Tools removed from launch ─────────────────────────────────────────────
// Mirrors Laravel REMOVED_TOOLS + every alias/variant found in the runtime.
const REMOVED_TOOLS = Object.freeze([
    // ── social: composing / publishing / scheduling / analytics ──
    'create_post', 'social_create_post',
    'update_post', 'list_posts',
    'schedule_post', 'social_schedule_post', 'social_schedule',
    'publish_post', 'social_publish_post',
    'get_queue',
    'record_social_analytics', 'social_analytics',
    // ── social: AI generation ──
    'social_ai_post', 'ai_generate_social_post', 'ai_social_post',
    'social_image', 'social_image_gen',
    'hashtag_suggestions', 'generate_hashtags',
    'social_platform_adapt',
    // ── email marketing: campaigns ──
    'create_campaign', 'update_campaign', 'delete_campaign', 'list_campaigns',
    'schedule_campaign', 'send_campaign', 'send_email_campaign',
    'create_automation', 'toggle_automation', 'run_automation',
    'ai_campaign_copy',
    // ── email marketing: templates ──
    'create_template', 'list_templates', 'update_template', 'delete_template',
    // ── email marketing: sending / AI copy ──
    'record_metric',
    'test_send_email', 'send_email', 'email_send_test',
    'ai_generate_email', 'ai_rewrite_block', 'ai_suggest_subjects', 'ai_spam_check',
    'email_ai_generate', 'email_block_rewrite', 'email_subject_suggest', 'email_spam_check',
    // ── sequences / drip ──
    'enroll_sequence', 'list_sequences',
    'create_sequence', 'update_sequence', 'delete_sequence', 'toggle_sequence',
    // ── cross-surface distribution ──
    'content_publish_pack',
]);

const _REMOVED_AGENT_SET = new Set(REMOVED_AGENTS);
const _RETAINED_AGENT_SET = new Set(RETAINED_AGENTS);
const _REMOVED_TOOL_SET = new Set(REMOVED_TOOLS);

/**
 * The ONLY social actions permitted at launch — the blog-article-share sliver.
 *
 * These are NOT granted to any agent in capability-map.js. The retained
 * article-distribution service executes them with NO agent_id, so it bypasses
 * the agent-capability check entirely and is governed by the Laravel kernel.
 * They are listed here so `isArticleShareAction()` can recognise them, NOT so
 * they can be selected generally.
 */
const ARTICLE_SHARE_ACTIONS = Object.freeze([
    'social_create_post', 'create_post',
    'social_schedule_post', 'schedule_post',
    'social_publish_post', 'publish_post',
    'list_posts', 'update_post', 'get_queue',
]);
const _ARTICLE_SHARE_SET = new Set(ARTICLE_SHARE_ACTIONS);

// ── Predicates (fail closed on garbage) ───────────────────────────────────

/** True when `id` names an agent removed from launch. */
function isRemovedAgent(id) {
    if (typeof id !== 'string') return false;
    return _REMOVED_AGENT_SET.has(id.trim().toLowerCase());
}

/** True ONLY for an explicitly retained launch agent. Unknown → false. */
function isRetainedAgent(id) {
    if (typeof id !== 'string') return false;
    return _RETAINED_AGENT_SET.has(id.trim().toLowerCase());
}

/** True when `id` names a tool removed from launch. */
function isRemovedTool(id) {
    if (typeof id !== 'string') return false;
    return _REMOVED_TOOL_SET.has(id.trim().toLowerCase());
}

/**
 * Article-share context marker. Mirrors Laravel isArticleShareContext().
 * Requires an explicit marker AND a concrete article reference — a bare
 * `source: 'article_share'` string is not enough to unlock publishing.
 */
function isArticleShareContext(ctx) {
    if (!ctx || typeof ctx !== 'object') return false;
    const marked = ctx.article_share === true
        || ctx.source === 'article_share'
        || ctx.context === 'article_share'
        || ctx.intent === 'article_share';
    if (!marked) return false;
    const hasArticle = Number.isInteger(ctx.article_id) && ctx.article_id > 0;
    const hasUrl = typeof ctx.article_url === 'string' && /^https?:\/\//i.test(ctx.article_url);
    return hasArticle || hasUrl;
}

/** True when the action is the retained article-share sliver IN article-share context. */
function isArticleShareAction(toolId, ctx) {
    if (typeof toolId !== 'string') return false;
    if (!_ARTICLE_SHARE_SET.has(toolId.trim().toLowerCase())) return false;
    return isArticleShareContext(ctx);
}

// ── Collection filters ────────────────────────────────────────────────────

/** Drop removed agents from an array of agent ids. Non-arrays → []. */
function filterAgentIds(ids) {
    if (!Array.isArray(ids)) return [];
    return ids.filter(id => typeof id === 'string' && id.trim() !== '' && !isRemovedAgent(id));
}

/** Drop removed tools from an array of tool ids. Non-arrays → []. */
function filterToolIds(ids) {
    if (!Array.isArray(ids)) return [];
    return ids.filter(id => typeof id === 'string' && id.trim() !== '' && !isRemovedTool(id));
}

/** Drop removed-agent keys from a plain object keyed by agent id. */
function filterAgentMap(map) {
    if (!map || typeof map !== 'object') return {};
    const out = {};
    for (const key of Object.keys(map)) {
        if (isRemovedAgent(key)) continue;
        out[key] = map[key];
    }
    return out;
}

/** Drop removed-tool keys from a plain object keyed by tool id. */
function filterToolMap(map) {
    if (!map || typeof map !== 'object') return {};
    const out = {};
    for (const key of Object.keys(map)) {
        if (isRemovedTool(key)) continue;
        out[key] = map[key];
    }
    return out;
}

/**
 * Compatibility filter for historical records (Redis task memory, meeting
 * history, behaviour stats). Marks removed-agent / removed-tool references as
 * unavailable WITHOUT erasing history — the record survives as inert history
 * but can never be re-executed, re-assigned, or re-planned.
 */
function markHistoricalRecord(record) {
    if (!record || typeof record !== 'object') return record;
    const assignee = record.assignee || record.agent_id || record.agent || null;
    const tools = Array.isArray(record.tools) ? record.tools : [];
    const agentRemoved = isRemovedAgent(assignee);
    const toolRemoved = tools.some(isRemovedTool);
    if (!agentRemoved && !toolRemoved) return record;
    return {
        ...record,
        launch_scope_removed: true,
        executable: false,
        assignable: false,
        removed_reason: agentRemoved
            ? `agent '${assignee}' is not available at launch`
            : 'references a capability not available at launch',
    };
}

/** True when a historical record may still influence routing/planning. */
function isExecutableRecord(record) {
    if (!record || typeof record !== 'object') return false;
    if (record.launch_scope_removed === true) return false;
    const assignee = record.assignee || record.agent_id || record.agent || null;
    if (isRemovedAgent(assignee)) return false;
    const tools = Array.isArray(record.tools) ? record.tools : [];
    return !tools.some(isRemovedTool);
}

module.exports = {
    REMOVED_AGENTS,
    RETAINED_AGENTS,
    CONSTRAINED_AGENTS,
    REMOVED_TOOLS,
    ARTICLE_SHARE_ACTIONS,
    isRemovedAgent,
    isRetainedAgent,
    isRemovedTool,
    isArticleShareContext,
    isArticleShareAction,
    filterAgentIds,
    filterToolIds,
    filterAgentMap,
    filterToolMap,
    markHistoricalRecord,
    isExecutableRecord,
};
