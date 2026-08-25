'use strict';

/**
 * tool-proactive-intelligence.js — Wave 91
 *
 * Ports ProactiveStrategyEngine.findOpportunities. Takes the workspace
 * feature vector (DB facts gathered in Laravel) and returns the
 * opportunity templates that apply. Pure rule logic — no DB, no state.
 *
 *   POST /internal/proactive/find-opportunities
 *     body: { article_count: int, has_audit: bool }
 *     resp: { opportunities: [...] }
 */

function findOpportunities(articleCount, hasAudit) {
    const opportunities = [];

    articleCount = parseInt(articleCount || 0, 10);
    hasAudit = Boolean(hasAudit);

    if (articleCount === 0) {
        opportunities.push({
            type: 'first_content',
            title: 'Publish your first article',
            description: 'Publishing SEO-optimized content boosts your search visibility. Priya can write your first article.',
            cost_breakdown: [{
                action: 'write_article',
                agent: 'priya',
                description: 'AI-generated article',
                credits: 3,
            }],
            total_credits: 3,
        });
    }

    if (!hasAudit) {
        opportunities.push({
            type: 'seo_audit',
            title: 'Run your first SEO audit',
            description: 'A technical audit reveals quick wins for your website ranking.',
            cost_breakdown: [{
                action: 'deep_audit',
                agent: 'james',
                description: 'Full technical SEO audit',
                credits: 3,
            }],
            total_credits: 3,
        });
    }

    return opportunities;
}

function mountRoutes(app, requireSecret) {
    if (!app || !requireSecret) throw new Error('mountRoutes(app, requireSecret) required');

    app.post('/internal/proactive/find-opportunities', requireSecret, (req, res) => {
        try {
            const b = req.body || {};
            const opportunities = findOpportunities(b.article_count || 0, b.has_audit || false);
            res.json({ opportunities });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    console.log('[proactive-intelligence] 1 /internal/proactive/* route mounted');
}

module.exports = {
    findOpportunities,
    mountRoutes,
};
