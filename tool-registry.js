'use strict';

/**
 * LevelUp Tool Registry — Phase 1 (flat single-file version)
 *
 * Domain structure is maintained via the `domain` property on each tool.
 * When Phase 2 splits into 3 plugins, this file splits into separate domain
 * files — no logic changes needed, just reorganisation.
 *
 * Domains registered here: seo (15 tools)
 * Domains stubbed for Phase 3+: crm, marketing, social, calendar, builder, governance
 */

// ── Lazy ref to capability-map to avoid circular dep ──────────────────────
let _capMap = null;
function capMap() {
    if (!_capMap) _capMap = require('./capability-map');
    return _capMap;
}

// ══════════════════════════════════════════════════════════════════════════
// SEO DOMAIN — 15 verified tools (source-confirmed v5.9.1)
// All endpoints confirmed live: 401/403 on health check = exists, auth ok
// ══════════════════════════════════════════════════════════════════════════
const SEO_TOOLS = {

    // ── SERP & Analysis ────────────────────────────────────────────────────

    serp_analysis: {
        id:               'serp_analysis',
        domain:           'seo',
        name:             'SERP Analysis',
        description:      'Fetch live SERP competitor data for a keyword. Returns top-ranking pages, competitor content, and a serp_run_id for use in ai_report.',
        example:          "If user asks 'who ranks for luxury furniture Dubai' → call serp_analysis(keyword='luxury furniture Dubai').",
        do_not_use:          'When the question is not about search rankings, or when no keyword is specified.',
        use_when:          'The user asks about competitors, keyword rankings, or SERP features for a specific keyword.',
        wp_path:          '/lugs/v1/serp-analysis',
        method:           'POST',
        url_params:       [],
        body_params:      ['keyword', 'post_id', 'location', 'language'],
        query_params:     [],
        params: {
            keyword:  { type: 'string',  required: true,  description: 'Target keyword to analyse SERP for' },
            post_id:  { type: 'integer', required: false, description: 'Optional post ID to associate results with' },
            location: { type: 'string',  required: false, description: 'Location code for localised results' },
            language: { type: 'string',  required: false, description: 'Language code, default en' },
        },
        returns:          '{ success, results[], result_count, serp_run_id }',
        requires_approval: false,
        allowed_agents:   ['james'],
    },

    ai_report: {
        id:               'ai_report',
        domain:           'seo',
        name:             'AI Content Intelligence Report',
        description:      'Generate a full AI content intelligence report for a post. Analyses GSC data, competitor content, and returns strategic recommendations. Run serp_analysis first to get serp_run_id.',
        wp_path:          '/lugs/v1/ai-report',
        method:           'POST',
        url_params:       [],
        body_params:      ['post_id', 'keyword', 'serp_run_id'],
        query_params:     [],
        params: {
            post_id:     { type: 'integer', required: true,  description: 'WordPress post ID to generate report for' },
            keyword:     { type: 'string',  required: true,  description: 'Focus keyword for the report' },
            serp_run_id: { type: 'integer', required: false, description: 'serp_run_id from a prior serp_analysis call' },
        },
        returns:          '{ success, report, cached, timestamp }',
        requires_approval: false,
        allowed_agents:   ['james', 'priya'],
    },

    deep_audit: {
        id:               'deep_audit',
        domain:           'seo',
        name:             'Deep Content Audit',
        description:      'Run a deep SEO audit on a specific post. Pulls GSC data, audit breakdown, competitor SERP, and generates a comprehensive AI analysis report.',
        example:          "User says 'audit my homepage' → get post_id from list_builder_pages, then call deep_audit(post_id=X).",
        do_not_use:          'For general questions not tied to a specific post_id. Run serp_analysis first.',
        use_when:          'You need a full technical + content SEO audit of a specific page before making recommendations.',
        wp_path:          '/lugs/v1/deep-audit',
        method:           'POST',
        url_params:       [],
        body_params:      ['post_id', 'keyword'],
        query_params:     [],
        params: {
            post_id: { type: 'integer', required: true,  description: 'WordPress post ID to audit' },
            keyword: { type: 'string',  required: false, description: 'Focus keyword — auto-resolved from post meta if omitted' },
        },
        returns:          '{ success, report, competitors[], timestamp }',
        requires_approval: false,
        allowed_agents:   ['james', 'alex'],
    },

    ai_status: {
        id:               'ai_status',
        domain:           'seo',
        name:             'AI Status Check',
        description:      'Check whether the AI engine (LevelUp Core + DeepSeek) is configured and ready. Use this before running AI-dependent tools.',
        wp_path:          '/lugs/v1/ai-status',
        method:           'GET',
        url_params:       [],
        body_params:      [],
        query_params:     [],
        params:           {},
        returns:          '{ core_active, ai_ready }',
        requires_approval: false,
        allowed_agents:   ['james', 'priya', 'alex', 'dmm', 'elena'],
    },

    // ── Content Generation ─────────────────────────────────────────────────

    improve_draft: {
        id:               'improve_draft',
        domain:           'seo',
        name:             'Improve Draft',
        description:      'Generate an AI-improved version of an existing post draft. Requires a prior AI report to exist for this post. Returns improved content with SEO enhancements.',
        wp_path:          '/lugs/v1/ai-draft',
        method:           'POST',
        url_params:       [],
        body_params:      ['post_id', 'keyword', 'ai_report_id'],
        query_params:     [],
        params: {
            post_id:      { type: 'integer', required: true,  description: 'WordPress post ID to improve' },
            keyword:      { type: 'string',  required: false, description: 'Focus keyword — auto-resolved from post meta if omitted' },
            ai_report_id: { type: 'integer', required: false, description: 'Specific AI report ID. Uses latest if omitted.' },
        },
        returns:          '{ success, draft_id, draft_content, created_at, cached }',
        requires_approval: true,
        approval_preview: 'Generate an improved draft for post #{post_id} targeting "{keyword}". Creates a new draft version — does not modify the live post.',
        allowed_agents:   ['priya', 'james'],  // fixed: both content agents can write
    },

    write_article: {
        id:               'write_article',
        domain:           'seo',
        name:             'Write SEO Article',
        description:      'Generate a full SEO-optimised article and save it as a WordPress draft post. Auto-selects the best keyword from site audit data if none given. Returns the edit URL.',
        example:          "User says 'write an article about office fit-out Dubai' → call write_article(keyword='office fit-out Dubai').",
        do_not_use:          'For research, analysis, or improving existing content. Use improve_draft instead.',
        use_when:          'User explicitly asks to generate a blog post or SEO article for a keyword.',
        wp_path:          '/lugs/v1/generate-seo-article',
        method:           'POST',
        url_params:       [],
        body_params:      ['keyword', 'context'],
        query_params:     [],
        params: {
            keyword: { type: 'string', required: false, description: 'Target keyword — auto-selected from site audit if omitted' },
            context: { type: 'string', required: false, description: 'Additional context or instructions for the article' },
        },
        returns:          '{ success, keyword, post_id, title, edit_url, preview_url, tokens_used, message }',
        requires_approval: true,
        approval_preview: 'Write and save a new SEO article{keyword ? \' targeting "\' + keyword + \'"\' : \' (keyword auto-selected)\'}. Creates a new WordPress draft post.',
        allowed_agents:   ['priya', 'james'],  // remediated: james also writes articles
    },

    // ── Internal Links ─────────────────────────────────────────────────────

    link_suggestions: {
        id:               'link_suggestions',
        domain:           'seo',
        name:             'Link Suggestions',
        description:      'Get internal link suggestions for a specific post. Returns up to 5 relevant target pages with relevance scores.',
        wp_path:          '/lugs/v1/link-suggestions/:post_id',
        method:           'GET',
        url_params:       ['post_id'],
        body_params:      [],
        query_params:     [],
        params: {
            post_id: { type: 'integer', required: true, description: 'WordPress post ID to get link suggestions for' },
        },
        returns:          '[{ id, target_post_id, target_title, target_url, relevance_score, status }]',
        requires_approval: false,
        allowed_agents:   ['alex'],
    },

    insert_link: {
        id:               'insert_link',
        domain:           'seo',
        name:             'Insert Internal Link',
        description:      'Insert a suggested internal link into post content. Finds matching anchor text and wraps it with the target link. Modifies live post content.',
        wp_path:          '/lugs/v1/link-suggestions/:id/insert',
        method:           'POST',
        url_params:       ['id'],
        body_params:      [],
        query_params:     [],
        params: {
            id: { type: 'integer', required: true, description: 'Suggestion ID from link_suggestions result' },
        },
        returns:          '{ success } or { success: false, message }',
        requires_approval: true,
        approval_preview: 'Insert internal link suggestion #{id} into live post content. This directly modifies the post.',
        allowed_agents:   ['alex'],
    },

    dismiss_link: {
        id:               'dismiss_link',
        domain:           'seo',
        name:             'Dismiss Link Suggestion',
        description:      'Mark an internal link suggestion as rejected so it no longer appears.',
        wp_path:          '/lugs/v1/link-suggestions/:id/dismiss',
        method:           'POST',
        url_params:       ['id'],
        body_params:      [],
        query_params:     [],
        params: {
            id: { type: 'integer', required: true, description: 'Suggestion ID to dismiss' },
        },
        returns:          '{ success }',
        requires_approval: false,
        allowed_agents:   ['alex'],
    },

    // ── Outbound Links ─────────────────────────────────────────────────────

    outbound_links: {
        id:               'outbound_links',
        domain:           'seo',
        name:             'Outbound Links',
        description:      'Get all outbound (external) links for a post. Returns each link with HTTP status, anchor text, and rel attributes.',
        wp_path:          '/lugs/v1/outbound-links/:post_id',
        method:           'GET',
        url_params:       ['post_id'],
        body_params:      [],
        query_params:     [],
        params: {
            post_id: { type: 'integer', required: true, description: 'WordPress post ID to get outbound links for' },
        },
        returns:          '[{ id, outbound_url, outbound_domain, anchor_text, rel_nofollow, http_status, recommended }]',
        requires_approval: false,
        allowed_agents:   ['alex'],
    },

    check_outbound: {
        id:               'check_outbound',
        domain:           'seo',
        name:             'Check Outbound Link Health',
        description:      'Run a live health scan of all outbound links in a post. Checks each external URL for 404s, redirects, and errors.',
        wp_path:          '/lugs/v1/outbound-links/:id/check',
        method:           'POST',
        url_params:       ['id'],
        body_params:      [],
        query_params:     [],
        params: {
            id: { type: 'integer', required: true, description: 'Post ID to scan outbound links for' },
        },
        returns:          '{ post_id, total, broken, redirects, links[{ url, anchor, status, ok, fix }] }',
        requires_approval: false,
        allowed_agents:   ['alex'],
    },

    // ── Autonomous Agent ───────────────────────────────────────────────────

    autonomous_goal: {
        id:               'autonomous_goal',
        domain:           'seo',
        name:             'Submit Autonomous Goal',
        description:      'Submit a natural language goal to the SEO agent system. The agent will autonomously break it into tasks and execute them in the background.',
        wp_path:          '/lugs/v1/agent/goal',
        method:           'POST',
        url_params:       [],
        body_params:      ['goal'],
        query_params:     [],
        params: {
            goal: { type: 'string', required: true, description: 'Natural language goal for the autonomous agent' },
        },
        returns:          '{ success, goal_id }',
        requires_approval: true,
        approval_preview: 'Submit autonomous goal to the SEO agent: "{goal}". This will run background tasks on the site.',
        allowed_agents:   ['dmm'],
    },

    agent_status: {
        id:               'agent_status',
        domain:           'seo',
        name:             'Agent Goal Status',
        description:      'Get the current progress of an autonomous agent goal and its sub-tasks.',
        wp_path:          '/lugs/v1/agent/status',
        method:           'GET',
        url_params:       [],
        body_params:      [],
        query_params:     ['goal_id'],
        params: {
            goal_id: { type: 'integer', required: true, description: 'Goal ID returned from autonomous_goal' },
        },
        returns:          '{ success, goal, tasks[] }',
        requires_approval: false,
        allowed_agents:   ['james', 'priya', 'alex', 'dmm', 'elena'],
    },

    list_goals: {
        id:               'list_goals',
        domain:           'seo',
        name:             'List Agent Goals',
        description:      'List all autonomous agent goals and their current statuses.',
        wp_path:          '/lugs/v1/agent/goals',
        method:           'GET',
        url_params:       [],
        body_params:      [],
        query_params:     [],
        params:           {},
        returns:          '{ success, goals[] }',
        requires_approval: false,
        allowed_agents:   ['james', 'priya', 'alex', 'dmm', 'elena'],
    },

    pause_goal: {
        id:               'pause_goal',
        domain:           'seo',
        name:             'Pause Agent Goal',
        description:      'Pause a running autonomous agent goal.',
        wp_path:          '/lugs/v1/agent/pause',
        method:           'POST',
        url_params:       [],
        body_params:      ['goal_id'],
        query_params:     [],
        params: {
            goal_id: { type: 'integer', required: true, description: 'Goal ID to pause' },
        },
        returns:          '{ success }',
        requires_approval: false,
        allowed_agents:   ['james', 'priya', 'alex', 'dmm', 'elena'],
    },
};

// ══════════════════════════════════════════════════════════════════════════
// CRM DOMAIN — 8 tools (lucrm/v1/*)
// ══════════════════════════════════════════════════════════════════════════
const CRM_TOOLS = {

    create_lead: {
        id:               'create_lead',
        domain:           'crm',
        name:             'Create Lead',
        description:      'Create a new lead in the CRM. Sets name, email, phone, company, source, and optionally assigns to a pipeline stage and agent.',
        example:          "After a meeting identifies a hot prospect → call create_lead(name='...', email='...', stage='new').",
        do_not_use:          'If the lead already exists — use update_lead or list_leads to check first.',
        use_when:          'A new prospect has been identified and needs to be added to the CRM pipeline.',
        wp_path:          '/lucrm/v1/leads',
        method:           'POST',
        url_params:       [],
        body_params:      ['name', 'email', 'phone', 'company', 'source', 'pipeline_stage_id', 'assigned_agent', 'score'],
        query_params:     [],
        params: {
            name:              { type: 'string',  required: true,  description: 'Full name of the lead' },
            email:             { type: 'string',  required: false, description: 'Email address' },
            phone:             { type: 'string',  required: false, description: 'Phone number' },
            company:           { type: 'string',  required: false, description: 'Company name' },
            source:            { type: 'string',  required: false, description: 'Lead source (e.g. website, referral, social)' },
            pipeline_stage_id: { type: 'integer', required: false, description: 'Pipeline stage ID to place lead in' },
            assigned_agent:    { type: 'string',  required: false, description: 'Agent slug to assign lead to (e.g. elena)' },
            score:             { type: 'integer', required: false, description: 'Lead score 0-100' },
        },
        returns:          '{ success, lead }',
        requires_approval: true,
        approval_preview: 'Create a new CRM lead: "{name}" ({email}). Adds to the pipeline.',
        allowed_agents:   ['elena', 'dmm'],
    },

    get_lead: {
        id:               'get_lead',
        domain:           'crm',
        name:             'Get Lead',
        description:      'Retrieve full details for a lead including recent activities and notes.',
        wp_path:          '/lucrm/v1/leads/:id',
        method:           'GET',
        url_params:       ['id'],
        body_params:      [],
        query_params:     [],
        params: {
            id: { type: 'integer', required: true, description: 'Lead ID to retrieve' },
        },
        returns:          'lead object with activities[] and notes[]',
        requires_approval: false,
        allowed_agents:   ['elena', 'dmm', 'james'],
    },

    update_lead: {
        id:               'update_lead',
        domain:           'crm',
        name:             'Update Lead',
        description:      'Update fields on an existing lead. Only provided fields are changed.',
        wp_path:          '/lucrm/v1/leads/:id',
        method:           'PUT',
        url_params:       ['id'],
        body_params:      ['name', 'email', 'phone', 'company', 'status', 'assigned_agent', 'score'],
        query_params:     [],
        params: {
            id:             { type: 'integer', required: true,  description: 'Lead ID to update' },
            name:           { type: 'string',  required: false, description: 'Updated name' },
            email:          { type: 'string',  required: false, description: 'Updated email' },
            status:         { type: 'string',  required: false, description: 'active | archived | lost' },
            assigned_agent: { type: 'string',  required: false, description: 'Reassign to agent slug' },
            score:          { type: 'integer', required: false, description: 'Updated lead score' },
        },
        returns:          '{ success }',
        requires_approval: false,
        allowed_agents:   ['elena', 'dmm'],
    },

    list_leads: {
        id:               'list_leads',
        domain:           'crm',
        name:             'List Leads',
        description:      'List leads with optional filters by status, pipeline stage, assigned agent, or search term.',
        example:          'Meeting on pipeline health → call list_leads() to see the current pipeline before recommending follow-up actions.',
        do_not_use:          "When you don't need lead data — it's a read operation but avoid unnecessary calls.",
        use_when:          'To understand the current pipeline status before creating follow-up tasks for leads.',
        wp_path:          '/lucrm/v1/leads',
        method:           'GET',
        url_params:       [],
        body_params:      [],
        query_params:     ['status', 'stage', 'agent', 'search', 'limit', 'offset'],
        params: {
            status: { type: 'string',  required: false, description: 'Filter by status: active | archived | lost' },
            stage:  { type: 'integer', required: false, description: 'Filter by pipeline stage ID' },
            agent:  { type: 'string',  required: false, description: 'Filter by assigned agent slug' },
            search: { type: 'string',  required: false, description: 'Search name, email, or company' },
            limit:  { type: 'integer', required: false, description: 'Max results (default 50, max 200)' },
            offset: { type: 'integer', required: false, description: 'Pagination offset' },
        },
        returns:          '{ leads[], total, limit, offset }',
        requires_approval: false,
        allowed_agents:   ['elena', 'dmm', 'james'],
    },

    move_lead: {
        id:               'move_lead',
        domain:           'crm',
        name:             'Move Lead to Stage',
        description:      'Move a lead to a different pipeline stage. Automatically logs an activity.',
        wp_path:          '/lucrm/v1/leads/:id/move',
        method:           'POST',
        url_params:       ['id'],
        body_params:      ['stage_id'],
        query_params:     [],
        params: {
            id:       { type: 'integer', required: true, description: 'Lead ID to move' },
            stage_id: { type: 'integer', required: true, description: 'Target pipeline stage ID' },
        },
        returns:          '{ success }',
        requires_approval: false,
        allowed_agents:   ['elena', 'dmm'],
    },

    log_activity: {
        id:               'log_activity',
        domain:           'crm',
        name:             'Log Activity',
        description:      'Log an activity against a lead (call, email, meeting, or note).',
        wp_path:          '/lucrm/v1/leads/:id/activities',
        method:           'POST',
        url_params:       ['id'],
        body_params:      ['type', 'description', 'created_by'],
        query_params:     [],
        params: {
            id:          { type: 'integer', required: true,  description: 'Lead ID to log activity for' },
            type:        { type: 'string',  required: true,  description: 'call | email | meeting | note' },
            description: { type: 'string',  required: true,  description: 'Activity description' },
            created_by:  { type: 'string',  required: false, description: 'Agent slug who performed this activity' },
        },
        returns:          '{ success, id }',
        requires_approval: false,
        allowed_agents:   ['elena', 'dmm'],
    },

    add_note: {
        id:               'add_note',
        domain:           'crm',
        name:             'Add Note to Lead',
        description:      'Add a structured note to a lead record.',
        wp_path:          '/lucrm/v1/leads/:id/notes',
        method:           'POST',
        url_params:       ['id'],
        body_params:      ['note', 'created_by'],
        query_params:     [],
        params: {
            id:         { type: 'integer', required: true,  description: 'Lead ID to add note to' },
            note:       { type: 'string',  required: true,  description: 'Note content' },
            created_by: { type: 'string',  required: false, description: 'Agent slug authoring the note' },
        },
        returns:          '{ success, id }',
        requires_approval: false,
        allowed_agents:   ['elena', 'dmm'],
    },

    // LAUNCH SCOPE (v2.37.3): enroll_sequence and list_sequences DELETED.
    // Both drive email drip/nurture sequences, which are out of launch scope.
    // Elena keeps every other CRM capability (lead CRUD, pipeline moves,
    // activities, notes) - only the email-sequence surface is gone.
};

// ==========================================================================
// MARKETING + SOCIAL DOMAINS - REMOVED FROM LAUNCH (v2.37.3, 2026-07-21)
// ==========================================================================
// The MARKETING_TOOLS block (7 email-marketing tools: create_campaign,
// update_campaign, list_campaigns, schedule_campaign, send_campaign,
// create_template, list_templates, create_automation, record_metric, plus the
// ai_generate_email / ai_rewrite_block / ai_suggest_subjects / ai_spam_check
// AI surface) and the SOCIAL_TOOLS block (create_post, schedule_post,
// publish_post, list_posts, update_post, get_queue, record_social_analytics,
// ai_generate_social_post, generate_hashtags, social_image_gen,
// social_platform_adapt) were DELETED as part of Workstream 3 runtime
// sanitation. The CRM sequence tools (enroll_sequence, list_sequences) were
// removed from CRM_TOOLS in the same pass.
//
// They are not commented out and not merged-then-filtered: the definitions are
// gone, so the tools cannot be resolved, listed, discovered, planned, or
// attached to an agent under any code path.
//
// The launch-scope sanitisation pass further down still runs. It is the
// enforcement backstop for aliases and for any future regression that
// re-introduces a removed tool id - it is NOT what removes these.
//
// Article sharing does not live here. The retained blog-article-share sliver
// is executed by the Laravel article-distribution service with no agent_id,
// governed by the kernel article-share context check. See launch-scope.js.
const MARKETING_TOOLS = {};
const SOCIAL_TOOLS = {};

// ══════════════════════════════════════════════════════════════════════════
// CALENDAR DOMAIN — 5 tools (lucal/v1/*)
// ══════════════════════════════════════════════════════════════════════════
const CALENDAR_TOOLS = {

    create_event: {
        id:               'create_event',
        domain:           'calendar',
        name:             'Create Event',
        description:      'Create a calendar event. Types: meeting, task, call, booking. Can be linked to a CRM lead.',
        wp_path:          '/lucal/v1/events',
        method:           'POST',
        url_params:       [],
        body_params:      ['title', 'type', 'start_time', 'end_time', 'assigned_to', 'linked_lead_id'],
        query_params:     [],
        params: {
            title:          { type: 'string',  required: true,  description: 'Event title' },
            type:           { type: 'string',  required: false, description: 'meeting | task | call | booking. Default: meeting' },
            start_time:     { type: 'string',  required: true,  description: 'Start datetime (YYYY-MM-DD HH:MM:SS)' },
            end_time:       { type: 'string',  required: true,  description: 'End datetime (YYYY-MM-DD HH:MM:SS)' },
            assigned_to:    { type: 'string',  required: false, description: 'Agent slug or person name' },
            linked_lead_id: { type: 'integer', required: false, description: 'CRM lead ID to associate this event with' },
        },
        returns:          '{ success, id }',
        requires_approval: true,
        approval_preview: 'Create a {type} event: "{title}" on {start_time}.',
        allowed_agents:   ['dmm', 'elena', 'james', 'priya', 'alex'],
    },

    list_events: {
        id:               'list_events',
        domain:           'calendar',
        name:             'List Events',
        description:      'List calendar events, optionally filtered by date range, type, or assigned agent.',
        wp_path:          '/lucal/v1/events',
        method:           'GET',
        url_params:       [],
        body_params:      [],
        query_params:     ['from', 'to', 'type', 'assigned_to'],
        params: {
            from:        { type: 'string', required: false, description: 'Filter events from this datetime' },
            to:          { type: 'string', required: false, description: 'Filter events until this datetime' },
            type:        { type: 'string', required: false, description: 'Filter by type: meeting | task | call | booking' },
            assigned_to: { type: 'string', required: false, description: 'Filter by assigned agent/person' },
        },
        returns:          'event[]',
        requires_approval: false,
        allowed_agents:   ['dmm', 'elena', 'james', 'priya', 'alex'],
    },

    update_event: {
        id:               'update_event',
        domain:           'calendar',
        name:             'Update Event',
        description:      'Update an existing calendar event. Only provided fields are changed.',
        wp_path:          '/lucal/v1/events/:id',
        method:           'PUT',
        url_params:       ['id'],
        body_params:      ['title', 'event_type', 'start_time', 'end_time', 'assigned_to'],
        query_params:     [],
        params: {
            id:         { type: 'integer', required: true,  description: 'Event ID to update' },
            title:      { type: 'string',  required: false, description: 'Updated title' },
            start_time: { type: 'string',  required: false, description: 'Updated start datetime' },
            end_time:   { type: 'string',  required: false, description: 'Updated end datetime' },
        },
        returns:          '{ success }',
        requires_approval: false,
        allowed_agents:   ['dmm', 'elena', 'james', 'priya', 'alex'],
    },

    check_availability: {
        id:               'check_availability',
        domain:           'calendar',
        name:             'Check Availability',
        description:      'Check working hours, blackout dates, existing events, and available booking slots for a given date.',
        wp_path:          '/lucal/v1/availability',
        method:           'GET',
        url_params:       [],
        body_params:      [],
        query_params:     ['date'],
        params: {
            date: { type: 'string', required: false, description: 'Date to check (YYYY-MM-DD). Defaults to today.' },
        },
        returns:          '{ date, is_working_day, is_blackout, working_hours, events[], available_slots[] }',
        requires_approval: false,
        allowed_agents:   ['dmm', 'elena', 'james', 'priya', 'alex'],
    },

    create_booking_slot: {
        id:               'create_booking_slot',
        domain:           'calendar',
        name:             'Create Booking Slot',
        description:      'Create a client-facing booking slot for a specific time window.',
        wp_path:          '/lucal/v1/booking-slots',
        method:           'POST',
        url_params:       [],
        body_params:      ['start_time', 'end_time', 'status'],
        query_params:     [],
        params: {
            start_time: { type: 'string', required: true,  description: 'Slot start datetime' },
            end_time:   { type: 'string', required: true,  description: 'Slot end datetime' },
            status:     { type: 'string', required: false, description: 'available | booked | blocked. Default: available' },
        },
        returns:          '{ success, id }',
        requires_approval: true,
        approval_preview: 'Create a booking slot from {start_time} to {end_time}.',
        allowed_agents:   ['dmm', 'elena'],
    },
};

// ══════════════════════════════════════════════════════════════════════════
// FUTURE DOMAINS — Phase 4+ stubs
// ══════════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════════
// BUILDER DOMAIN — 6 tools (lubld/v1/*)
// Partial Phase 4.5 — agents can read/modify pages, full autonomous workflows Phase 5+
// ══════════════════════════════════════════════════════════════════════════
const BUILDER_TOOLS = {

    list_builder_pages: {
        id:               'list_builder_pages',
        domain:           'builder',
        name:             'List Builder Pages',
        description:      'List all builder pages with their status and WordPress publish state.',
        wp_path:          '/lubld/v1/pages',
        method:           'GET',
        url_params:       [],
        body_params:      [],
        query_params:     ['status'],
        params: {
            status: { type: 'string', required: false, description: 'Filter by status: draft | published' },
        },
        returns:          'page[] (id, title, slug, status, wp_page_id, updated_at)',
        requires_approval: false,
        allowed_agents:   ['dmm', 'james', 'priya', 'alex'],
    },

    get_builder_page: {
        id:               'get_builder_page',
        domain:           'builder',
        name:             'Get Builder Page',
        description:      'Get full page data including all sections, containers, components, and active theme tokens.',
        wp_path:          '/lubld/v1/pages/:id/full',
        method:           'GET',
        url_params:       ['id'],
        body_params:      [],
        query_params:     [],
        params: {
            id: { type: 'integer', required: true, description: 'Builder page ID' },
        },
        returns:          'Full page object with sections, containers, components, theme',
        requires_approval: false,
        allowed_agents:   ['dmm', 'james', 'priya', 'alex'],
    },

    ai_builder_action: {
        id:               'ai_builder_action',
        domain:           'builder',
        name:             'AI Builder Action',
        description:      'Send a natural language command to modify a builder page. Returns structured actions applied to the page (add section, update component, change theme, etc.).',
        wp_path:          '/lubld/v1/ai/action',
        method:           'POST',
        url_params:       [],
        body_params:      ['command', 'page_id'],
        query_params:     [],
        params: {
            command: { type: 'string',  required: true, description: 'Natural language command e.g. "Add a testimonials section" or "Make the hero more modern"' },
            page_id: { type: 'integer', required: true, description: 'Builder page ID to modify' },
        },
        returns:          '{ success, actions[], explanation }',
        requires_approval: true,
        approval_preview: 'Apply AI builder changes to page #{page_id}: "{command}".',
        allowed_agents:   ['dmm', 'priya'],
    },

    generate_page_layout: {
        id:               'generate_page_layout',
        domain:           'builder',
        name:             'Generate Page Layout',
        description:      'Generate a complete page layout from a natural language prompt. Returns structured builder JSON ready to save as a new page.',
        example:          "User says 'build a landing page for our custom furniture service' → call generate_page_layout(prompt='luxury custom furniture service page UAE').",
        do_not_use:          'For editing existing pages — use ai_builder_action instead.',
        use_when:          'User wants a new landing page built from scratch with AI-generated layout.',
        wp_path:          '/lubld/v1/ai/generate-layout',
        method:           'POST',
        url_params:       [],
        body_params:      ['prompt', 'industry', 'sections'],
        query_params:     [],
        params: {
            prompt:   { type: 'string',  required: true,  description: 'Describe the page to generate e.g. "SaaS homepage for a project management tool"' },
            industry: { type: 'string',  required: false, description: 'Industry or niche for more relevant copy' },
            sections: { type: 'integer', required: false, description: 'Number of sections to generate (default 5, max 8)' },
        },
        returns:          '{ success, layout: { title, sections[] } }',
        requires_approval: true,
        approval_preview: 'Generate a new page layout: "{prompt}". Creates structured builder JSON.',
        allowed_agents:   ['dmm', 'priya'],
    },

    publish_builder_page: {
        id:               'publish_builder_page',
        domain:           'builder',
        name:             'Publish Builder Page',
        description:      'Publish a builder page to WordPress. Creates or updates a standard WP page with the LevelUp Builder template and returns the live URL.',
        wp_path:          '/lubld/v1/pages/:id/publish',
        method:           'POST',
        url_params:       ['id'],
        body_params:      [],
        query_params:     [],
        params: {
            id: { type: 'integer', required: true, description: 'Builder page ID to publish' },
        },
        returns:          '{ success, wp_page_id, url }',
        requires_approval: true,
        approval_preview: 'Publish builder page #{id} to WordPress as a live page.',
        allowed_agents:   ['dmm'],
    },

    import_html_page: {
        id:               'import_html_page',
        domain:           'builder',
        name:             'Import HTML to Builder',
        description:      'Convert an HTML page or URL into builder JSON using the HTML→Builder converter pipeline.',
        wp_path:          '/lubld/v1/convert/html',
        method:           'POST',
        url_params:       [],
        body_params:      ['url', 'html'],
        query_params:     [],
        params: {
            url:  { type: 'string', required: false, description: 'URL to fetch and convert' },
            html: { type: 'string', required: false, description: 'Raw HTML to convert (use if URL is not publicly accessible)' },
        },
        returns:          '{ success, result: { title, sections[], stats } }',
        requires_approval: false,
        allowed_agents:   ['dmm', 'alex'],
    },
};


// ══════════════════════════════════════════════════════════════════════════
// FUNNEL INTELLIGENCE DOMAIN — Phase 8
// ══════════════════════════════════════════════════════════════════════════
const FUNNEL_TOOLS = {

    generate_funnel_blueprint: {
        id:'generate_funnel_blueprint', domain:'funnel', name:'Generate Funnel Blueprint',
        description:'Build a 4-stage marketing funnel blueprint for a keyword or product. Returns stage-by-stage goals, channels, and asset recommendations.',
        wp_path:'/lu/v1/funnel/blueprint', method:'POST', url_params:[], body_params:['keyword','product'], query_params:[],
        params:{
            keyword: {type:'string',required:false,description:'Target keyword e.g. "luxury office furniture UAE"'},
            product: {type:'string',required:false,description:'Product or service name if no keyword'},
            target_audience:{type:'string',required:false,description:'Target audience description'},
        },
        use_when:   'User wants to build a conversion funnel from a keyword or product.',
        do_not_use: 'For general SEO analysis — use serp_analysis instead.',
        example:    '"Build a funnel for office fit-out clients" → generate_funnel_blueprint(keyword="office fit-out Dubai")',
        returns:'{ blueprint: { stages[], recommended_tools[] } }',
        requires_approval:false, allowed_agents:['dmm','priya','elena'],
    },

    // LAUNCH SCOPE (v2.37.3): the `campaign_id` parameter was removed. Its
    // description pointed the LLM at `list_campaigns` to discover an ID — a
    // removed tool — which leaked an out-of-scope tool name into Sarah's tool
    // prompt block even after the tool itself was withheld from the registry.
    // Funnel analysis now scores site pages only.
    analyze_funnel_structure: {
        id:'analyze_funnel_structure', domain:'funnel', name:'Analyse Funnel Structure',
        description:'Score a site page for funnel effectiveness. Identifies content gaps, missing CTAs, and conversion drop-off points.',
        wp_path:'/lu/v1/funnel/analyze', method:'POST', url_params:[], body_params:['page_id'], query_params:[],
        params:{
            page_id:    {type:'integer',required:true,description:'Site page ID from get_site_pages to analyse'},
        },
        use_when:   'A landing page is underperforming and you need to identify specific gaps.',
        do_not_use: 'Without a page_id — run get_site_pages first to find the page.',
        example:    '"Why is this landing page getting low conversions?" → analyze_funnel_structure(page_id=5)',
        returns:'{ analysis: { gaps[], recommendations[], score } }',
        requires_approval:false, allowed_agents:['dmm','elena','james'],
    },

};

const GOVERNANCE_TOOLS = {}; // Phase 5

// ── Phase 4: Site intelligence tools ───────────────────────────────────────
const SITE_TOOLS = {

    get_site_pages: {
        id:'get_site_pages', domain:'site', name:'List Site Pages',
        description:'List all pages scanned from the client website. Returns title, URL, meta description, word count. Use before advising on content gaps or site structure.',
        wp_path:'/lu/v1/site/pages', method:'GET', url_params:[], body_params:[], query_params:['limit','search'],
        params:{
            limit:  {type:'integer',required:false,description:'Max pages, default 50'},
            search: {type:'string', required:false,description:'Filter by keyword in title or content'},
        },
        returns:'{ pages:[{id,url,title,meta_description,word_count,last_scanned_at}], count, last_scanned }',
        requires_approval:false, allowed_agents:['dmm','james','priya','alex'],
    },

    get_site_page: {
        id:'get_site_page', domain:'site', name:'Get Site Page Content',
        description:'Get full content of a scanned page: headings, body text, internal links. Read a page before recommending edits or identifying content gaps.',
        wp_path:'/lu/v1/site/pages/:id', method:'GET', url_params:['id'], body_params:[], query_params:[],
        params:{
            id:{type:'integer',required:true,description:'Page ID from get_site_pages'},
        },
        returns:'{ page:{id,url,title,meta_description,content,headers[],internal_links[],word_count} }',
        requires_approval:false, allowed_agents:['dmm','james','priya','alex'],
    },

    search_site_content: {
        id:'search_site_content', domain:'site', name:'Search Site Content',
        description:'Full-text search across all scanned website pages. Find existing topic coverage, check keyword presence, or identify content gaps.',
        wp_path:'/lu/v1/site/search', method:'GET', url_params:[], body_params:[], query_params:['q','limit'],
        params:{
            q:    {type:'string', required:true, description:'Search query'},
            limit:{type:'integer',required:false,description:'Max results, default 20'},
        },
        returns:'{ results:[{id,url,title,meta_description,content_snippet,word_count}], count, query }',
        requires_approval:false, allowed_agents:['dmm','james','priya','alex'],
    },

    scan_site_url: {
        id:'scan_site_url', domain:'site', name:'Scan Website URL',
        description:'Crawl a URL and store its content for analysis. Run before get_site_page if not yet scanned. Use sparingly — each call fetches a live page.',
        wp_path:'/lu/v1/site/scan', method:'POST', url_params:[], body_params:['url'], query_params:[],
        params:{
            url:{type:'string',required:true,description:'Full URL to crawl e.g. https://example.com/services'},
        },
        returns:'{ success, page_id, url, title, word_count, headers_found, internal_links, http_status }',
        requires_approval:false, allowed_agents:['alex','james','dmm'],
    },

    create_website: {
        id:               'create_website',
        domain:           'builder',
        name:             'Create Website',
        description:      'Create a complete multi-page website for a business. Generates Home, About, Services, and Contact pages with real industry-specific content. Requires business_name — extract it from the user message before calling.',
        example:          "User says 'build a website for MR Digital Media, a marketing agency in Quezon' → call create_website(business_name='MR Digital Media', industry='marketing agency', location='Quezon, Philippines').",
        use_when:         "User wants to build, create, or generate a website or web presence for a business.",
        do_not_use:       "When the user is asking about SEO improvements to an existing site — use serp_analysis or deep_audit instead.",
        wp_path:          '/lu/v1/websites/create',
        method:           'POST',
        url_params:       [],
        body_params:      ['business_name', 'industry', 'location', 'pages', 'primary_goal', 'style'],
        query_params:     [],
        params: {
            business_name: { type: 'string',  required: true,  description: 'Business or brand name for the website e.g. "MR Digital Media"' },
            industry:      { type: 'string',  required: false, description: 'Industry type e.g. "marketing agency", "restaurant", "law firm"' },
            location:      { type: 'string',  required: false, description: 'City/region for localisation e.g. "Quezon, Philippines"' },
            pages:         { type: 'array',   required: false, description: 'Page slugs to generate, defaults to [home, services, about, contact]' },
            primary_goal:  { type: 'string',  required: false, description: 'Site goal: lead_generation | ecommerce | portfolio | brochure' },
            style:         { type: 'string',  required: false, description: 'Design style: modern | classic | bold | minimal' },
        },
        returns:          '{ success, website_id, pages_created, preview_url }',
        requires_approval: false,
        allowed_agents:   ['dmm', 'priya', 'alex'],
    },
};

// ── Merge all domains ──────────────────────────────────────────────────────
// ── Studio (Visual Design) — Sarah × Studio Phase 1 2026-06-03 ─────────────
const STUDIO_TOOLS = {
    generate_design: {
        id:               'generate_design',
        domain:           'studio',
        name:             'Generate Studio Design',
        description:      'Creates a Studio design draft from a brand-grounded brief. Picks the best template, applies workspace brand kit (palette/fonts/logo), generates per-slot copy via runtime. Returns design_id for editor review. NEVER auto-publishes — output is a draft the owner downloads or uses in their own channels.',
        example:          "User says 'create a square visual for the gym 30-day challenge' → call generate_design(format='square', industry='gym', intent='promo', headline_seed='30-day challenge').",
        use_when:         "User wants a designed visual asset — image or video creative, cover, banner, carousel slide.",
        do_not_use:       "When the user wants to browse options first — use pick_design_template. This tool produces a draft asset only; it does not distribute it anywhere.",
        wp_path:          '/api/v1/studio/ai/generate-design',
        method:           'POST',
        url_params:       [],
        body_params:      ['format','industry','intent','headline_seed','template_pool'],
        query_params:     [],
        params: {
            format:        { type: 'string', required: false, description: 'square|portrait|reel|landscape|story — defaults to square' },
            industry:      { type: 'string', required: false, description: 'Industry (auto-detected from workspace if omitted)' },
            intent:        { type: 'string', required: false, description: 'promo|announce|educational|reminder|transactional' },
            headline_seed: { type: 'string', required: false, description: 'Optional copy seed for the headline' },
            template_pool: { type: 'array',  required: false, description: 'Optional restricted slug list to choose from' }
        },
        returns:          '{ success, design_id, template_slug, preview_url, palette, copy }',
        requires_approval: false,
        allowed_agents:   ['dmm'],
        credit_cost:       5,
    },
    pick_design_template: {
        id:               'pick_design_template',
        domain:           'studio',
        name:             'Pick Design Template',
        description:      'Ranks Studio templates by fit for a given brand kit + industry + intent + format. Returns top 5 candidates with scores. Use to preview the template selector before committing to generate_design.',
        use_when:         "User asks 'which template should I use', 'what fits my brand', or wants A/B template comparison.",
        do_not_use:       "When the user has already decided — go straight to generate_design.",
        wp_path:          '/api/v1/studio/ai/pick-template',
        method:           'POST',
        url_params:       [],
        body_params:      ['industry','intent','format'],
        query_params:     [],
        params: {
            industry: { type: 'string', required: false, description: 'Industry hint' },
            intent:   { type: 'string', required: false, description: 'Email/visual intent' },
            format:   { type: 'string', required: false, description: 'Output format' }
        },
        returns:          '{ ranked: [{template_slug, score, why}] }',
        requires_approval: false,
        allowed_agents:   ['dmm'],
        credit_cost:       1,
    },
    list_design_templates: {
        id:               'list_design_templates',
        domain:           'studio',
        name:             'List Studio Templates',
        description:      'Returns the catalog of 67 Studio templates (image + video) with industry, format, mood, intent tags. Use for discovery.',
        use_when:         "User asks what templates are available, wants to browse the library, or wants to filter by industry/format.",
        do_not_use:       "When generating an actual design — generate_design picks for you.",
        wp_path:          '/api/v1/studio/templates/html',
        method:           'GET',
        url_params:       [],
        body_params:      [],
        query_params:     [],
        params: {},
        returns:          '{ templates: [{slug, name, industry, format, intent, mood, preview_url}] }',
        requires_approval: false,
        allowed_agents:   ['dmm','priya','james','alex','elena'],
        credit_cost:       0,
    },
};

const _RAW_TOOLS = Object.assign(
    {},
    SEO_TOOLS,
    CRM_TOOLS,
    MARKETING_TOOLS,
    SOCIAL_TOOLS,
    CALENDAR_TOOLS,
    BUILDER_TOOLS,
    STUDIO_TOOLS,
    SITE_TOOLS,
    FUNNEL_TOOLS,
    GOVERNANCE_TOOLS
);

// ── LAUNCH SCOPE SANITISATION (2026-07-21, v2.37.3) ───────────────────────
// Single pass over the merged registry rather than 78 hand-edits across the
// domain literals above. Two effects:
//   1. Launch-removed tools are DELETED from the registry entirely — they are
//      not resolvable by id, not listed, not discoverable, not selectable by
//      the planner, and not attachable to any agent. A removed tool must not
//      linger just because the Laravel kernel would deny it later.
//   2. Every surviving tool's `allowed_agents` is stripped of removed agents,
//      so no retained tool is still owned by (e.g.) marcus.
// The retained blog-article-share sliver is intentionally NOT re-added here:
// the article-distribution service executes it with no agent_id, governed by
// the Laravel kernel's article-share context check. See launch-scope.js.
const launchScope = require('./launch-scope');

const ALL_TOOLS = {};
const _REMOVED_TOOL_IDS = [];
for (const [id, tool] of Object.entries(_RAW_TOOLS)) {
    if (launchScope.isRemovedTool(id)) {
        _REMOVED_TOOL_IDS.push(id);
        continue;
    }
    ALL_TOOLS[id] = Object.assign({}, tool, {
        allowed_agents: launchScope.filterAgentIds(tool.allowed_agents || []),
    });
}
if (_REMOVED_TOOL_IDS.length) {
    console.log(`[TOOL-REGISTRY] Launch scope: withheld ${_REMOVED_TOOL_IDS.length} out-of-scope tools (${_REMOVED_TOOL_IDS.join(', ')})`);
}

// ── Core API ───────────────────────────────────────────────────────────────

function getTool(toolId) {
    if (typeof toolId !== 'string') return null;
    const id = toolId.trim();
    if (id === '' || launchScope.isRemovedTool(id)) return null;
    return ALL_TOOLS[id] || null;
}

function listAll() {
    return Object.values(ALL_TOOLS);
}

function listByDomain(domain) {
    return Object.values(ALL_TOOLS).filter(t => t.domain === domain);
}

function getToolsForAgent(agentId) {
    if (launchScope.isRemovedAgent(agentId)) return [];
    const permitted = capMap().getToolIds(agentId);
    return permitted.map(id => ALL_TOOLS[id]).filter(Boolean);
}

function agentCanUseTool(agentId, toolId) {
    if (typeof agentId !== 'string' || typeof toolId !== 'string') return false;
    if (launchScope.isRemovedAgent(agentId) || launchScope.isRemovedTool(toolId)) return false;
    const tool = getTool(toolId);
    if (!tool) return false;
    return Array.isArray(tool.allowed_agents) && tool.allowed_agents.includes(agentId);
}

function buildToolPromptBlock(agentId) {
    const tools = getToolsForAgent(agentId);
    if (!tools.length) return '';

    const defs = tools.map(t => {
        const paramLines = Object.entries(t.params || {}).map(([k, v]) =>
            `      ${k} (${v.type}${v.required ? ', REQUIRED' : ', optional'}): ${v.description}`
        ).join('\n');
        const approvalNote = t.requires_approval
            ? '  \u26a0\ufe0f  REQUIRES HUMAN APPROVAL before execution.'
            : '  \u2713  Executes immediately.';

        const lines = [
            `TOOL: ${t.id}`,
            `PURPOSE: ${t.description}`,
        ];
        if (t.use_when)     lines.push(`USE WHEN: ${t.use_when}`);
        if (t.do_not_use)   lines.push(`DO NOT USE WHEN: ${t.do_not_use}`);
        if (t.example)      lines.push(`EXAMPLE: ${t.example}`);
        if (paramLines)     lines.push(`PARAMETERS:\n${paramLines}`);
        if (t.returns)      lines.push(`RETURNS: ${t.returns}`);
        lines.push(approvalNote);

        return lines.join('\n');
    }).join('\n\n---\n\n');

    return [
        '',
        '\u2550\u2550\u2550 TOOLS AVAILABLE TO YOU (real data \u2014 use with discipline) \u2550\u2550\u2550',
        'These tools return LIVE data from the client systems.',
        'DO NOT hallucinate results. Call the tool, read the result, then reason from it.',
        'DO NOT call tools when you already have the information in context.',
        '',
        defs,
        '',
        '\u2550\u2550\u2550 HOW TO CALL A TOOL (exact format) \u2550\u2550\u2550',
        '<tool_call>{"tool": "tool_id_here", "params": {"param_name": "value"}}</tool_call>',
        '',
        'DISCIPLINE:',
        '1. One tool per turn. Wait for result before calling another.',
        '2. Only call when real data materially improves your answer.',
        '3. Interpret results \u2014 never paste raw JSON.',
        '4. Honour USE WHEN / DO NOT USE WHEN guidance for each tool.',
    ].join('\n');
}

function buildToolPromptBlockWithDiscovery(agentId) {
    const base = buildToolPromptBlock(agentId);
    try {
        const { formatDiscoveredToolsBlock } = require('./tool-discovery');
        const discoveredBlock = formatDiscoveredToolsBlock(agentId);
        if (discoveredBlock) return base + '\n\n' + discoveredBlock;
    } catch (_) {}
    return base;
}

function getStats() {
    const tools = Object.values(ALL_TOOLS);
    const byDomain = {};
    for (const t of tools) byDomain[t.domain] = (byDomain[t.domain] || 0) + 1;
    return { total: tools.length, byDomain, requiresApproval: tools.filter(t => t.requires_approval).length };
}

/**
 * Patch 3 (v2.24.1): Derive tool endpoint from wp_path + method.
 * Eliminates the routing table in Core (lu_get_tool_map) — runtime is now
 * the single source of truth for where each tool lives.
 *
 * Returns: { ns, path, method, url_params }
 *   ns         = WP REST namespace, e.g. 'lucrm/v1'
 *   path       = path within namespace, e.g. '/leads/:id'
 *   method     = HTTP method
 *   url_params = array of param names that appear as :name in path
 *
 * Called by lu-tool-executor.js to build the engine_path sent to WP.
 */
function getEndpoint(toolId) {
    const tool = getTool(toolId);
    if (!tool || !tool.wp_path) return null;

    // Parse wp_path: /lucrm/v1/leads/:id → ns=lucrm/v1, path=/leads/:id
    const match = tool.wp_path.match(/^\/([^\/]+\/v\d+)(\/.*)?$/);
    if (!match) return { ns: '', path: tool.wp_path, method: tool.method || 'POST', url_params: [] };

    return {
        ns:         match[1],
        path:       match[2] || '/',
        method:     tool.method     || 'POST',
        url_params: tool.url_params || [],
    };
}

module.exports = {
    getTool,
    getEndpoint,
    buildToolPromptBlockWithDiscovery,
    listAll,
    listByDomain,
    getToolsForAgent,
    agentCanUseTool,
    buildToolPromptBlock,
    getStats,
    TOOLS: ALL_TOOLS, // legacy compat
};
