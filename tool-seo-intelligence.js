'use strict';

/**
 * tool-seo-intelligence.js — Wave 82
 *
 * Ports 6 proprietary SEO scoring/extraction algorithms from Laravel
 * (app/Engines/SEO/Services/*.php) into the runtime where they belong.
 *
 *   extractAnchor       — Wave 77-79 body-first n-gram anchor selection
 *   scoreCtr            — CTR potential weighted scoring (intent/title/desc/schema/url)
 *   computeSerpScore    — SERP rank → score formula averaged over keywords
 *   aeoComputeScore     — AEO 12-check weighted sum (article_jsonld 12, faqpage 12, ...)
 *   detectCorrection    — signal-matching + regex extraction for user corrections
 *   classifyIntent      — phrase-to-action intent classifier
 *
 * Each function is a verbatim port of its `_local` PHP counterpart so
 * Wave 81's parity tests stay green when the flag flips to ON.
 *
 * Mount via mountRoutes(app, requireSecret) — registers 6 POST routes
 * under /internal/seo/* with the same X-LevelUp-Secret middleware that
 * /internal/assistant uses.
 */

// ── HTML entity decode (minimal, handles common SEO content cases) ─
function decodeEntities(s) {
    if (!s) return '';
    return String(s)
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

// ── ALGORITHM 1 — extractAnchor (Wave 77-79) ───────────────────────
const ANCHOR_STOPWORDS = new Set([
    'the','a','an','and','or','but','of','for','to','in','on','at','by','with',
    'as','is','are','was','were','be','been','it','this','that','your','my','our',
    'their','from','about','what','how','why','can','will','more','most','some',
    'any','all','one','two','they','use','say','get','make','have','has','had',
    'do','does','did','should','would','could','must','may','also','very','just',
    'than','then','when','while','where','here','there','only','even','still','well',
    'off','out','up','down','into','over','under','through','between','i','we',
    'you','its','if','so','no','not','too',
]);

function extractAnchor(sourceBody, candidateTitle, candidateMeta, candidateFocusKeyword, usedAnchors) {
    if (!sourceBody || !candidateTitle) return null;
    usedAnchors = usedAnchors || [];

    // Strip <a> regions so we never re-link the same target.
    let bodyNoLinks = String(sourceBody).replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, '');
    // Wave 79h — strip <h1>...</h1> so title phrases don't enter pool.
    bodyNoLinks = bodyNoLinks.replace(/<h1\b[^>]*>[\s\S]*?<\/h1>/gi, '');
    // Wave 79c — tags become spaces so JerseyTLDR-style concat is impossible.
    let plain = bodyNoLinks.replace(/<[^>]+>/g, ' ');
    plain = decodeEntities(plain);
    plain = plain.replace(/\s+/g, ' ').trim();
    const plainLower = plain.toLowerCase();

    // Topical content-words from focus_keyword + title.
    const topicalSource = ((candidateFocusKeyword || '') + ' ' + candidateTitle)
        .toLowerCase()
        .replace(/[^a-z0-9\s\-]/gi, ' ')
        .trim();
    const topicalWords = new Set(
        topicalSource.split(/\s+/).filter(w => w.length >= 4 && !ANCHOR_STOPWORDS.has(w))
    );
    if (topicalWords.size === 0) return null;

    const usedLower = new Set(usedAnchors.map(a => String(a).toLowerCase()));

    // Wave 79d — sentence-aware n-gram extraction.
    const sentences = plain.split(/(?<=[.!?])\s+/);
    const candidates = [];
    const seen = new Set();

    for (const sentence of sentences) {
        const sentenceClean = sentence.replace(/[.,;:!?]/g, ' ').replace(/\s+/g, ' ').trim();
        if (!sentenceClean) continue;
        const sWords = sentenceClean.split(/\s+/);

        for (let i = 0; i < sWords.length; i++) {
            for (let len = 5; len >= 2; len--) {
                if (i + len > sWords.length) continue;
                let slice = sWords.slice(i, i + len);

                // Clean edge punctuation.
                const first = slice[0].replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '');
                const last = slice[slice.length - 1].replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '');
                if (!first || !last) continue;
                slice = slice.slice();
                slice[0] = first;
                slice[slice.length - 1] = last;

                const phrase = slice.join(' ');
                const phraseLower = phrase.toLowerCase();
                if (seen.has(phraseLower)) continue;
                seen.add(phraseLower);
                if (phrase.length < 8) continue;
                if (usedLower.has(phraseLower)) continue;
                if (/\b(amp|lt|gt|nbsp|quot|tldr)\b/i.test(phrase)) continue;

                const sliceLower = slice.map(s => s.toLowerCase());
                if (ANCHOR_STOPWORDS.has(sliceLower[0])) continue;
                if (ANCHOR_STOPWORDS.has(sliceLower[sliceLower.length - 1])) continue;

                const overlap = sliceLower.filter(w => topicalWords.has(w));
                if (overlap.length === 0) continue;

                const score = (overlap.length * 2) + Math.min(2, len - 2);
                candidates.push({ phrase, score, len });
            }
        }
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score;
        return b.len - a.len;
    });

    return candidates[0].phrase;
}

// ── ALGORITHM 2 — scoreCtr ─────────────────────────────────────────
function scoreCtr(data) {
    data = data || {};
    let score = 0;
    const reasons = [];

    // Intent alignment (30 pts).
    const intent = data.intent || 'unknown';
    if (intent === 'commercial' || intent === 'transactional') {
        score += 30; reasons.push('High-intent page type');
    } else if (intent === 'informational') {
        score += 20; reasons.push('Informational intent');
    } else {
        score += 10;
    }

    // Title length (25 pts).
    const title = String(data.meta_title || data.title || '');
    const titleLen = title.length;
    if (titleLen >= 30 && titleLen <= 60) {
        score += 25; reasons.push('Optimal title length');
    } else if (titleLen > 0) {
        score += 12; reasons.push('Title present but suboptimal length');
    }

    // Description length (25 pts).
    const desc = String(data.meta_description || '');
    const descLen = desc.length;
    if (descLen >= 70 && descLen <= 160) {
        score += 25; reasons.push('Optimal description length');
    } else if (descLen > 0) {
        score += 12;
    }

    // Schema markup (10 pts).
    if (data.has_schema) {
        score += 10; reasons.push('Schema markup detected');
    }

    // URL clarity (10 pts).
    const url = String(data.url || '');
    try {
        const path = url ? new URL(url).pathname : '';
        const slug = path.replace(/\/+$/, '').split('/').pop() || '';
        if (slug && slug.length <= 50 && !/[0-9]{5,}/.test(slug)) {
            score += 10; reasons.push('Clean URL structure');
        }
    } catch (_e) {
        // bad URL — no points
    }

    score = Math.min(100, score);
    const label = score >= 80 ? 'High' : (score >= 50 ? 'Medium' : 'Low');
    return { score, label, reasons };
}

// ── ALGORITHM 3 — computeSerpScore ─────────────────────────────────
function computeSerpScore(ranks) {
    if (!Array.isArray(ranks) || ranks.length === 0) return null;
    const total = ranks.length;
    let sum = 0;
    for (const rank of ranks) {
        if (rank === null || rank === undefined) continue;
        const contrib = Math.max(0, 105 - (parseInt(rank, 10) * 5));
        sum += contrib;
    }
    return Math.round(sum / total);
}

// ── ALGORITHM 4 — aeoComputeScore ──────────────────────────────────
const AEO_WEIGHTS = {
    article_jsonld:       12,
    faqpage_jsonld:       12,
    tldr_at_top:          12,
    ai_crawlers_allowed:  10,
    llms_txt_present:      8,
    date_modified:         8,
    question_h2s:          8,
    lists_tables:          8,
    external_citation:     6,
    images_with_alt:       6,
    meta_description_len:  5,
    title_length:          5,
};

function aeoComputeScore(checks) {
    checks = checks || {};
    let total = 0;
    for (const key of Object.keys(AEO_WEIGHTS)) {
        if (checks[key] && checks[key].pass) {
            total += AEO_WEIGHTS[key];
        }
    }
    return Math.min(100, total);
}

// ── ALGORITHM 5 — detectCorrection ─────────────────────────────────
const CORRECTION_SIGNALS = [
    "we don't", "we do not", "we aren't", "we are not", "not that",
    "that's wrong", "that is wrong", "correction", "i meant", "i mean",
    "actually", "we are", "we're a", "we're an", "we are a", "we are an",
    "our business is", "our business does", "our services are", "we offer",
    "we do ", "we focus on", "we specialise in", "we specialize in",
];

function splitServices(text) {
    // Drop "in <location>" suffix.
    text = text.replace(/\s+in\s+[A-Z][\w\s,]+$/u, '');
    text = text.replace(/\s+in\s+[a-z][a-z\s,]+\.?\s*$/u, '');
    // Normalize "and" / "&" to commas.
    text = text.replace(/\s+(?:and|&)\s+/gi, ',');
    const parts = text.split(',').map(p => p.replace(/^[\s,.\t\n\r\0\v]+|[\s,.\t\n\r\0\v]+$/g, ''));
    return parts.filter(p => p.length >= 3 && p.length <= 80);
}

function detectCorrection(message) {
    const m = String(message || '').trim();
    if (!m || m.length < 10) return null;

    const lower = m.toLowerCase();
    if (!CORRECTION_SIGNALS.some(sig => lower.includes(sig))) return null;

    let servicesText = null;
    let mm;
    if ((mm = m.match(/\bwe (?:do|offer|provide|focus on|specialise in|specialize in)\s+([^.!?]+)/i))) {
        servicesText = mm[1];
    } else if ((mm = m.match(/\bour (?:services|business|focus|specialty|specialities)\s+(?:are|is)\s+([^.!?]+)/i))) {
        servicesText = mm[1];
    }

    let businessType = null;
    if ((mm = m.match(/\bwe (?:are|'re)\s+(?:a |an )?([^.!?,]+?(?:business|company|agency|firm|provider|brand|specialist|specialists))/i))) {
        businessType = mm[1].trim();
    }

    let wrong = null;
    if ((mm = m.match(/\bnot\s+(?:about|just|for|in|only)\s+([^.!?,]+)/i))) {
        wrong = mm[1].trim();
    } else if ((mm = m.match(/\bwe (?:don't|do not|aren't|are not)\s+(?:sell|do|offer|deal in|focus on)\s+([^.!?,]+)/i))) {
        wrong = mm[1].trim();
    }

    const services = servicesText !== null ? splitServices(servicesText) : [];

    if (services.length === 0 && businessType === null && wrong === null) {
        return null;
    }

    return {
        wrong,
        correct: servicesText !== null ? servicesText.trim() : (businessType || m),
        services,
        business_type: businessType || (services.length >= 2 ? services.join(', ') : null),
    };
}

// ── ALGORITHM 6 — classifyIntent ───────────────────────────────────
const CONFIRMATIONS = [
    'proceed', 'yes', 'go ahead', 'do it', 'confirm', 'run it',
    'write it', 'execute it', 'ok', 'okay', 'sure', "let's do it",
    'lets do it', 'go', 'yes please', 'do that', 'write them',
    'run that', 'make it happen', 'go for it', 'yep', 'yeah',
    'absolutely', 'do all of them', 'yes do all of them',
    'do all', 'yes do them', 'all of them',
];
const NEGATIONS = [
    'no', 'cancel', 'stop', "don't", 'do not', 'skip', 'not yet',
    'wait', 'hold on', 'change', 'nevermind', 'never mind',
    'nope', 'forget it', 'abort',
];
const INTENT_EXECUTIONS = {
    deep_audit: ['run audit', 'full audit', 'scan my site', 'site audit', 'audit my site', 'run a full audit', 'run deep audit', 'run a deep audit', 'run deep audit on', 'run full audit', 'do a deep audit', 'do an audit', 'do a site audit', 'audit my ', 'deep audit my'],
    apply_link_suggestions: ['fix orphan', 'fix orphans', 'fix internal linking', 'apply link suggestion', 'apply link suggestions', 'apply the links', 'apply all links', 'apply the link suggestions', 'apply suggestions', 'add internal links', 'link the orphans', 'apply links to', 'apply internal link', 'apply internal links'],
    generate_article: ['write article', 'write a blog', 'write an article', 'generate article', 'generate an article', 'write me an article', 'write us an article', 'create article', 'plan article', 'plan articles', 'plan 6 articles'],
    serp_analysis: ['serp analysis', 'competitor analysis', 'check competitors', 'analyse competitors', 'analyze competitors'],
    add_keyword: ['add keyword', 'track keyword', 'add a keyword', 'start tracking'],
    generate_meta: ['generate meta', 'bulk generate meta', 'bulk meta', 'generate metas', 'meta titles'],
    ai_report: ['ai report', 'generate report', 'generate an ai report'],
    link_suggestions: ['link suggestions', 'internal link', 'generate links', 'find link opportunities'],
};

function classifyIntent(message, pendingExists) {
    const m = String(message || '').trim().toLowerCase();
    if (!m) return { type: 'conversation', action: null };

    const stripped = m.replace(/[.!?,]+$/, '');

    // Confirmation — exact match or starts-with for short messages.
    for (const c of CONFIRMATIONS) {
        if (stripped === c) return { type: 'confirmation', action: null };
        if (stripped.length <= 25 && (stripped.startsWith(c + ' ') || stripped.startsWith(c + ','))) {
            return { type: 'confirmation', action: null };
        }
    }
    // Negation.
    for (const n of NEGATIONS) {
        if (stripped === n) return { type: 'negation', action: null };
        if (stripped.length <= 25 && (stripped.startsWith(n + ' ') || stripped.startsWith(n + ','))) {
            return { type: 'negation', action: null };
        }
    }

    // Pending + short message → bias toward confirmation.
    if (pendingExists && stripped.length <= 25) {
        for (const c of CONFIRMATIONS) {
            if (stripped.includes(c)) return { type: 'confirmation', action: null };
        }
    }

    // Wave 14 regex preflight for apply_link_suggestions.
    if (
        /\bfix\b.{0,15}\borphan/i.test(m)
        || /\bapply\b.{0,15}\blink/i.test(m)
        || /\b(too\s+many|many|reduce|kill|clear)\s+orphan/i.test(m)
    ) {
        return { type: 'execution_request', action: 'apply_link_suggestions' };
    }

    // Execution requests — most-specific first.
    for (const action of Object.keys(INTENT_EXECUTIONS)) {
        for (const phrase of INTENT_EXECUTIONS[action]) {
            if (m.includes(phrase)) {
                return { type: 'execution_request', action };
            }
        }
    }

    return { type: 'conversation', action: null };
}

// ── Route mounting ─────────────────────────────────────────────────
function mountRoutes(app, requireSecret) {
    if (!app || !requireSecret) {
        throw new Error('mountRoutes(app, requireSecret) — both args required');
    }

    app.post('/internal/seo/extract-anchor', requireSecret, (req, res) => {
        try {
            const b = req.body || {};
            const anchor = extractAnchor(
                b.source_body || '',
                b.candidate_title || '',
                b.candidate_meta || null,
                b.candidate_focus_keyword || null,
                Array.isArray(b.used_anchors) ? b.used_anchors : []
            );
            res.json({ anchor });
        } catch (e) {
            console.error('[seo/extract-anchor]', e);
            res.status(500).json({ error: e.message, anchor: null });
        }
    });

    app.post('/internal/seo/score-ctr', requireSecret, (req, res) => {
        try {
            const b = req.body || {};
            const result = scoreCtr(b.page_data || {});
            res.json(result);
        } catch (e) {
            console.error('[seo/score-ctr]', e);
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/internal/seo/compute-serp-score', requireSecret, (req, res) => {
        try {
            const b = req.body || {};
            const score = computeSerpScore(Array.isArray(b.ranks) ? b.ranks : []);
            if (score === null) {
                return res.json({ score: null });
            }
            res.json({ score });
        } catch (e) {
            console.error('[seo/compute-serp-score]', e);
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/internal/seo/aeo-score', requireSecret, (req, res) => {
        try {
            const b = req.body || {};
            const score = aeoComputeScore(b.checks || {});
            res.json({ score });
        } catch (e) {
            console.error('[seo/aeo-score]', e);
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/internal/seo/detect-correction', requireSecret, (req, res) => {
        try {
            const b = req.body || {};
            const correction = detectCorrection(b.message || '');
            res.json({ correction });
        } catch (e) {
            console.error('[seo/detect-correction]', e);
            res.status(500).json({ error: e.message, correction: null });
        }
    });

    app.post('/internal/seo/classify-intent', requireSecret, (req, res) => {
        try {
            const b = req.body || {};
            const result = classifyIntent(b.message || '', Boolean(b.pending_exists));
            res.json(result);
        } catch (e) {
            console.error('[seo/classify-intent]', e);
            res.status(500).json({ error: e.message });
        }
    });

    console.log('[seo-intelligence] 6 /internal/seo/* routes mounted');
}

module.exports = {
    extractAnchor,
    scoreCtr,
    computeSerpScore,
    aeoComputeScore,
    detectCorrection,
    classifyIntent,
    splitServices,
    mountRoutes,
};
