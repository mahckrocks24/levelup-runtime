'use strict';

/**
 * tool-orchestrator-intelligence.js — Wave 90
 *
 * Ports SarahOrchestrator's 4 algorithmic methods.
 * Mount routes via mountRoutes(app, requireSecret).
 *
 *   POST /internal/orchestrator/identify-engines
 *   POST /internal/orchestrator/assess-quality
 *   POST /internal/orchestrator/requires-approval
 *   POST /internal/orchestrator/estimate-task-count
 */

const ENGINE_PATTERNS = {
    seo:         /\b(seo|keyword|ranking|search|organic|audit|backlink)\b/,
    write:       /\b(write|article|blog|content|copy|draft)\b/,
    creative:    /\b(image|video|creative|photo)\b/,
    studio:      /\b(design|visual|template|canvas|graphic|poster|banner|flyer|carousel|brand\s*kit)\b/,
    social:      /\b(social|instagram|facebook|twitter|linkedin|tiktok|post)\b/,
    marketing:   /\b(campaign|email|newsletter|automation|marketing|nurture)\b/,
    crm:         /\b(lead|crm|contact|deal|follow.?up|pipeline)\b/,
    builder:     /\b(website|landing.?page|site|page|builder)\b/,
    beforeafter: /\b(interior|room|before.?after|transform|renovation)\b/,
};

const EXTERNAL_ENGINES = ['social', 'marketing', 'builder'];

function identifyEngines(goal) {
    const lower = String(goal || '').toLowerCase();
    const engines = [];
    for (const [engine, pattern] of Object.entries(ENGINE_PATTERNS)) {
        if (pattern.test(lower)) engines.push(engine);
    }
    if (engines.length === 0) return ['seo', 'write'];
    return engines;
}

function assessQuality(result) {
    result = result || {};
    if (!result.success) return 0.0;
    const data = result.data || {};

    let score = 0.6;

    if (Object.keys(data).length > 3) score += 0.1;
    if (typeof data.score === 'number' && data.score > 70) score += 0.1;

    const rich = data.recommendations || data.items || data.results || [];
    if (Array.isArray(rich) && rich.length > 0) score += 0.1;

    const credits = parseInt(result.credits_used || 0, 10);
    if (credits <= 2) score += 0.1;

    return Math.min(1.0, Math.round(score * 100) / 100);
}

function requiresApproval(analysis) {
    analysis = analysis || {};
    const engines = Array.isArray(analysis.engines_required) ? analysis.engines_required : [];

    for (const engine of engines) {
        if (EXTERNAL_ENGINES.includes(engine)) return true;
    }

    const creditEstimate = parseInt(analysis.credit_estimate || 0, 10);
    if (creditEstimate > 10) return true;

    if (analysis.complexity === 'high') return true;

    return false;
}

function estimateTaskCount(engines, _goal) {
    engines = Array.isArray(engines) ? engines : [];
    return Math.max(1, engines.length * 2);
}

function mountRoutes(app, requireSecret) {
    if (!app || !requireSecret) throw new Error('mountRoutes(app, requireSecret) required');

    app.post('/internal/orchestrator/identify-engines', requireSecret, (req, res) => {
        try {
            const engines = identifyEngines((req.body || {}).goal || '');
            res.json({ engines });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/internal/orchestrator/assess-quality', requireSecret, (req, res) => {
        try {
            const score = assessQuality((req.body || {}).result || {});
            res.json({ score });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/internal/orchestrator/requires-approval', requireSecret, (req, res) => {
        try {
            const requires_approval = requiresApproval((req.body || {}).analysis || {});
            res.json({ requires_approval });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/internal/orchestrator/estimate-task-count', requireSecret, (req, res) => {
        try {
            const b = req.body || {};
            const count = estimateTaskCount(b.engines || [], b.goal || '');
            res.json({ count });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    console.log('[orchestrator-intelligence] 4 /internal/orchestrator/* routes mounted');
}

module.exports = {
    identifyEngines,
    assessQuality,
    requiresApproval,
    estimateTaskCount,
    mountRoutes,
};
