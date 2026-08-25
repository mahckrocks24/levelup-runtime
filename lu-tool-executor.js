/**
 * LevelUp — Tool Executor
 *
 * Executes a single tool by calling the Laravel internal endpoint
 * POST /api/internal/tools/execute
 *
 * This runs inside the BullMQ worker — it is the only component
 * that calls back into WordPress. No direct DB access.
 *
 * Timeout per tool call: 30s (tools are usually fast REST + LLM calls)
 * On timeout: throws — BullMQ handles retry via job policy
 */

'use strict';

const https    = require('https');
const http     = require('http');
const { URL }  = require('url');
const registry = require('./tool-registry'); // Patch 3: endpoint resolution

const TOOL_TIMEOUT_MS = 30_000;

/**
 * Execute one tool via WP REST.
 *
 * Patch 3 (v2.24.1): Resolves tool endpoint from registry and sends
 * engine_path + method explicitly. WP lu_tools_execute() no longer needs
 * its own routing table — runtime is the single source of truth.
 *
 * @param {object} opts
 * @param {string} opts.tool_id
 * @param {string} opts.agent_id
 * @param {string} opts.task_id
 * @param {object} opts.params
 * @param {string} opts.wp_url       — base WP URL e.g. https://staging1.shukranuae.com
 * @param {string} opts.wp_secret    — X-LU-Secret header value
 * @returns {Promise<{tool_id, status, data, duration_ms}>}
 */
async function executeTool({ tool_id, agent_id, task_id, params, wp_url, wp_secret }) {
  const t0 = Date.now();
  const endpoint = `${(process.env.LARAVEL_BASE_URL || process.env.LARAVEL_URL || wp_url).replace(/\/$/, '')}/api/internal/tools/execute`;

  // Resolve tool endpoint from registry — derive engine_path for WP dispatcher
  let engine_path   = null;
  let engine_method = null;
  let resolvedParams = { ...params, task_id };

  try {
    const toolEndpoint = registry.getEndpoint(tool_id);
    if (toolEndpoint && toolEndpoint.ns) {
      engine_method = toolEndpoint.method;
      let path = toolEndpoint.path;
      // Resolve URL params: :id → actual value from params
      for (const key of (toolEndpoint.url_params || [])) {
        const val = params[key];
        if (val !== undefined) {
          path = path.replace(':' + key, encodeURIComponent(String(val)));
          // Remove resolved URL param from body params (it's now in the path)
          const { [key]: _removed, ...rest } = resolvedParams;
          resolvedParams = { ...rest, task_id };
        }
      }
      engine_path = '/' + toolEndpoint.ns + path;
    }
  } catch (e) {
    // Registry lookup failure is non-fatal — fall back to tool_id only dispatch
    console.warn(`[executor] registry.getEndpoint(${tool_id}) failed: ${e.message}`);
  }

  const body = JSON.stringify({
    tool_id,
    agent_id,
    params: resolvedParams,
    // Send explicit routing to WP — eliminates PHP routing table lookup
    ...(engine_path   ? { engine_path }   : {}),
    ...(engine_method ? { method: engine_method } : {}),
  });

  let data;
  let ok = true;
  let error_msg = null;

  try {
    const response = await httpPost(endpoint, body, {
      'Content-Type':  'application/json',
      'Content-Length': Buffer.byteLength(body).toString(),
      'X-LU-Secret':   wp_secret,
    }, TOOL_TIMEOUT_MS);

    if (response.status >= 400) {
      ok = false;
      error_msg = `HTTP ${response.status}: ${JSON.stringify(response.body).slice(0, 200)}`;
      data = response.body;
    } else {
      data = response.body?.data ?? response.body;
    }
  } catch (e) {
    ok = false;
    error_msg = e.message;
    data = null;
  }

  const duration_ms = Date.now() - t0;

  return {
    tool_id,
    status:      ok ? 'ok' : 'error',
    data:        data ?? null,
    duration_ms,
    error:       error_msg,
  };
}

/**
 * Execute all tools for a task sequentially.
 * Each tool result is recorded to lifecycle before moving to the next.
 *
 * @param {object[]} tools         — array of tool_ids
 * @param {object}   taskPayload   — job data from BullMQ
 * @param {Function} [onToolDone]  — async (result) => void — called after each tool
 * @param {Function} [onToolStart] — async (tool_id, index) => void — called before each tool (Phase 8)
 * @returns {Promise<{results, all_ok}>}
 */
async function executeTools(tools, taskPayload, onToolDone, onToolStart) {
  const { agent_id, task_id, params = {}, wp_url, wp_secret } = taskPayload;
  const results = [];
  let all_ok = true;

  for (let i = 0; i < tools.length; i++) {
    const tool_id = tools[i];
    // Optional pre-tool hook (Phase 8 activity events) — never blocks on error
    if (typeof onToolStart === 'function') {
      await onToolStart(tool_id, i).catch(() => {});
    }
    const result = await executeTool({ tool_id, agent_id, task_id, params, wp_url, wp_secret });
    results.push(result);
    if (result.status !== 'ok') all_ok = false;
    if (typeof onToolDone === 'function') await onToolDone(result);
  }

  return { results, all_ok };
}

// ── HTTP helper (no external deps — Node built-ins only) ─────────────

function httpPost(url_string, body, headers, timeout_ms) {
  return new Promise((resolve, reject) => {
    const parsed   = new URL(url_string);
    const isHttps  = parsed.protocol === 'https:';
    const lib      = isHttps ? https : http;

    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers,
      timeout:  timeout_ms,
      ...(isHttps ? { rejectUnauthorized: true } : {}),
    };

    const req = lib.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body_parsed;
        try { body_parsed = JSON.parse(raw); }
        catch { body_parsed = { raw }; }
        resolve({ status: res.statusCode, body: body_parsed });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Tool timeout after ${timeout_ms}ms: ${url_string}`));
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * POST the completed result back to WordPress.
 * This is the callback that triggers lu/v1/agent/result in the plugin.
 */
async function postResultCallback({ callback_url, wp_secret, task_id, agent_id, status, output, tool_results, duration_ms }) {
  const body = JSON.stringify({ task_id, agent_id, status, output, tool_calls: tool_results, duration_ms });
  try {
    const res = await httpPost(callback_url, body, {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(body).toString(),
      'X-LU-Secret':    wp_secret,
    }, 15_000);
    if (res.status >= 400) {
      console.error(`[executor] WP callback failed ${res.status} for task ${task_id}`);
    }
    return res;
  } catch (e) {
    // Callback failure is NOT fatal — result is already persisted in Redis
    console.error(`[executor] WP callback error for task ${task_id}:`, e.message);
    return null;
  }
}

module.exports = { executeTool, executeTools, postResultCallback };
