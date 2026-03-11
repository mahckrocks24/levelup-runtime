'use strict';

/**
 * Tool: run_test_audit
 *
 * Sprint A validation tool.
 * Returns a realistic-looking mock SEO audit result.
 * Purpose: validate the complete pipeline end-to-end.
 *
 * In Sprint B this becomes a real SEO audit tool
 * powered by actual crawl data from the SEO Suite plugin.
 *
 * ToolDefinition interface — all fields required:
 */

module.exports = {
    name:           'run_test_audit',
    description:    'Sprint A pipeline validation. Runs a mock SEO audit to confirm the full task pipeline is operational: WordPress → Redis → BullMQ → Worker → Governance → Tool → Memory → WordPress callback.',
    execution_type: 'worker_job',
    governance_tier: 0,  // Tier 0 = auto-execute, no approval needed
    required_permissions: ['seo:read'],
    timeout_ms:     15000,

    /**
     * The handler is what actually runs when the tool is called.
     *
     * @param {object} payload   — { url, requested_by }
     * @param {object} context   — { task_id, agent_id, workspace_id }
     * @returns {object}         — tool result data
     */
    async handler(payload, context) {
        const url  = payload.url || 'https://example.com';
        const start = Date.now();

        // Simulate realistic async work — a real audit takes time
        await sleep(800 + Math.random() * 400);

        // Build a realistic mock audit result
        const result = {
            audit_type:   'mock_seo_audit',
            target_url:   url,
            audited_at:   new Date().toISOString(),
            sprint:       'A',
            pipeline_validation: true,

            summary: `Sprint A pipeline validation passed for ${url}. The task travelled from WordPress through Redis, BullMQ, the governance gate, and the tool registry. Memory was written. This is the foundation everything else is built on.`,

            scores: {
                overall:          72,
                technical_seo:    68,
                content_quality:  75,
                page_speed:       71,
                mobile_friendly:  85,
            },

            issues_found: [
                {
                    severity:    'high',
                    category:    'technical',
                    issue:       'Missing meta descriptions on 14 pages',
                    recommendation: 'Add unique meta descriptions under 160 characters to all key pages.',
                },
                {
                    severity:    'medium',
                    category:    'performance',
                    issue:       'Largest Contentful Paint (LCP) is 3.8 seconds',
                    recommendation: 'Compress hero images and consider lazy loading below-the-fold content.',
                },
                {
                    severity:    'medium',
                    category:    'content',
                    issue:       '6 blog posts have duplicate H1 tags',
                    recommendation: 'Ensure each page has a single, unique H1 tag matching the target keyword.',
                },
                {
                    severity:    'low',
                    category:    'technical',
                    issue:       'XML sitemap not submitted to Google Search Console',
                    recommendation: 'Submit sitemap.xml via Google Search Console to improve crawl efficiency.',
                },
            ],

            quick_wins: [
                'Submit XML sitemap to Google Search Console (30 minutes)',
                'Add meta descriptions to top 10 pages (2 hours)',
                'Fix duplicate H1 tags in blog posts (1 hour)',
            ],

            pipeline_diagnostics: {
                task_id:      context.task_id,
                agent_id:     context.agent_id,
                workspace_id: context.workspace_id,
                processing_ms: Date.now() - start,
                queue:        'levelup-tasks',
                governance:   'tier_0_auto_approved',
                tool:         'run_test_audit',
                memory_write: 'pending_callback',
            },
        };

        return result;
    },

    /**
     * memory_hint: what the agent should store in memory from this result.
     * Returns a concise string the agent can reference in future tasks.
     */
    memory_hint(result) {
        const score  = result.scores?.overall ?? 0;
        const issues = result.issues_found?.length ?? 0;
        return `SEO audit completed for ${result.target_url}. Overall score: ${score}/100. ${issues} issues found. Top priority: ${result.issues_found?.[0]?.issue || 'none'}.`;
    },
};

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
