'use strict';

/**
 * tool-governance-intelligence.js — Wave 88
 *
 * Ports the ConfidenceScorer governance algorithm from Laravel into
 * the runtime where this proprietary scoring logic belongs.
 *
 *   computeConfidenceScore(engine, action, payload, wsId, historyCount)
 *
 * The score determines approval_mode per (engine, action) call:
 *   - score >= 0.90 → 'auto'      (no human approval needed)
 *   - score >= 0.60 → 'review'    (queue for human review)
 *   - score <  0.60 → 'protected' (must be human-approved)
 *
 * Read-only / introspection actions baseline high. External-facing
 * writes baseline low. Workspace history nudges up, bulk operations
 * and large recipient lists nudge down.
 *
 * Mount via mountRoutes(app, requireSecret).
 */

// LAUNCH SCOPE (v2.37.3): out-of-scope tools removed from both sets. Leaving
// them in READ_ONLY would have granted a HIGH confidence baseline to actions
// the kernel always denies, skewing governance scoring on refused calls.
//
// Read-only actions — high confidence baseline.
const READ_ONLY = new Set([
    'serp_analysis', 'deep_audit', 'ai_report', 'ai_status',
    'list_goals', 'agent_status', 'list_leads', 'get_lead',
    'list_events', 'check_availability', 'list_builder_pages',
    'get_builder_page', 'get_site_pages', 'get_site_page',
    'search_site_content', 'analyze_funnel_structure',
    'list_design_templates', 'list_previews', 'proactive_status',
]);

// External-facing writes — lower default confidence.
const EXTERNAL_WRITES = new Set([
    'publish_builder_page', 'publish_website', 'export_website',
]);

function computeConfidenceScore(engine, action, payload, wsId, historyCount) {
    payload = payload || {};
    historyCount = historyCount || 0;

    let score = 0.70;
    const reasons = [];

    // Action class
    if (READ_ONLY.has(action)) {
        score = 0.95;
        reasons.push('read-only');
    } else if (EXTERNAL_WRITES.has(action)) {
        score = 0.40;
        reasons.push('external-facing write');
    }

    // Workspace history with this engine — proven track record nudges up.
    if (historyCount >= 25) {
        score = Math.min(1.0, score + 0.10);
        reasons.push(`engine has ${historyCount} completed runs in this workspace`);
    } else if (historyCount >= 10) {
        score = Math.min(1.0, score + 0.05);
        reasons.push(`engine has ${historyCount} completed runs in this workspace`);
    }

    // Bulk hint nudges down.
    const bulkCount = payload.count ? parseInt(payload.count, 10) : 0;
    if (payload.bulk || bulkCount > 10) {
        score = Math.max(0.0, score - 0.20);
        reasons.push('bulk operation');
    }

    // External recipient list nudges down further.
    if (Array.isArray(payload.recipients) && payload.recipients.length > 50) {
        score = Math.max(0.0, score - 0.15);
        reasons.push(`large recipient list (${payload.recipients.length})`);
    }

    const approval_mode = score >= 0.90 ? 'auto'
        : score >= 0.60 ? 'review'
        : 'protected';

    return {
        score: Math.round(score * 1000) / 1000,
        reason: reasons.length ? reasons.join('; ') : 'baseline',
        approval_mode,
    };
}

function mountRoutes(app, requireSecret) {
    if (!app || !requireSecret) {
        throw new Error('mountRoutes(app, requireSecret) — both args required');
    }
    app.post('/internal/governance/confidence-score', requireSecret, (req, res) => {
        try {
            const b = req.body || {};
            const result = computeConfidenceScore(
                b.engine || '',
                b.action || '',
                b.payload || {},
                parseInt(b.workspace_id || 0, 10),
                parseInt(b.workspace_history_count || 0, 10)
            );
            res.json(result);
        } catch (e) {
            console.error('[governance/confidence-score]', e);
            res.status(500).json({ error: e.message });
        }
    });
    console.log('[governance-intelligence] /internal/governance/confidence-score mounted');
}

module.exports = { computeConfidenceScore, mountRoutes };
