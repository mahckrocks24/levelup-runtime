'use strict';

/**
 * lu-creative.js — Creative domain module (FIX 2, v2.25.0)
 *
 * WHY THIS FILE EXISTS:
 *   lu-worker-manager.js requires './lu-creative' to resolve `generateImage` and
 *   `generateVideo` for the async creative queue worker. Without this file the
 *   worker throws MODULE_NOT_FOUND and crashes, blocking all domain workers.
 *
 * STRATEGY — NO LOGIC DUPLICATION:
 *   Image and video generation logic lives in the CREATIVE888 WordPress plugin
 *   (class-lucreative-rest.php). The runtime is NOT the owner of AI generation —
 *   it delegates back to WordPress via the tool executor pattern.
 *
 *   The async creative worker sends a POST to WP's lucreative/v1/generate/image
 *   or the video endpoint, using the worker job's wp_url and wp_secret.
 *   This preserves the single source of truth (PHP credit deduction, provider
 *   fallbacks, white-label pass) while enabling async queue processing.
 *
 * CREDIT SAFETY:
 *   Credits are deducted by LUCreative_REST::generate_image() on the PHP side,
 *   AFTER successful generation. If the WP call fails, no credits are charged.
 *   The idempotency key (30s transient) in the PHP route prevents double-charge
 *   if the worker retries.
 */

const https = require('https');
const http  = require('http');
const { URL } = require('url');

const CREATIVE_TIMEOUT_MS = 300_000; // 5 min — video generation can take 3-4 min

// ── Internal HTTP POST to WordPress ──────────────────────────────────
function _wpPost(wp_url, wp_secret, path, body) {
    return new Promise((resolve, reject) => {
        const endpoint = `${wp_url.replace(/\/$/, '')}/wp-json${path}`;
        const parsed   = new URL(endpoint);
        const isHttps  = parsed.protocol === 'https:';
        const lib      = isHttps ? https : http;
        const bodyStr  = JSON.stringify(body);

        const options = {
            hostname: parsed.hostname,
            port:     parsed.port || (isHttps ? 443 : 80),
            path:     parsed.pathname + parsed.search,
            method:   'POST',
            headers:  {
                'Content-Type':    'application/json',
                'Content-Length':  Buffer.byteLength(bodyStr).toString(),
                'X-LU-Secret':     wp_secret,
            },
            timeout: CREATIVE_TIMEOUT_MS,
            ...(isHttps ? { rejectUnauthorized: true } : {}),
        };

        const req = lib.request(options, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                try {
                    resolve({ status: res.statusCode, body: JSON.parse(raw) });
                } catch {
                    resolve({ status: res.statusCode, body: { raw } });
                }
            });
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error(`Creative WP call timeout after ${CREATIVE_TIMEOUT_MS}ms`));
        });
        req.on('error', reject);
        req.write(bodyStr);
        req.end();
    });
}

/**
 * Generate an image via the WordPress creative engine.
 * Delegates to lucreative/v1/generate/image — PHP owns the provider logic,
 * credit deduction, and asset storage.
 *
 * @param {object} payload
 * @param {string} payload.wp_url        — WordPress base URL
 * @param {string} payload.wp_secret     — X-LU-Secret header value
 * @param {string} payload.prompt        — generation prompt
 * @param {string} [payload.quality]     — 'hd' | 'standard'
 * @param {string} [payload.aspect_ratio] — '1:1' | '16:9' etc.
 * @param {number} [payload.workspace_id]
 * @param {string} [payload.use_case]
 * @returns {Promise<object>}  — { success, assets, job_id, ... }
 */
async function generateImage(payload) {
    const {
        wp_url, wp_secret,
        prompt, quality = 'hd',
        aspect_ratio = '1:1',
        workspace_id = 1,
        use_case = 'creative_queue',
    } = payload;

    if (!wp_url || !wp_secret) throw new Error('wp_url and wp_secret required for creative worker');
    if (!prompt)               throw new Error('prompt required for image generation');

    console.log(`[creative] generateImage: prompt=${prompt.slice(0, 60)}…`);

    const res = await _wpPost(wp_url, wp_secret, '/lucreative/v1/generate/image', {
        prompt,
        quality,
        aspect_ratio,
        workspace_id,
        use_case,
    });

    if (res.status >= 400) {
        const msg = res.body?.message || res.body?.error || `WP returned HTTP ${res.status}`;
        throw new Error(`Creative image generation failed: ${msg}`);
    }

    const data = res.body;
    if (!data.success) {
        throw new Error(`Creative image generation failed: ${data.message || data.error || 'unknown'}`);
    }

    console.log(`[creative] generateImage: done, assets=${data.assets?.length || 0}`);
    return data;
}

/**
 * Generate a video via the WordPress creative engine.
 * Delegates to lucreative/v1/generate/video — PHP owns the MiniMax/Runway
 * provider logic, async job queue, and asset storage.
 *
 * @param {object} payload
 * @param {string} payload.wp_url
 * @param {string} payload.wp_secret
 * @param {string} payload.prompt
 * @param {string} [payload.source_image_url]
 * @param {number} [payload.workspace_id]
 * @returns {Promise<object>}  — { success, job_id, status, ... }
 */
async function generateVideo(payload) {
    const {
        wp_url, wp_secret,
        prompt, source_image_url,
        workspace_id = 1,
    } = payload;

    if (!wp_url || !wp_secret) throw new Error('wp_url and wp_secret required for creative worker');
    if (!prompt)               throw new Error('prompt required for video generation');

    console.log(`[creative] generateVideo: prompt=${prompt.slice(0, 60)}…`);

    const res = await _wpPost(wp_url, wp_secret, '/lucreative/v1/generate/video', {
        prompt,
        source_image_url: source_image_url || null,
        workspace_id,
    });

    if (res.status >= 400) {
        const msg = res.body?.message || res.body?.error || `WP returned HTTP ${res.status}`;
        throw new Error(`Creative video generation failed: ${msg}`);
    }

    const data = res.body;
    if (!data.success) {
        throw new Error(`Creative video generation failed: ${data.message || data.error || 'unknown'}`);
    }

    console.log(`[creative] generateVideo: done, job_id=${data.job_id}`);
    return data;
}

module.exports = { generateImage, generateVideo };
