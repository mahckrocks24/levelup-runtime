'use strict';

/**
 * Tool: seo_audit
 * Fetches a real URL and performs on-page SEO analysis.
 * No paid APIs required — uses HTTP fetch + HTML parsing.
 */

const axios = require('axios');

module.exports = {
    name:           'seo_audit',
    description:    'Fetches a real webpage and performs a comprehensive on-page SEO audit. Analyses title tags, meta descriptions, headings structure, canonical URLs, Open Graph tags, page speed indicators, and technical SEO factors. Returns prioritised issues with recommendations.',
    execution_type: 'worker_job',
    governance_tier: 0,
    required_permissions: ['seo:read'],
    timeout_ms: 20000,

    parameters: {
        type: 'object',
        properties: {
            url: {
                type:        'string',
                description: 'The full URL to audit (e.g. https://example.com/page)',
            },
        },
        required: ['url'],
    },

    async handler(payload, context) {
        const url = payload.url;
        if (!url) throw new Error('URL is required for SEO audit.');

        console.log(`[SEO_AUDIT] Fetching: ${url}`);

        // Fetch the page
        let html = '';
        let responseTime = 0;
        let statusCode = 0;
        let contentLength = 0;

        try {
            const start    = Date.now();
            const response = await axios.get(url, {
                timeout: 15000,
                maxRedirects: 5,
                headers: {
                    'User-Agent': 'LevelUp-SEO-Audit/1.0 (+https://levelupgrowth.ai)',
                    'Accept': 'text/html,application/xhtml+xml',
                },
                validateStatus: () => true, // Don't throw on 4xx/5xx
            });
            responseTime  = Date.now() - start;
            statusCode    = response.status;
            html          = response.data || '';
            contentLength = response.headers['content-length'] || Buffer.byteLength(html, 'utf8');
        } catch (err) {
            throw new Error(`Could not fetch URL: ${err.message}`);
        }

        // Parse the HTML
        const audit = analyseHTML(html, url, statusCode, responseTime, contentLength);
        return audit;
    },

    memory_hint(result) {
        const score  = result.overall_score ?? 0;
        const issues = result.issues?.length ?? 0;
        return `SEO audit for ${result.url}: score ${score}/100, ${issues} issues found. Top issue: ${result.issues?.[0]?.issue || 'none'}.`;
    },
};

function analyseHTML(html, url, statusCode, responseTime, contentLength) {
    const issues      = [];
    const passed      = [];
    const suggestions = [];

    // ── Helper: extract tag content ───────────────────────────────────────
    function extract(pattern, html) {
        const m = html.match(pattern);
        return m ? m[1] : null;
    }
    function extractAll(pattern, html) {
        return [...html.matchAll(pattern)].map(m => m[1]);
    }
    function stripTags(str) {
        return str ? str.replace(/<[^>]+>/g, '').trim() : '';
    }

    // ── 1. HTTP Status ─────────────────────────────────────────────────────
    if (statusCode !== 200) {
        issues.push({ severity: 'critical', category: 'technical', issue: `Page returned HTTP ${statusCode}`, recommendation: statusCode >= 400 ? 'Fix the broken page or redirect.' : 'Check for redirect chains.' });
    } else {
        passed.push('Page returns HTTP 200 OK');
    }

    // ── 2. Title Tag ───────────────────────────────────────────────────────
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title      = titleMatch ? stripTags(titleMatch[1]) : null;

    if (!title) {
        issues.push({ severity: 'high', category: 'on-page', issue: 'Missing title tag', recommendation: 'Add a unique, descriptive title tag between 50–60 characters.' });
    } else if (title.length < 30) {
        issues.push({ severity: 'medium', category: 'on-page', issue: `Title tag too short (${title.length} chars): "${title}"`, recommendation: 'Expand title to 50–60 characters including primary keyword.' });
    } else if (title.length > 65) {
        issues.push({ severity: 'medium', category: 'on-page', issue: `Title tag too long (${title.length} chars) — will be truncated in SERPs`, recommendation: 'Shorten title to under 60 characters while keeping the primary keyword.' });
    } else {
        passed.push(`Title tag present and well-sized (${title.length} chars)`);
    }

    // ── 3. Meta Description ────────────────────────────────────────────────
    const metaDesc = extract(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i, html)
                  || extract(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i, html);

    if (!metaDesc) {
        issues.push({ severity: 'high', category: 'on-page', issue: 'Missing meta description', recommendation: 'Add a compelling meta description between 140–160 characters to improve click-through rates.' });
    } else if (metaDesc.length < 70) {
        issues.push({ severity: 'medium', category: 'on-page', issue: `Meta description too short (${metaDesc.length} chars)`, recommendation: 'Expand meta description to 140–160 characters.' });
    } else if (metaDesc.length > 165) {
        issues.push({ severity: 'low', category: 'on-page', issue: `Meta description too long (${metaDesc.length} chars) — may be truncated`, recommendation: 'Trim meta description to under 160 characters.' });
    } else {
        passed.push(`Meta description present (${metaDesc.length} chars)`);
    }

    // ── 4. H1 Tags ─────────────────────────────────────────────────────────
    const h1Tags = extractAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, html).map(stripTags).filter(Boolean);

    if (h1Tags.length === 0) {
        issues.push({ severity: 'high', category: 'on-page', issue: 'No H1 tag found', recommendation: 'Add a single H1 tag containing the primary keyword.' });
    } else if (h1Tags.length > 1) {
        issues.push({ severity: 'medium', category: 'on-page', issue: `Multiple H1 tags found (${h1Tags.length}): "${h1Tags.slice(0,2).join('", "')}"`, recommendation: 'Use only one H1 per page. Convert additional H1s to H2s.' });
    } else {
        passed.push(`Single H1 tag present: "${h1Tags[0].substring(0, 60)}"`);
    }

    // ── 5. H2 Tags ─────────────────────────────────────────────────────────
    const h2Tags = extractAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, html).map(stripTags).filter(Boolean);
    if (h2Tags.length === 0) {
        suggestions.push('Consider adding H2 subheadings to improve content structure and keyword coverage.');
    } else {
        passed.push(`${h2Tags.length} H2 heading(s) found`);
    }

    // ── 6. Canonical URL ───────────────────────────────────────────────────
    const canonical = extract(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i, html)
                   || extract(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i, html);

    if (!canonical) {
        issues.push({ severity: 'medium', category: 'technical', issue: 'No canonical URL tag', recommendation: 'Add a canonical tag to prevent duplicate content issues.' });
    } else {
        passed.push(`Canonical URL set: ${canonical}`);
    }

    // ── 7. Meta Robots ─────────────────────────────────────────────────────
    const robots = extract(/<meta[^>]+name=["']robots["'][^>]+content=["']([^"']+)["']/i, html);
    if (robots && (robots.includes('noindex') || robots.includes('nofollow'))) {
        issues.push({ severity: 'critical', category: 'technical', issue: `Page has robots meta: "${robots}" — may be blocking search engines`, recommendation: 'Review and update robots meta tag if this page should be indexed.' });
    } else {
        passed.push('No blocking robots meta tag');
    }

    // ── 8. Open Graph ──────────────────────────────────────────────────────
    const ogTitle = extract(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i, html);
    const ogDesc  = extract(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i, html);
    const ogImage = extract(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i, html);

    if (!ogTitle || !ogDesc || !ogImage) {
        const missing = [!ogTitle && 'og:title', !ogDesc && 'og:description', !ogImage && 'og:image'].filter(Boolean);
        issues.push({ severity: 'low', category: 'social', issue: `Missing Open Graph tags: ${missing.join(', ')}`, recommendation: 'Add Open Graph tags to improve appearance when shared on social media.' });
    } else {
        passed.push('Open Graph tags complete (title, description, image)');
    }

    // ── 9. Images alt text ─────────────────────────────────────────────────
    const allImages    = [...html.matchAll(/<img[^>]+>/gi)].map(m => m[0]);
    const imagesNoAlt  = allImages.filter(img => !img.match(/alt=["'][^"']+["']/i)).length;

    if (imagesNoAlt > 0) {
        issues.push({ severity: 'medium', category: 'accessibility', issue: `${imagesNoAlt} image(s) missing alt text`, recommendation: 'Add descriptive alt text to all images — improves accessibility and image SEO.' });
    } else if (allImages.length > 0) {
        passed.push(`All ${allImages.length} images have alt text`);
    }

    // ── 10. Page Speed Proxy ───────────────────────────────────────────────
    const pageSizeKB = Math.round(contentLength / 1024);
    if (responseTime > 3000) {
        issues.push({ severity: 'high', category: 'performance', issue: `Slow server response time: ${responseTime}ms`, recommendation: 'Investigate server performance, caching, and CDN configuration. Target under 1000ms.' });
    } else if (responseTime > 1500) {
        issues.push({ severity: 'medium', category: 'performance', issue: `Server response time is slow: ${responseTime}ms`, recommendation: 'Enable server-side caching and review hosting performance.' });
    } else {
        passed.push(`Server response time: ${responseTime}ms`);
    }

    if (pageSizeKB > 500) {
        suggestions.push(`Page HTML size is ${pageSizeKB}KB — consider minifying HTML and deferring non-critical resources.`);
    }

    // ── 11. HTTPS ──────────────────────────────────────────────────────────
    if (!url.startsWith('https://')) {
        issues.push({ severity: 'critical', category: 'technical', issue: 'Page is not served over HTTPS', recommendation: 'Install an SSL certificate immediately. HTTPS is a confirmed ranking factor.' });
    } else {
        passed.push('Page served over HTTPS');
    }

    // ── Score calculation ──────────────────────────────────────────────────
    const criticals = issues.filter(i => i.severity === 'critical').length;
    const highs     = issues.filter(i => i.severity === 'high').length;
    const mediums   = issues.filter(i => i.severity === 'medium').length;
    const lows      = issues.filter(i => i.severity === 'low').length;

    const deductions = (criticals * 20) + (highs * 10) + (mediums * 5) + (lows * 2);
    const score      = Math.max(0, Math.min(100, 100 - deductions));

    const quickWins = issues
        .filter(i => ['low','medium'].includes(i.severity))
        .slice(0, 3)
        .map(i => i.recommendation);

    return {
        url,
        audited_at:     new Date().toISOString(),
        status_code:    statusCode,
        response_time_ms: responseTime,
        overall_score:  score,
        page_title:     title || null,
        meta_description: metaDesc || null,
        h1_tags:        h1Tags,
        issues_summary: {
            critical: criticals,
            high:     highs,
            medium:   mediums,
            low:      lows,
            total:    issues.length,
        },
        issues,
        passed,
        quick_wins: quickWins,
        suggestions,
    };
}
