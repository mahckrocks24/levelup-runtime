'use strict';

/**
 * LevelUp — Agent Search Route
 *
 * POST /internal/agent-search
 *
 * Server-side search for use by agents. Backends:
 *   - "dataforseo"  → DataForSEO SERP API (clean JSON, paid per query)
 *   - "duckduckgo"  → DuckDuckGo HTML scrape (zero-cost but CAPTCHA-prone
 *                     on server IPs; only useful for local dev / fallback)
 *
 * Backend selection: WEB_SEARCH_BACKEND env. Default = "dataforseo" if
 * DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD are set, else "duckduckgo".
 *
 * Optional per-request override (Laravel can pass these for workspace-
 * specific localisation):
 *   location_code  (DataForSEO integer code; default 2840 = US)
 *   language_code  (default "en")
 *
 * Laravel-side WebActivityService is the chokepoint that LOGS each
 * call and enforces caps. This route just performs the actual search.
 *
 * Request:
 *   { "query": "...", "workspace_id": int, "agent_slug": "...",
 *     "location_code"?: int, "language_code"?: "en" }
 *   + header X-LevelUp-Secret matching LU_SECRET
 *
 * Response (success):
 *   { success: true, query, backend, results: [{ title, url, snippet,
 *     position?, domain? }, ...] }
 *
 * Response (error):
 *   400 invalid input | 502 backend unreachable | 504 timeout
 */

const cheerio = require('cheerio');

// v2.37.0 (2026-07-18) — was 10_000, which was too tight and broke ~2 of every
// 3 searches. The DataForSEO `depth: 20` live SERP call measured 4.5-10s+ from
// Railway; a live 3-try test on 2026-07-18 gave 1 success and 2 aborts at
// exactly 10.18s. 30s matches the house value Laravel already uses
// (DATAFORSEO_TIMEOUT default 30 in app/Connectors/DataForSeoConnector.php),
// so runtime and Laravel now agree. Override with SEARCH_TIMEOUT_MS if needed.
// v2.37.2 — 30s was wrong: it equalled the route's own budget, so one slow
// attempt consumed everything and no retry could run. 20s x 3 attempts +
// backoff = ~62s, which fits the 75s budget agent-search now gets in index.js.
// Measured DataForSEO latency: 5.7s / 9.5s / 11.3s / 15.4s / 24.7s / 25.9s.
const SEARCH_TIMEOUT_MS = Number(process.env.SEARCH_TIMEOUT_MS || 20_000);
// v2.37.1 (2026-07-18) — DataForSEO task codes that are transient on THEIR
// side and therefore worth retrying. 40101 = "Internal SE Server Error"
// (https://docs.dataforseo.com/v3/appendix-errors/) — the search engine failed,
// not us. Measured: identical depth:20 requests succeeded 3/3 direct from the
// droplet while ~40% of Railway's calls returned 40101, and a single 40101
// killed the whole search because there was no retry. Two retries take the
// success rate from ~60% to ~94%.
const TRANSIENT_TASK_CODES = [40101, 40102, 40103, 50000];
const SEARCH_RETRIES     = Number(process.env.SEARCH_RETRIES || 2);
const SEARCH_RETRY_MS    = Number(process.env.SEARCH_RETRY_MS || 700);

const RESULTS_CAP = 10;
const DATAFORSEO_DEFAULT_LOCATION = 2840;   // United States
const DATAFORSEO_DEFAULT_LANGUAGE = 'en';

/**
 * v2.37.1 — retry only what is genuinely retryable.
 *
 * Retries on transient DataForSEO task codes (see TRANSIENT_TASK_CODES) and on
 * AbortError timeouts. Deliberately does NOT retry auth/billing failures
 * (40200 Payment Required, 40104 verify-account) — those are deterministic and
 * retrying them just burns time while the real problem goes unreported, which
 * is the failure mode that hid the 28-day outage in the first place.
 */
async function withRetry(fn, label) {
    let lastErr;
    for (let attempt = 0; attempt <= SEARCH_RETRIES; attempt++) {
        try {
            return await fn();
        } catch (e) {
            lastErr = e;
            const retryable = e.transient === true || e.name === 'AbortError';
            if (!retryable || attempt === SEARCH_RETRIES) break;
            console.warn(`[agent-search] ${label} attempt ${attempt + 1}/${SEARCH_RETRIES + 1} failed (${e.message}) — retrying`);
            await new Promise(r => setTimeout(r, SEARCH_RETRY_MS * (attempt + 1)));
        }
    }
    throw lastErr;
}

// ── Backend: DataForSEO ───────────────────────────────────────────────

async function searchDataForSeo(query, locationCode, languageCode) {
    const login    = process.env.DATAFORSEO_LOGIN;
    const password = process.env.DATAFORSEO_PASSWORD;
    if (!login || !password) {
        throw new Error('DATAFORSEO_LOGIN/PASSWORD env vars not set on runtime');
    }

    const authHeader = 'Basic ' + Buffer.from(`${login}:${password}`).toString('base64');
    const body = JSON.stringify([{
        keyword:       query,
        location_code: locationCode || DATAFORSEO_DEFAULT_LOCATION,
        language_code: languageCode || DATAFORSEO_DEFAULT_LANGUAGE,
        // v2.37.2 — was 20. RESULTS_CAP is 10 (see above) and the loop below
        // discards anything past it, so depth 20 paid for and waited on results
        // that were thrown away. Measured cost drop: $0.0035 -> $0.002 per
        // search (~43%) with identical output. Latency is dominated by
        // DataForSEO variability, not depth, so this is a cost win not a speed one.
        depth:         RESULTS_CAP,
        device:        'desktop',
    }]);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

    let res, json;
    try {
        res = await fetch('https://api.dataforseo.com/v3/serp/google/organic/live/advanced', {
            method:  'POST',
            signal:  controller.signal,
            headers: {
                'Authorization': authHeader,
                'Content-Type':  'application/json',
            },
            body,
        });
        json = await res.json();
    } finally {
        clearTimeout(timer);
    }

    // DataForSEO returns the real error in the body even on non-2xx — surface
    // that first; fall back to HTTP status only when body is truly empty.
    //
    // v2.37.0 (2026-07-18) — READ THE TASK STATUS, NOT THE ENVELOPE.
    // DataForSEO wraps task-level failures (40200 "Payment Required" when the
    // account is out of balance, 40104 "Please verify your account", …) inside
    // a TOP-LEVEL 20000 "Ok." envelope while returning a non-2xx HTTP status.
    // Reading only the envelope produced the useless error
    //   "DataForSEO 20000: Ok."
    // which is what `agent_web_activity` recorded for 58 consecutive failed
    // brand-mention scans between 2026-06-20 and 2026-07-18 — a 28-day outage
    // whose real cause (the DataForSEO balance hitting zero) was completely
    // hidden. Laravel fixed this exact bug on 2026-07-01 in
    // DataForSeoConnector::failureFrom(); the runtime never got the fix.
    // Prefer the task status_message and always include the HTTP status so
    // billing/auth failures are unmistakable.
    if (!res.ok || (json && json.status_code !== 20000)) {
        const task       = (json && json.tasks && json.tasks[0]) || null;
        const apiCode    = (task && task.status_code)    || (json && json.status_code)    || null;
        const apiMessage = (task && task.status_message) || (json && json.status_message) || null;
        const reason     = apiMessage
            ? (apiCode ? `${apiCode}: ${apiMessage}` : apiMessage)
            : 'no detail';
        const err = new Error(`DataForSEO HTTP ${res.status} / ${reason}`);
        err.raw         = json;
        err.httpStatus  = res.status;
        err.apiCode     = apiCode;
        // 40200 = out of balance. Name it explicitly so the next outage is
        // diagnosed in seconds instead of weeks.
        if (Number(apiCode) === 40200) {
            err.billing = 'PAYMENT_REQUIRED — top up DataForSEO';
        }
        throw err;
    }

    const task = (json.tasks && json.tasks[0]) || null;

    // v2.37.1 (2026-07-18) — carry the MESSAGE, not just the bare code.
    // v2.37.0 fixed the envelope branch above but left this one emitting a
    // naked `task_status_40101` — a number with no meaning, which is exactly
    // how these surfaced during testing. (40101 = "Internal SE Server Error".)
    if (!task || task.status_code !== 20000) {
        const code = task ? task.status_code : null;
        const msg  = (task && task.status_message) || 'no task returned';
        const err  = new Error(code ? `DataForSEO task ${code}: ${msg}` : 'no_task_returned');
        err.apiCode   = code;
        // 40101 is a SEARCH-ENGINE-side transient — safe and correct to retry.
        err.transient = TRANSIENT_TASK_CODES.includes(Number(code));
        throw err;
    }
    const result = (task.result && task.result[0]) || {};
    const items  = result.items || [];

    const results = [];
    for (const item of items) {
        if ((item.type || '') !== 'organic') continue;
        if (results.length >= RESULTS_CAP) break;
        results.push({
            position: item.rank_absolute || null,
            title:    item.title         || '',
            url:      item.url           || '',
            domain:   item.domain        || '',
            snippet:  item.description   || '',
        });
    }
    return results;
}

async function searchDuckDuckGoHtml(query) {
    const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

    try {
        const res = await fetch(url, {
            method: 'POST',
            signal: controller.signal,
            headers: {
                'User-Agent':   'Mozilla/5.0 (compatible; LevelUpAgentSearch/1.0)',
                'Accept':       'text/html',
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: 'q=' + encodeURIComponent(query),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();
        return parseDuckDuckGoHtml(html);
    } finally {
        clearTimeout(timer);
    }
}

function parseDuckDuckGoHtml(html) {
    const $ = cheerio.load(html);
    const results = [];

    // DuckDuckGo HTML wraps each result in .result block
    $('.result').each((i, el) => {
        if (results.length >= RESULTS_CAP) return false;
        const $el = $(el);
        const titleEl = $el.find('.result__a').first();
        const title = titleEl.text().trim();
        let url = titleEl.attr('href') || '';

        // DDG wraps URLs through /l/?uddg= — unwrap if present
        if (url.startsWith('//duckduckgo.com/l/?') || url.startsWith('/l/?')) {
            try {
                const u = new URL(url, 'https://duckduckgo.com');
                const target = u.searchParams.get('uddg');
                if (target) url = decodeURIComponent(target);
            } catch (_e) {}
        }
        if (url.startsWith('//')) url = 'https:' + url;

        const snippet = $el.find('.result__snippet').text().trim();
        if (title && url) results.push({ title, url, snippet });
    });

    return results;
}

function pickDefaultBackend() {
    if (process.env.WEB_SEARCH_BACKEND) return process.env.WEB_SEARCH_BACKEND.toLowerCase();
    if (process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD) return 'dataforseo';
    return 'duckduckgo';
}

function mountRoutes(app, requireSecret) {
    app.post('/internal/agent-search', requireSecret, async (req, res) => {
        const t0 = Date.now();
        const { query, workspace_id, agent_slug, location_code, language_code } = req.body || {};

        if (!query || typeof query !== 'string' || query.trim().length === 0) {
            return res.status(400).json({ success: false, error: 'query required (non-empty string)' });
        }
        if (query.length > 512) {
            return res.status(400).json({ success: false, error: 'query too long (>512 chars)' });
        }

        const backend = pickDefaultBackend();

        try {
            let results;
            if (backend === 'dataforseo') {
                results = await withRetry(
                    () => searchDataForSeo(query, location_code, language_code),
                    `ws=${workspace_id || '-'} q="${query.slice(0, 40)}"`
                );
            } else if (backend === 'duckduckgo') {
                results = await searchDuckDuckGoHtml(query);
            } else {
                return res.status(501).json({ success: false, error: `backend '${backend}' not implemented` });
            }

            console.log(`[agent-search] ws=${workspace_id || '-'} agent=${agent_slug || '-'} backend=${backend} q="${query.slice(0, 60)}" got=${results.length} dt=${Date.now() - t0}ms`);

            return res.json({
                success:     true,
                query,
                backend,
                workspace_id: workspace_id || null,
                agent_slug:   agent_slug   || null,
                results,
                result_count: results.length,
                elapsed_ms:   Date.now() - t0,
            });
        } catch (e) {
            const isTimeout = (e.name === 'AbortError');
            console.warn(`[agent-search] ws=${workspace_id || '-'} backend=${backend} q="${query.slice(0, 60)}" ${isTimeout ? 'TIMEOUT' : 'ERROR'}: ${e.message}`);
            return res.status(isTimeout ? 504 : 502).json({
                success: false,
                error:   isTimeout ? 'search_timeout' : 'backend_error',
                detail:  e.message,
                backend,
                // v2.37.0 — pass the diagnostic through to Laravel so
                // agent_web_activity.error records the REAL cause. Previously
                // only `detail` survived, and it said "DataForSEO 20000: Ok."
                ...(e.httpStatus ? { http_status: e.httpStatus } : {}),
                ...(e.apiCode    ? { api_code:    e.apiCode }    : {}),
                ...(e.billing    ? { billing:     e.billing }    : {}),
            });
        }
    });

    console.log('[agent-search] mounted: /internal/agent-search (backend=' + pickDefaultBackend() + ')');
}

module.exports = { mountRoutes };
