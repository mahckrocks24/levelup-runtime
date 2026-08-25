'use strict';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * LevelUp Runtime — ExecutionRouter (v2.37.6)
 *
 * THE SINGLE PROVIDER-ROUTING IMPLEMENTATION FOR THE ENTIRE RUNTIME.
 *
 * WHY THIS EXISTS
 * Until v2.37.5 provider routing lived in two incompatible places:
 *
 *   /ai/run                 → DeepSeek, then an inline OpenAI fallback
 *   llm.js callLLM          → DeepSeek only, NO recovery
 *                             (used by the Sarah synthesis routes, meeting-room,
 *                              builder-ai, task-worker, tools — ~30 call sites)
 *
 * That asymmetry is not cosmetic. It is the whole reason Sarah's dedicated
 * synthesis route returned 502 while /ai/run returned 200 for the SAME business
 * workload: DeepSeek V4 exhausts its token budget on reasoning and answers
 * HTTP 200 with empty content, /ai/run silently recovered on OpenAI, and the
 * dedicated route had nowhere to go.
 *
 * Copying the fallback into the second route would have fixed the symptom and
 * doubled the problem. Provider routing now exists EXACTLY ONCE, here.
 *
 * WHAT THIS OWNS — and no caller may re-implement:
 *   · provider selection            · capability matching
 *   · fallback sequencing           · fallback POLICY (one table, below)
 *   · retry policy                  · timeout policy
 *   · cancellation propagation      · provider + model attribution
 *   · reasoning / cost metadata     · request correlation
 *
 * WHAT CALLERS OWN:
 *   · building their own messages   · validating their own request
 *   · interpreting the typed result · their own response contract
 *
 * A caller containing `if (provider === …)`, a retry loop, or a second provider
 * URL is a violation of this contract and is caught by ArchitectureTest.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const axios = require('axios');
const ds = require('./deepseek-models');
const runtimeErrors = require('./lu-runtime-errors');
// v2.37.9 — the ONE transport: shared keep-alive pool + lane-aware admission
// control. Kept out of this file so both live in a single place and neither can
// be forked per endpoint.
const transport = require('./lu-provider-transport');

// ── Provider registry ───────────────────────────────────────────────────────
//
// `fallbackOnly` is descriptive metadata only — CAPABILITY_CHAINS below is what
// actually decides order, so a capability that legitimately needs OpenAI first
// (vision) can say so without contradicting a flag.
const PROVIDERS = {
    deepseek: {
        name: 'deepseek',
        url: 'https://api.deepseek.com/v1/chat/completions',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        defaultModel: () => ds.DEFAULT_MODEL,
        supportsReasoning: true,
        fallbackOnly: false,
    },
    openai: {
        name: 'openai',
        url: 'https://api.openai.com/v1/chat/completions',
        apiKeyEnv: 'OPENAI_API_KEY',
        defaultModel: () => process.env.OPENAI_FALLBACK_MODEL || 'gpt-4o-mini',
        supportsReasoning: false,
        fallbackOnly: true,
    },
};

// ── Fallback policy — THE ONE COPY ──────────────────────────────────────────
//
// A failure is worth retrying on a DIFFERENT provider only when the fault is
// the provider's, not the request's. Anything caused by the caller's input
// would fail identically everywhere, so retrying it only doubles the spend.
const FALLBACK_ALLOWED = new Set([
    'DEEPSEEK_EMPTY_FINAL_CONTENT',   // reasoning consumed the budget → 200 + empty
    'provider_timeout',
    'provider_unavailable',
    'rate_limited',
    'malformed_provider_response',
]);

const FALLBACK_PROHIBITED = new Set([
    'invalid_request',
    'provider_authentication_failed',
    'governance_rejection',
    'capability_rejection',
    'input_too_large',
    'output_contract_violation',
    'request_cancelled',
]);

/** Is a cross-provider fallback permitted for this failure class? */
function fallbackPermitted(code) {
    if (FALLBACK_PROHIBITED.has(code)) return false;
    return FALLBACK_ALLOWED.has(code);
}

// ── Capability → provider chain ─────────────────────────────────────────────
// The array order IS the preference order — first entry is the primary, the
// rest are fallbacks in order. `fallbackOnly` on a provider is descriptive
// metadata; the chain is what actually decides selection, so a capability that
// legitimately needs OpenAI first (vision) can say so without contradiction.
const CAPABILITY_CHAINS = {
    fast_classification: ['deepseek', 'openai'],
    structured_extraction: ['deepseek', 'openai'],
    long_synthesis: ['deepseek', 'openai'],
    // v2.37.8 — executive conversation. OpenAI-first, and this is a capability
    // decision backed by production measurement, not a preference:
    //
    //   F1 stress test, 163 turns on a context-rich workspace, DeepSeek-first:
    //     p50 20.5s · p90 57.2s · p99 67.8s · 30.1% error placeholders
    //   Same runtime, same day, gpt-4o-mini on /ai/run: 1.5s
    //
    // The chat SLO is p50 <8s, p90 <20s, p99 <40s, <1% placeholder. DeepSeek
    // cannot meet it on this workload, so it is not the capable provider here.
    // It remains the fallback: if OpenAI is unavailable a slow answer beats no
    // answer. Selection stays capability-based — the SLO is not being lowered
    // to accommodate a preferred model.
    conversation: ['openai', 'deepseek'],
    // Vision prefers gpt-4o (verified) but still degrades to DeepSeek, which is
    // what this path used before v2.37.6, so an unconfigured OPENAI_API_KEY
    // cannot turn a working call into a hard failure.
    vision: ['openai', 'deepseek'],
};

// Per-capability model overrides. Absent → the provider's default model.
const CAPABILITY_MODELS = {
    vision: { openai: 'gpt-4o' },
    conversation: { openai: process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini' },
};

// v2.37.8 — S1A-N01. A primary that consumes the entire route deadline leaves
// the fallback a remainder it cannot finish in, so the fallback exists on paper
// and fails in practice. Observed on the ws2 12:00 cycle: the primary ran ~58s
// of a 70s lane, the fallback got ~11.5s and timed out ("timeout of 11507ms
// exceeded"), and Laravel's outer fallback had to rescue the request.
//
// The primary is therefore capped so this much always remains for one fallback
// attempt. Reserving budget the primary might have used is the correct trade:
// a completed fallback beats a primary that was still trying when time ran out.
const FALLBACK_RESERVE_MS = Number(process.env.RUNTIME_FALLBACK_RESERVE_MS || 15_000);

function chainFor(capability) {
    return CAPABILITY_CHAINS[capability] || CAPABILITY_CHAINS.long_synthesis;
}

function modelFor(capability, providerName) {
    const override = CAPABILITY_MODELS[capability] && CAPABILITY_MODELS[capability][providerName];
    return override || PROVIDERS[providerName].defaultModel();
}

// ── Single provider invocation ──────────────────────────────────────────────

async function invokeProvider(provider, { messages, model, maxTokens, temperature, responseFormat, tools, signal, timeoutMs }) {
    const apiKey = process.env[provider.apiKeyEnv];
    if (!apiKey) {
        const e = new Error(`${provider.apiKeyEnv} not set`);
        e.__code = 'provider_authentication_failed';
        throw e;
    }

    const body = { model, messages, max_tokens: maxTokens, temperature };
    if (responseFormat) body.response_format = responseFormat;
    // Tool-calling is routed here too (v2.37.6). Previously llm.js kept its own
    // direct provider call for this case, which was a SECOND routing site.
    if (tools && tools.length) { body.tools = tools; body.tool_choice = 'auto'; }

    const started = Date.now();

    // ── Abort provenance (v2.37.7) ──────────────────────────────────────────
    // The runtime knows why it is about to abort; it must not make the
    // classifier guess from an error string afterwards. The reason is recorded
    // BEFORE any abort is triggered, so it is always available by the time the
    // rejection is classified.
    const AR = runtimeErrors.ABORT_REASONS;
    let abortReason = null;
    const recordReason = (r) => { if (!abortReason) abortReason = r; };

    const controller = new AbortController();
    let timedOut = false;

    // Marker fires just BEFORE axios's own timeout so the provenance is already
    // recorded when axios rejects. Axios stays the abort mechanism, which is
    // what produces the real production shape (`AxiosError: aborted`) rather
    // than a synthetic one — we label it, we do not replace it.
    const markerMs = Math.max(1, timeoutMs - 150);
    const marker = setTimeout(() => {
        timedOut = true;
        recordReason(AR.PROVIDER_TIMEOUT);
    }, markerMs);

    // A caller-supplied signal is a cancellation, not a timeout — unless the
    // caller already labelled it (a route-deadline abort carries its own tag).
    const onCallerAbort = () => {
        recordReason((signal && signal.__luAbortReason) || AR.CALLER_CANCELLED);
        controller.abort();
    };
    if (signal) {
        if (signal.aborted) onCallerAbort();
        else signal.addEventListener('abort', onCallerAbort, { once: true });
    }

    let response;
    try {
        response = await axios.post(provider.url, body, {
            timeout: timeoutMs,
            signal: controller.signal,
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            // v2.37.9 — shared keep-alive pool. Previously axios used Node's
            // default global agent (keepAlive:false, maxSockets:Infinity), so
            // every concurrent call paid a fresh TLS handshake and nothing
            // bounded the socket count. Under a burst those handshakes saturate
            // the single event loop that also answers the edge health probe,
            // and Railway returns a bare "upstream error" 502 — 13 of them in
            // 15 minutes during Certification Pass A. Reusing warm sockets
            // removes the handshake storm; the bound removes the pile-up.
            httpAgent: transport.httpAgent,
            httpsAgent: transport.httpsAgent,
        });
    } catch (err) {
        // If axios's timeout fired, the marker has already run. Belt-and-braces
        // for a slow event loop: an elapsed time at or past the budget with no
        // other recorded reason is a provider timeout by definition.
        if (!abortReason && (timedOut || Date.now() - started >= markerMs)) {
            recordReason(AR.PROVIDER_TIMEOUT);
        }
        err.__abortReason = abortReason;
        err.__code = runtimeErrors.classifyProviderError(err, provider.name, abortReason);
        err.__elapsed = Date.now() - started;
        throw err;
    } finally {
        clearTimeout(marker);
        if (signal) signal.removeEventListener('abort', onCallerAbort);
    }

    const choice = response.data && response.data.choices && response.data.choices[0];
    if (!choice || !choice.message) {
        const e = new Error('Provider returned no choices');
        e.__code = 'malformed_provider_response';
        e.__elapsed = Date.now() - started;
        throw e;
    }

    const content = ds.extractFinalContent(choice.message);
    const toolCalls = choice.message.tool_calls || [];
    const usage = ds.extractUsage(response.data.usage || {});

    // HTTP 200 with no usable content is a FAILURE, not a success. This is the
    // exact condition that broke Sarah's dedicated synthesis: V4 reasoning
    // consumes max_tokens and the API answers 200 with content:"".
    try {
        ds.assertUsableContent(content, {
            hasToolCalls: toolCalls.length > 0,
            finish_reason: choice.finish_reason,
            model,
            reasoning_tokens: usage.reasoning_tokens,
            max_tokens: maxTokens,
        });
    } catch (emptyErr) {
        // Preserve the TYPED code. v2.37.5's llm.js rethrew this as
        // "LLM network error: …", destroying the classification and every piece
        // of diagnostic meta with it.
        emptyErr.__code = emptyErr.code === 'DEEPSEEK_EMPTY_FINAL_CONTENT'
            ? 'DEEPSEEK_EMPTY_FINAL_CONTENT'
            : 'malformed_provider_response';
        emptyErr.__elapsed = Date.now() - started;
        emptyErr.__meta = emptyErr.meta || null;
        throw emptyErr;
    }

    return {
        content,
        tool_calls: toolCalls,
        finish_reason: choice.finish_reason || 'stop',
        usage,
        model,
        elapsed_ms: Date.now() - started,
    };
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Execute a model request through the single routing engine.
 *
 * Never throws for provider failure — always resolves to a typed result whose
 * `ok` flag the caller must check. That is deliberate: a thrown error is easy
 * to swallow and relabel, which is precisely how the original defect hid.
 */
async function execute(opts = {}) {
    const {
        messages,
        capability = 'long_synthesis',
        max_tokens,
        output_budget,
        reasoning_budget,
        temperature = 0.7,
        response_format = null,
        tools = [],
        signal = null,
        request_id = null,
        deadline_ms = null,      // total wall-clock budget remaining, if any
        provider_timeout_ms = 55_000,
        // v2.37.9 — the workload this call belongs to, from req.runtimeLane.
        // Defaults to 'interactive' so a caller that has not been updated is
        // treated as ordinary work and can never occupy the conversation
        // reserve by accident.
        lane = 'interactive',
    } = opts;

    const startedAt = Date.now();

    // Output contract resolved ONCE, centrally.
    let budget;
    try {
        budget = ds.resolveTokenBudget({ max_tokens, output_budget, reasoning_budget }, 1200);
    } catch (e) {
        return failure('output_contract_violation', e.message, {
            request_id, elapsed_ms: 0, stage: 'request_validation', detail: e.meta || null,
        });
    }

    const chain = chainFor(capability).filter((p) => {
        const prov = PROVIDERS[p];
        return prov && process.env[prov.apiKeyEnv];
    });

    if (!chain.length) {
        return failure('provider_unavailable', 'No provider is configured for this capability.', {
            request_id, elapsed_ms: 0, stage: 'provider_selection',
        });
    }

    const requestedProvider = chain[0];
    const requestedModel = modelFor(capability, requestedProvider);

    let primaryErrorCode = null;
    let primaryErrorMessage = null;
    let primaryElapsed = null;
    let fallbackElapsed = null;

    for (let i = 0; i < chain.length; i++) {
        const provider = PROVIDERS[chain[i]];
        const isFallback = i > 0;

        if (isFallback) {
            if (!fallbackPermitted(primaryErrorCode)) {
                break; // policy says another provider cannot help
            }
            if (signal && signal.aborted) break;
            const spent = Date.now() - startedAt;
            if (deadline_ms !== null && deadline_ms - spent < 8_000) break; // no room to finish
        }
        // Budget for this attempt. On the PRIMARY, hold FALLBACK_RESERVE_MS back
        // so a fallback still has room to complete (S1A-N01). On a fallback
        // attempt there is nothing left to protect, so it may use the remainder.
        let remaining;
        if (deadline_ms === null) {
            remaining = provider_timeout_ms;
        } else {
            const left = deadline_ms - (Date.now() - startedAt) - 3_000;
            const reserve = (!isFallback && chain.length > 1) ? FALLBACK_RESERVE_MS : 0;
            remaining = Math.max(5_000, Math.min(provider_timeout_ms, left - reserve));
        }

        // ── Admission control (v2.37.9) ─────────────────────────────────────
        // A slot is taken immediately before the provider call and released the
        // moment it settles, so the limiter measures real in-flight work rather
        // than request lifetime. The wait budget never exceeds what this attempt
        // actually has left — waiting past the deadline would only convert a
        // fast, honest saturation error into a slow timeout.
        let releaseSlot;
        try {
            const waitBudget = Math.max(0, Math.min(remaining - 2_000, 10_000));
            releaseSlot = await transport.acquire(lane, waitBudget);
        } catch (admissionErr) {
            return failure('runtime_saturated', admissionErr.message, {
                request_id,
                elapsed_ms: Date.now() - startedAt,
                provider: provider.name,
                stage: 'admission_control',
                detail: {
                    lane,
                    requested_provider: requestedProvider,
                    attempted_providers: chain.slice(0, i + 1),
                    concurrency: transport.snapshot(),
                },
            });
        }

        try {
            const r = await invokeProvider(provider, {
                messages,
                model: modelFor(capability, provider.name),
                maxTokens: budget.effective_max_tokens,
                temperature,
                responseFormat: response_format,
                tools,
                signal,
                timeoutMs: remaining,
            });

            if (isFallback) fallbackElapsed = r.elapsed_ms; else primaryElapsed = r.elapsed_ms;

            return {
                ok: true,
                content: r.content,
                tool_calls: r.tool_calls,
                finish_reason: r.finish_reason,
                requested_provider: requestedProvider,
                actual_provider: provider.name,
                requested_model: requestedModel,
                actual_model: r.model,
                fallback_used: isFallback,
                fallback_reason: isFallback ? primaryErrorCode : null,
                primary_error_code: primaryErrorCode,
                primary_elapsed_ms: primaryElapsed,
                fallback_elapsed_ms: fallbackElapsed,
                usage: r.usage,
                reasoning_tokens: r.usage.reasoning_tokens,
                output_tokens: r.usage.final_output_tokens,
                effective_output_budget: budget.effective_max_tokens,
                budget,
                request_id,
                lane,
                concurrency: transport.snapshot(),
                retryable: false,
                stage: 'complete',
                elapsed_ms: Date.now() - startedAt,
            };
        } catch (err) {
            const code = err.__code || runtimeErrors.classifyProviderError(err, provider.name);
            const msg = err.message || String(err);
            if (isFallback) {
                fallbackElapsed = err.__elapsed || null;
                return failure(code, msg, {
                    request_id,
                    elapsed_ms: Date.now() - startedAt,
                    provider: provider.name,
                    stage: 'fallback_provider_call',
                    detail: {
                        requested_provider: requestedProvider,
                        attempted_providers: chain.slice(0, i + 1),
                        primary_error_code: primaryErrorCode,
                        primary_elapsed_ms: primaryElapsed,
                        fallback_elapsed_ms: fallbackElapsed,
                        effective_output_budget: budget.effective_max_tokens,
                    },
                });
            }
            primaryErrorCode = code;
            primaryErrorMessage = msg;
            primaryElapsed = err.__elapsed || (Date.now() - startedAt);
            console.warn(`[router] primary ${provider.name} failed: ${code} — ${msg.slice(0, 160)}`);
        } finally {
            // Released on EVERY path — success, primary failure, fallback
            // failure, and the early `return` inside the try. A leaked slot
            // would shrink the pool permanently and reproduce the exact
            // saturation this change exists to prevent.
            if (releaseSlot) releaseSlot();
        }
    }

    return failure(primaryErrorCode || 'unknown_runtime_failure', primaryErrorMessage || 'Execution failed.', {
        request_id,
        elapsed_ms: Date.now() - startedAt,
        provider: requestedProvider,
        stage: 'primary_provider_call',
        detail: {
            requested_provider: requestedProvider,
            requested_model: requestedModel,
            fallback_permitted: fallbackPermitted(primaryErrorCode),
            primary_error_code: primaryErrorCode,
            primary_elapsed_ms: primaryElapsed,
            effective_output_budget: budget.effective_max_tokens,
        },
    });
}

function failure(code, message, opts = {}) {
    const body = runtimeErrors.buildError(code, { ...opts, message });
    return {
        ok: false,
        error_code: body.error,
        error_message: body.message,
        retryable: body.retryable,
        stage: body.stage,
        request_id: body.request_id,
        elapsed_ms: body.elapsed_ms,
        provider: body.provider,
        detail: body.detail,
        contract_version: body.contract_version,
        // attribution fields kept present-but-null so every caller can relay a
        // uniform shape without conditionals
        requested_provider: (opts.detail && opts.detail.requested_provider) || opts.provider || null,
        actual_provider: null,
        requested_model: (opts.detail && opts.detail.requested_model) || null,
        actual_model: null,
        fallback_used: false,
        fallback_reason: (opts.detail && opts.detail.primary_error_code) || null,
        primary_error_code: (opts.detail && opts.detail.primary_error_code) || body.error,
        primary_elapsed_ms: (opts.detail && opts.detail.primary_elapsed_ms) || null,
        fallback_elapsed_ms: (opts.detail && opts.detail.fallback_elapsed_ms) || null,
        usage: null,
        reasoning_tokens: null,
        output_tokens: null,
        effective_output_budget: (opts.detail && opts.detail.effective_output_budget) || null,
        finish_reason: null,
    };
}

/** Uniform metadata block every caller relays verbatim. */
function metadata(result) {
    return {
        requested_provider: result.requested_provider,
        actual_provider: result.actual_provider,
        requested_model: result.requested_model,
        actual_model: result.actual_model,
        fallback_used: result.fallback_used,
        fallback_reason: result.fallback_reason,
        primary_error_code: result.primary_error_code,
        primary_elapsed_ms: result.primary_elapsed_ms,
        fallback_elapsed_ms: result.fallback_elapsed_ms,
        reasoning_tokens: result.reasoning_tokens,
        output_tokens: result.output_tokens,
        finish_reason: result.finish_reason,
        effective_output_budget: result.effective_output_budget,
        request_id: result.request_id,
        retryable: result.retryable,
        stage: result.stage,
    };
}

module.exports = {
    execute,
    metadata,
    fallbackPermitted,
    FALLBACK_ALLOWED,
    FALLBACK_PROHIBITED,
    PROVIDERS,
    CAPABILITY_CHAINS,
};
