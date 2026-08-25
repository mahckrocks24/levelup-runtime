'use strict';

/**
 * LevelUp LLM Provider Layer
 *
 * v2.37.6 — THIS FILE NO LONGER TALKS TO A PROVIDER.
 *
 * Until v2.37.5 this module held its own axios call, its own PROVIDERS table,
 * its own model selection and its own error mapping. That made it the THIRD
 * provider-routing implementation in the tree (index.js /ai/run and the Sarah
 * synthesis route being the other two), and the three disagreed: only /ai/run
 * had a fallback, which is exactly why Sarah's dedicated synthesis died on a
 * DeepSeek empty-content response while /ai/run survived the same fault.
 *
 * Per the v2.37.6 ruling, routing was MOVED — not duplicated — into
 * lu-execution-router. Everything here is now a thin adapter that preserves the
 * legacy call/throw contract for the ~30 existing call sites (meeting-room,
 * builder-ai, task-worker, the tool registry, the agent loop) so none of them
 * had to change, while guaranteeing they all inherit the same provider
 * selection, fallback policy, output contract and typed errors.
 *
 * CONTRACT PRESERVED: still returns
 *   { content, tool_calls, finish_reason, usage, usage_split, model }
 * and still THROWS on failure. The thrown error now additionally carries
 * `.code` (typed taxonomy) and `.meta` (routing attribution) instead of being
 * flattened into an untyped "LLM network error: …" string.
 */

require('dotenv').config();
const router = require('./lu-execution-router');

/**
 * Reported for observability/compat only. The authoritative provider table
 * lives in lu-execution-router.PROVIDERS — this is a read-only projection of it
 * so that legacy callers of getProvider() keep working without creating a
 * second source of truth.
 */
function getProvider() {
    const name = (process.env.LLM_PROVIDER || 'deepseek').toLowerCase();
    const p = router.PROVIDERS[name];
    if (!p) throw new Error(`Unknown LLM_PROVIDER: ${name}`);
    return { name, model: p.defaultModel(), apiKeyEnv: p.apiKeyEnv };
}

async function callLLM({ messages, tools = [], max_tokens = 1500, temperature = 0.7,
                         useVision = false, capability = null, deadline_ms = null,
                         provider_timeout_ms = undefined, signal = null, lane = 'interactive' }) {
    // v2.37.8 — callers may now declare their capability. Chat declares
    // 'conversation' so it is routed to the provider that meets the chat SLO
    // rather than inheriting the long-synthesis chain, which is DeepSeek-first
    // and cannot. Omitting it preserves the previous behaviour exactly.
    const cap = capability || (useVision ? 'vision' : 'long_synthesis');
    const r = await router.execute({
        messages,
        tools,
        capability: cap,
        max_tokens,
        temperature,
        signal,
        ...(deadline_ms !== null ? { deadline_ms } : {}),
        ...(provider_timeout_ms !== undefined ? { provider_timeout_ms } : {}),
        // v2.37.9 — carried so the conversation lane's reserved concurrency
        // is actually reachable from the chat path.
        lane,
    });

    if (!r.ok) {
        const err = new Error(r.error_message || 'Execution failed');
        err.code = r.error_code;
        err.retryable = r.retryable;
        err.meta = router.metadata(r);
        throw err;
    }

    return {
        content:       r.content,
        tool_calls:    r.tool_calls || [],
        finish_reason: r.finish_reason,
        usage:         r.usage,
        usage_split:   r.usage,
        model:         r.actual_model,
        // additive routing attribution — legacy callers simply ignore these
        actual_provider: r.actual_provider,
        fallback_used:   r.fallback_used,
    };
}

async function runAgentLoop({ messages, toolDefs, toolRegistry, context, maxRounds = 5 }) {
    const allMessages = [...messages];
    const toolsUsed   = [];
    let rounds        = 0;

    while (rounds < maxRounds) {
        rounds++;
        const r = await callLLM({ messages: allMessages, tools: toolDefs });
        if (!r.tool_calls?.length) return { content: r.content, tools_used: toolsUsed, rounds };

        allMessages.push({ role: 'assistant', content: r.content, tool_calls: r.tool_calls });

        for (const tc of r.tool_calls) {
            const name = tc.function.name;
            let args = {};
            try { args = JSON.parse(tc.function.arguments || '{}'); } catch(e) {}
            const result = await toolRegistry.execute(name, args, context);
            toolsUsed.push({ name, args, success: result.success });
            allMessages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result.success ? result.data : { error: result.error }) });
        }
    }

    const final = await callLLM({ messages: allMessages, tools: [] });
    return { content: final.content, tools_used: toolsUsed, rounds };
}

module.exports = { callLLM, runAgentLoop, getProvider };
