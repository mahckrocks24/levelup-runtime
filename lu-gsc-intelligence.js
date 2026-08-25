'use strict';

/**
 * LevelUp — Google Search Console Intelligence (Phase 3)
 *
 * ALL GSC scoring/ranking lives here in the runtime (hands-vs-brain rule:
 * intelligence in Railway, never Laravel). Laravel persists the raw
 * gsc_metrics rows and POSTs them here; this module returns ranked,
 * human-readable opportunities. Pure + deterministic (no LLM tokens) so
 * it is fast, free, and unit-testable.
 *
 *   POST /internal/seo/gsc-intelligence
 *     Request:  { workspace_id, site_url, rows: [{page,query,clicks,
 *                 impressions,ctr,position}], previous_rows?: [...] }
 *     Response: { striking_distance, ctr_gaps, cannibalization,
 *                 declining, opportunities, summary }
 *
 * Mount: require('./lu-gsc-intelligence').mountRoutes(app, requireSecret);
 */

// Industry-standard organic CTR-by-position benchmark (approx). Used to
// detect under-performing snippets (high impressions, CTR far below the
// curve → a title/meta rewrite opportunity).
const CTR_CURVE = {
    1: 0.280, 2: 0.150, 3: 0.110, 4: 0.080, 5: 0.060,
    6: 0.050, 7: 0.040, 8: 0.032, 9: 0.028, 10: 0.025,
};
function expectedCtr(position) {
    const p = Math.round(position);
    if (p <= 0) return CTR_CURVE[1];
    if (p <= 10) return CTR_CURVE[p];
    if (p <= 20) return 0.015;
    return 0.008;
}

function pct(n) { return Math.round(n * 1000) / 10; } // 0.123 -> 12.3 (%)
function clampTop(arr, n) { return arr.slice(0, n); }

/**
 * Core analyzer. Pure function — exported for unit tests.
 * @param {Array} rows   current snapshot rows
 * @param {Object} opts  { previousRows, minImpressions, limit }
 */
function analyzeGsc(rows, opts = {}) {
    const minImpr = opts.minImpressions != null ? opts.minImpressions : 20;
    const limit = opts.limit != null ? opts.limit : 20;
    const clean = (Array.isArray(rows) ? rows : [])
        .map(r => ({
            page: String(r.page || ''),
            query: String(r.query || ''),
            clicks: Number(r.clicks || 0),
            impressions: Number(r.impressions || 0),
            ctr: Number(r.ctr || 0),
            position: Number(r.position || 0),
        }))
        .filter(r => r.query && r.impressions > 0);

    // ── Striking distance: position 5–15, real impressions, page-1 reach ──
    // "Almost ranking" — small lifts here yield outsized click gains.
    const striking = clean
        .filter(r => r.position >= 5 && r.position <= 15 && r.impressions >= minImpr)
        .map(r => ({
            query: r.query, page: r.page,
            position: Math.round(r.position * 10) / 10,
            impressions: r.impressions, clicks: r.clicks,
            // weight: more impressions + closer to the top = higher
            score: Math.round(r.impressions * (16 - r.position) / 11),
            recommendation: `"${r.query}" sits at position ${Math.round(r.position)} with ${r.impressions} impressions — a focused content + internal-link push could move it onto page one.`,
        }))
        .sort((a, b) => b.score - a.score);

    // ── CTR gaps: ranking decently but under-clicked vs the position curve ──
    const ctrGaps = clean
        .filter(r => r.position <= 10 && r.impressions >= minImpr)
        .map(r => {
            const exp = expectedCtr(r.position);
            const gap = exp - r.ctr;
            return { r, exp, gap };
        })
        .filter(x => x.gap >= 0.02) // ≥2 pts below expected
        .map(({ r, exp, gap }) => ({
            query: r.query, page: r.page,
            position: Math.round(r.position * 10) / 10,
            impressions: r.impressions,
            actual_ctr: pct(r.ctr), expected_ctr: pct(exp),
            // lost clicks ≈ impressions * gap
            score: Math.round(r.impressions * gap),
            recommendation: `"${r.query}" ranks ${Math.round(r.position)} but only ${pct(r.ctr)}% click through (≈${pct(exp)}% expected) — a sharper title/meta description should recover roughly ${Math.round(r.impressions * gap)} clicks.`,
        }))
        .sort((a, b) => b.score - a.score);

    // ── Cannibalization: one query split across ≥2 pages ──
    const byQuery = {};
    for (const r of clean) {
        if (r.impressions < minImpr) continue;
        (byQuery[r.query] = byQuery[r.query] || []).push(r);
    }
    const cannibalization = Object.entries(byQuery)
        .filter(([, list]) => new Set(list.map(x => x.page)).size >= 2)
        .map(([query, list]) => {
            const pages = list
                .sort((a, b) => b.impressions - a.impressions)
                .map(x => ({ page: x.page, impressions: x.impressions, position: Math.round(x.position * 10) / 10 }));
            return {
                query,
                pages: clampTop(pages, 5),
                score: pages.reduce((s, p) => s + p.impressions, 0),
                recommendation: `${pages.length} of your pages compete for "${query}" — consolidate or differentiate them so one clear page wins the ranking.`,
            };
        })
        .sort((a, b) => b.score - a.score);

    // ── Decline: clicks down vs the previous snapshot (if provided) ──
    let declining = [];
    if (Array.isArray(opts.previousRows) && opts.previousRows.length) {
        const prevKey = {};
        for (const p of opts.previousRows) {
            prevKey[`${p.page}${p.query}`] = Number(p.clicks || 0);
        }
        declining = clean
            .map(r => {
                const before = prevKey[`${r.page}${r.query}`];
                if (before == null) return null;
                const delta = r.clicks - before;
                if (before < 5 || delta >= 0 || Math.abs(delta) < Math.max(3, before * 0.3)) return null;
                return {
                    query: r.query, page: r.page,
                    clicks_before: before, clicks_now: r.clicks, delta,
                    score: Math.abs(delta),
                    recommendation: `"${r.query}" dropped from ${before} to ${r.clicks} clicks — refresh the page and check for lost rankings or a SERP change.`,
                };
            })
            .filter(Boolean)
            .sort((a, b) => b.score - a.score);
    }

    // ── Unified, ranked opportunity feed (deduped, conversational) ──
    const tagged = [
        ...striking.map(x => ({ type: 'striking_distance', ...x })),
        ...ctrGaps.map(x => ({ type: 'ctr_gap', ...x })),
        ...cannibalization.map(x => ({ type: 'cannibalization', ...x })),
        ...declining.map(x => ({ type: 'declining', ...x })),
    ];
    const maxScore = tagged.reduce((m, o) => Math.max(m, o.score || 0), 0) || 1;
    const opportunities = tagged
        .map(o => ({
            type: o.type,
            query: o.query || null,
            page: o.page || (o.pages && o.pages[0] && o.pages[0].page) || null,
            priority: Math.max(1, Math.round((o.score / maxScore) * 100)),
            recommendation: o.recommendation,
        }))
        .sort((a, b) => b.priority - a.priority);

    return {
        striking_distance: clampTop(striking, limit),
        ctr_gaps: clampTop(ctrGaps, limit),
        cannibalization: clampTop(cannibalization, limit),
        declining: clampTop(declining, limit),
        opportunities: clampTop(opportunities, limit),
        summary: {
            rows_analyzed: clean.length,
            striking_distance: striking.length,
            ctr_gaps: ctrGaps.length,
            cannibalization: cannibalization.length,
            declining: declining.length,
        },
    };
}

function mountRoutes(app, requireSecret) {
    app.post('/internal/seo/gsc-intelligence', requireSecret, async (req, res) => {
        try {
            const { rows, previous_rows, min_impressions, limit } = req.body || {};
            const out = analyzeGsc(rows, {
                previousRows: previous_rows,
                minImpressions: min_impressions,
                limit,
            });
            res.json({ success: true, ...out });
        } catch (e) {
            res.status(500).json({ success: false, error: String(e && e.message || e) });
        }
    });
}

module.exports = { analyzeGsc, expectedCtr, mountRoutes };
