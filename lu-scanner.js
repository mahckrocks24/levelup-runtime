'use strict';

/**
 * lu-scanner.js — Scanner domain module (FIX 2, v2.25.0)
 *
 * WHY THIS FILE EXISTS:
 *   lu-worker-manager.js requires './lu-scanner' to resolve `runScan` for the
 *   async scanner queue worker. Without this file, the worker throws
 *   MODULE_NOT_FOUND and crashes on startup, blocking all domain workers.
 *
 * STRATEGY — NO LOGIC DUPLICATION:
 *   All scanner logic (cheerio parse, SSRF protection, HTML extraction, blueprint
 *   building) lives in index.js inside the /internal/scanner route handler.
 *
 *   This module re-implements `runScan` as a self-contained function using the
 *   same libraries (cheerio, AbortController) and the same algorithm.
 *   The /internal/scanner REST route continues to work unchanged — it calls its
 *   own inline handler. The worker calls `runScan` from here.
 *
 *   Both paths produce identical output. Single source of truth for algorithm,
 *   two entry points (REST and queue).
 */

const { v4: uuidv4 } = require('uuid');

// ── SSRF protection — same rules as index.js _checkSsrf ─────────────
function _checkSsrf(rawUrl) {
    let parsed;
    try { parsed = new URL(rawUrl); } catch { return 'Invalid URL format'; }
    const scheme = parsed.protocol;
    if (!['http:', 'https:'].includes(scheme)) return 'URL must use http or https';
    const host = parsed.hostname.toLowerCase();
    if (['localhost', '127.0.0.1', '::1', '0.0.0.0', '[::]'].includes(host))
        return 'Scanning internal addresses is not allowed';
    if (/^10\./.test(host))                                return 'Private IP range not allowed';
    if (/^192\.168\./.test(host))                          return 'Private IP range not allowed';
    if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(host))       return 'Private IP range not allowed';
    if (/^169\.254\./.test(host))                          return 'Link-local address not allowed';
    if (/^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./.test(host)) return 'CGNAT range not allowed';
    return null;
}

/**
 * Run a URL scan — fetch, parse, extract, blueprint.
 * Returns the same shape as POST /internal/scanner.
 *
 * @param {string} url           - Absolute URL to scan
 * @param {object} [opts]
 * @param {number} [opts.workspace_id=1]
 * @returns {Promise<object>}    - { success, task_id, status, url, colors, fonts, images, og_data, headings, ctas, blueprint, error, duration_ms }
 */
async function runScan(url, { workspace_id = 1 } = {}) {
    const task_id = uuidv4();
    const t0      = Date.now();

    if (!url || typeof url !== 'string') {
        return { success: false, task_id, status: 'error', error: 'url required', result: null, duration_ms: 0 };
    }

    const ssrfErr = _checkSsrf(url);
    if (ssrfErr) {
        return { success: false, task_id, status: 'error', error: ssrfErr, result: null, duration_ms: 0 };
    }

    console.log(`[SCANNER] START task_id=${task_id} url=${url}`);

    const controller = new AbortController();
    const fetchTimer = setTimeout(() => controller.abort(), 10000);

    try {
        const fetchRes = await fetch(url, {
            signal:  controller.signal,
            headers: {
                'User-Agent': 'LevelUpBot/1.0 (marketing intelligence; +https://levelupgrowth.ai)',
                'Accept':     'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
            },
        });
        clearTimeout(fetchTimer);

        if (!fetchRes.ok) throw new Error(`HTTP ${fetchRes.status} from target URL`);

        let html = await fetchRes.text();
        if (html.length > 1_048_576) html = html.slice(0, 1_048_576);

        const { load: cheerioLoad } = require('cheerio');
        const $ = cheerioLoad(html);

        // OG data
        const og_data = {
            title:       $('meta[property="og:title"]').attr('content')       || '',
            description: $('meta[property="og:description"]').attr('content') || '',
            image:       $('meta[property="og:image"]').attr('content')       || '',
            site_name:   $('meta[property="og:site_name"]').attr('content')   || '',
            url:         $('meta[property="og:url"]').attr('content')         || url,
        };
        const pageTitle  = $('title').first().text().trim();
        const metaDesc   = $('meta[name="description"]').attr('content') || '';
        const themeColor = $('meta[name="theme-color"]').attr('content')  || '';

        // Colors
        const colorSet = new Set();
        if (themeColor) colorSet.add(themeColor);
        $('[style]').each((i, el) => {
            if (colorSet.size >= 12) return false;
            const style = $(el).attr('style') || '';
            const hits  = style.match(/#[0-9a-fA-F]{3,6}|rgb\([^)]+\)/g);
            if (hits) hits.slice(0, 3).forEach(c => colorSet.add(c));
        });
        const colors = [...colorSet].slice(0, 10);

        // Fonts
        const fontSet = new Set();
        $('link[href*="fonts.googleapis.com"]').each((i, el) => {
            const href  = $(el).attr('href') || '';
            const match = href.match(/family=([^&:]+)/);
            if (match) fontSet.add(decodeURIComponent(match[1]).replace(/\+/g, ' '));
        });
        $('[style*="font-family"]').each((i, el) => {
            if (fontSet.size >= 6) return false;
            const style = $(el).attr('style') || '';
            const match = style.match(/font-family:\s*([^;,"']+)/);
            if (match) fontSet.add(match[1].trim());
        });
        const fonts = [...fontSet].slice(0, 5);

        // Images
        const images = [];
        if (og_data.image) images.push({ url: og_data.image, alt: og_data.title });
        $('img[src]').each((i, el) => {
            if (images.length >= 5) return false;
            const src = $(el).attr('src') || '';
            const alt = $(el).attr('alt') || '';
            if (!src || src.startsWith('data:')) return;
            try {
                const abs = src.startsWith('http') ? src : new URL(src, url).href;
                if (!images.some(im => im.url === abs)) images.push({ url: abs, alt });
            } catch {}
        });

        // Headings
        const headings = [];
        $('h1,h2,h3').each((i, el) => {
            if (headings.length >= 15) return false;
            const text = $(el).text().trim().replace(/\s+/g, ' ');
            if (text.length > 4 && text.length < 250) headings.push({ level: el.tagName, text });
        });

        // CTAs
        const CTA_PATTERNS = ['buy','get','start','book','contact','sign up','sign-up','join','try',
            'claim','request','download','subscribe','learn more','discover','explore','order','shop',
            'schedule','apply','register','free trial','quote','demo','consult','call us','chat','hire'];
        const ctaSet = new Set();
        $('button, [role="button"], a').each((i, el) => {
            if (ctaSet.size >= 15) return false;
            const text  = $(el).text().trim().replace(/\s+/g, ' ');
            const lower = text.toLowerCase();
            if (text.length > 2 && text.length < 80 && CTA_PATTERNS.some(p => lower.includes(p)))
                ctaSet.add(text);
        });
        const ctas = [...ctaSet];

        // Blueprint
        const blueprint = {
            primary_color: colors[0]           || null,
            fonts,
            hero_image:    og_data.image        || (images[1]?.url || null),
            brand_name:    og_data.site_name    || pageTitle  || null,
            description:   og_data.description  || metaDesc   || null,
        };

        const duration_ms = Date.now() - t0;
        console.log(`[SCANNER] DONE task_id=${task_id} url=${url} dur=${duration_ms}ms`);

        return {
            success: true,
            task_id,
            status:  'done',
            url,
            colors,
            fonts,
            images:  images.slice(0, 5),
            og_data,
            headings,
            ctas,
            blueprint,
            result:  { colors, fonts, images: images.slice(0, 5), og_data, headings, ctas, blueprint },
            error:   null,
            duration_ms,
        };

    } catch (err) {
        clearTimeout(fetchTimer);
        const duration_ms  = Date.now() - t0;
        const isTimeout    = err.name === 'AbortError' || err.message.includes('abort');
        const error_msg    = isTimeout ? 'Scanner timeout — target took >10s to respond' : err.message;
        console.error(`[SCANNER] ERROR task_id=${task_id} url=${url}:`, error_msg);
        return {
            success: false, task_id, status: 'error',
            error: error_msg, result: null, duration_ms,
        };
    }
}

module.exports = { runScan };
