'use strict';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * DeepSeek V4 model registry + response guards
 * Incident restoration 2026-07-26 (DeepSeek retired deepseek-chat /
 * deepseek-reasoner on 2026-07-24 15:59 UTC; both now return HTTP 400).
 *
 * SCOPE: minimal incident patch. This is deliberately NOT a provider framework.
 * It centralises the model identifier, adds reasoning-token headroom, and
 * classifies two failure modes that V4 introduced. Nothing else.
 *
 * WHY HEADROOM EXISTS
 * V4 models always emit `reasoning_content`; reasoning tokens are counted
 * inside `completion_tokens` and therefore consume `max_tokens`. If the budget
 * is exhausted by reasoning the API returns HTTP 200 with content:"" and
 * finish_reason:"length" — a silent empty success.
 *
 * MEASURED reasoning cost on this platform's real workloads (2026-07-26):
 *   flash  write/long   max_tokens=1600 → reasoning   70 · content 1230 · stop
 *   flash  write/long   max_tokens=3600 → reasoning  324 · content 1000 · stop
 *   flash  planner JSON max_tokens=1500 → reasoning  246 · content  661 · stop
 *   flash  ai_run       max_tokens=1200 → reasoning   98 · content  860 · stop
 *   pro    planner JSON max_tokens=3500 → reasoning 1238 · content  586 · stop
 *
 * Flash reasoning stays modest (70–324). PRO is the outlier at 1238 — 6x flash
 * on an identical prompt. Pro against the planner's current 1500 budget would
 * need ~1824 tokens and WOULD truncate. Hence: flash is the restoration
 * default, and headroom is sized to cover the measured Pro worst case.
 *
 * HEADROOM = 2000 covers the measured Pro maximum (1238) with ~60% margin.
 *
 * Headroom is near cost-neutral: raising the ceiling does not raise typical
 * spend, because the model stops naturally (finish_reason:"stop"). Measured:
 * write/long consumed 1300 completion tokens at a 1600 budget and 1324 at a
 * 3600 budget — a 125% ceiling increase produced a 1.8% spend increase.
 *
 * A HARD CAP is retained so the ceiling can never become unbounded.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Model identifiers ────────────────────────────────────────────────────────
const DEFAULT_MODEL = process.env.DEEPSEEK_DEFAULT_MODEL || 'deepseek-v4-flash';
const PRO_MODEL     = process.env.DEEPSEEK_PRO_MODEL     || 'deepseek-v4-pro';

const SUPPORTED_MODELS = new Set(['deepseek-v4-flash', 'deepseek-v4-pro']);

// Retired 2026-07-24 — rejected by the API with HTTP 400.
const RETIRED_MODELS = new Set(['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder']);

const TIERS = {
    flash: DEFAULT_MODEL,
    pro:   PRO_MODEL,
};

// ── Token headroom ───────────────────────────────────────────────────────────
const REASONING_HEADROOM = Number(process.env.DEEPSEEK_REASONING_HEADROOM || 2000);

// Bounded: preserves cost control and existing timeout protection.
const MAX_TOKENS_CAP = Number(process.env.DEEPSEEK_MAX_TOKENS_CAP || 8192);

// ── Error types ──────────────────────────────────────────────────────────────
class DeepSeekModelError extends Error {
    constructor(message) { super(message); this.name = 'DeepSeekModelError'; this.code = 'DEEPSEEK_INVALID_MODEL'; }
}
class DeepSeekEmptyContentError extends Error {
    constructor(message, meta = {}) {
        super(message);
        this.name = 'DeepSeekEmptyContentError';
        this.code = 'DEEPSEEK_EMPTY_FINAL_CONTENT';
        this.meta = meta;
    }
}
class DeepSeekInvalidStructuredOutputError extends Error {
    constructor(message, meta = {}) {
        super(message);
        this.name = 'DeepSeekInvalidStructuredOutputError';
        this.code = 'DEEPSEEK_INVALID_STRUCTURED_OUTPUT';
        this.meta = meta;
    }
}

// ── Model resolution ─────────────────────────────────────────────────────────

/**
 * Resolve a tier name ('flash' | 'pro') to a concrete V4 model identifier.
 * Generic tier override so future workloads (e.g. Engineer888) can request Pro
 * without a new execution path. Not wired to any caller by default.
 */
function resolveModel(tier = 'flash') {
    const key = String(tier || 'flash').toLowerCase();
    const model = TIERS[key];
    if (!model) {
        throw new DeepSeekModelError(
            `Unknown DeepSeek tier "${tier}". Valid tiers: ${Object.keys(TIERS).join(', ')}`
        );
    }
    return assertModelSupported(model);
}

/**
 * Reject retired or unknown model identifiers before they reach the API.
 * Fails loudly rather than letting a retired name produce an opaque HTTP 400.
 */
function assertModelSupported(model) {
    const m = String(model || '').trim();
    if (RETIRED_MODELS.has(m)) {
        throw new DeepSeekModelError(
            `DeepSeek model "${m}" was retired on 2026-07-24 and is rejected by the API. ` +
            `Use one of: ${[...SUPPORTED_MODELS].join(', ')}`
        );
    }
    if (!SUPPORTED_MODELS.has(m)) {
        throw new DeepSeekModelError(
            `Unsupported DeepSeek model "${m}". Supported: ${[...SUPPORTED_MODELS].join(', ')}`
        );
    }
    return m;
}

/** Caller-supplied model wins if valid; otherwise the restoration default. */
function resolveRequestedModel(requested) {
    if (requested === undefined || requested === null || requested === '') return DEFAULT_MODEL;
    return assertModelSupported(requested);
}

// ── Token budget ─────────────────────────────────────────────────────────────

/**
 * Add reasoning headroom to a caller's content-token budget, bounded by a cap.
 * Preserves the caller's intent (content length) while ensuring reasoning
 * cannot starve the final answer.
 */
function withReasoningHeadroom(maxTokens, fallback = 1200) {
    const base = Number(maxTokens) > 0 ? Number(maxTokens) : fallback;
    return Math.min(base + REASONING_HEADROOM, MAX_TOKENS_CAP);
}

// ── Explicit output contract (v2.37.5) ──────────────────────────────────────
//
// WHAT WAS WRONG
// withReasoningHeadroom() silently raised the caller's budget: a caller asking
// for max_tokens=50 received a 2050-token provider budget and 517 completion
// tokens. The behaviour is CORRECT — V4 counts reasoning inside completion
// tokens, so an un-padded budget lets reasoning starve the answer entirely —
// but it was invisible. A caller could not discover that its declared limit had
// been changed, could not reason about cost, and could not tell whether an
// unexpected bill was its own fault.
//
// THE CONTRACT (v2 — preferred form)
// Callers declare the two budgets separately and get both back:
//     { output_budget: 3000, reasoning_budget: 2000 }
// effective_max_tokens = output_budget + reasoning_budget, capped.
//
// BACKWARD COMPATIBILITY (v1 — legacy form, still supported)
// A caller sending only `max_tokens` is treated exactly as before: the value is
// the OUTPUT budget and the default reasoning headroom is added. The behaviour
// is byte-identical to v2.37.4 — the only difference is that the response now
// reports what happened. No existing caller breaks.
//
// Unsupported values are REJECTED, never clamped silently: asking for more than
// the cap is a contract violation the caller needs to see.
const CONTRACT_VERSION = '1.0';

class DeepSeekOutputContractError extends Error {
    constructor(message, meta = {}) {
        super(message);
        this.name = 'DeepSeekOutputContractError';
        this.code = 'DEEPSEEK_OUTPUT_CONTRACT_VIOLATION';
        this.meta = meta;
    }
}

/**
 * Resolve a caller's declared budgets into an effective provider budget.
 *
 * @param  {object} req  { max_tokens?, output_budget?, reasoning_budget? }
 * @param  {number} fallbackOutput  used when the caller declares nothing
 * @return {object} { effective_max_tokens, output_budget, reasoning_budget,
 *                    transformed, contract_form, contract_version }
 * @throws {DeepSeekOutputContractError} on an unsupported declaration
 */
function resolveTokenBudget(req = {}, fallbackOutput = 1200) {
    const has = (v) => v !== undefined && v !== null && v !== '';

    const rawOutput    = has(req.output_budget)    ? Number(req.output_budget)    : null;
    const rawReasoning = has(req.reasoning_budget) ? Number(req.reasoning_budget) : null;
    const rawMax       = has(req.max_tokens)       ? Number(req.max_tokens)       : null;

    for (const [name, v] of [['output_budget', rawOutput], ['reasoning_budget', rawReasoning], ['max_tokens', rawMax]]) {
        if (v !== null && (!Number.isFinite(v) || v <= 0 || !Number.isInteger(v))) {
            throw new DeepSeekOutputContractError(
                `${name} must be a positive integer when supplied (received ${JSON.stringify(req[name])}).`,
                { field: name, received: req[name] }
            );
        }
    }

    // v2 explicit form wins when either explicit field is present.
    const explicit = rawOutput !== null || rawReasoning !== null;

    const outputBudget    = rawOutput    !== null ? rawOutput    : (rawMax !== null ? rawMax : fallbackOutput);
    const reasoningBudget = rawReasoning !== null ? rawReasoning : REASONING_HEADROOM;

    const effective = outputBudget + reasoningBudget;

    if (effective > MAX_TOKENS_CAP) {
        throw new DeepSeekOutputContractError(
            `Requested budget ${effective} tokens (output ${outputBudget} + reasoning ${reasoningBudget}) ` +
            `exceeds the runtime cap of ${MAX_TOKENS_CAP}. Reduce output_budget or reasoning_budget.`,
            { output_budget: outputBudget, reasoning_budget: reasoningBudget, effective_max_tokens: effective, cap: MAX_TOKENS_CAP }
        );
    }

    return {
        effective_max_tokens: effective,
        output_budget:        outputBudget,
        reasoning_budget:     reasoningBudget,
        // True whenever the effective provider budget differs from what a naive
        // reading of the caller's max_tokens would suggest.
        transformed:          !explicit && effective !== outputBudget,
        contract_form:        explicit ? 'v2_explicit' : 'v1_max_tokens',
        contract_version:     CONTRACT_VERSION,
    };
}

// ── Response guards ──────────────────────────────────────────────────────────

/** Normalise a message's final content to a string ('' when absent/null). */
function extractFinalContent(message) {
    if (!message) return '';
    const c = message.content;
    if (typeof c === 'string') return c;
    if (c === null || c === undefined) return '';
    return String(c);
}

/**
 * Treat HTTP 200 with no usable final content as a failure.
 *
 * A message carrying tool_calls legitimately has empty content — that is a
 * tool-call turn, not an empty answer, and must NOT be rejected.
 */
function assertUsableContent(content, meta = {}) {
    if (meta && meta.hasToolCalls) return content;
    if (typeof content !== 'string' || content.trim() === '') {
        const truncated = meta.finish_reason === 'length';
        throw new DeepSeekEmptyContentError(
            truncated
                ? 'DeepSeek returned empty final content (finish_reason=length): reasoning consumed the token budget. Raise max_tokens.'
                : 'DeepSeek returned empty final content despite HTTP 200.',
            {
                finish_reason:   meta.finish_reason || null,
                model:           meta.model || null,
                reasoning_tokens: meta.reasoning_tokens ?? null,
                max_tokens:      meta.max_tokens ?? null,
            }
        );
    }
    return content;
}

/**
 * Validate structured (JSON-object) output.
 * Rejects empty, invalid, truncated, and wrong-shaped payloads. Preserves a
 * redacted raw sample for diagnosis. Never returns malformed output as success.
 */
function parseStructuredOutput(content, opts = {}) {
    const { requiredFields = [], expectType = 'object', meta = {} } = opts;

    if (typeof content !== 'string' || content.trim() === '') {
        throw new DeepSeekInvalidStructuredOutputError(
            'Structured output empty — no JSON payload returned.',
            { reason: 'empty', finish_reason: meta.finish_reason || null, model: meta.model || null }
        );
    }

    let parsed;
    try {
        parsed = JSON.parse(content);
    } catch (e) {
        const truncated = meta.finish_reason === 'length';
        throw new DeepSeekInvalidStructuredOutputError(
            truncated
                ? `Structured output truncated (finish_reason=length): ${e.message}`
                : `Structured output is not valid JSON: ${e.message}`,
            {
                reason: truncated ? 'truncated' : 'invalid_json',
                finish_reason: meta.finish_reason || null,
                model: meta.model || null,
                raw_sample: redactSample(content),
                raw_length: content.length,
            }
        );
    }

    const actualType = Array.isArray(parsed) ? 'array' : typeof parsed;
    if (expectType && actualType !== expectType) {
        throw new DeepSeekInvalidStructuredOutputError(
            `Structured output top-level type is "${actualType}", expected "${expectType}".`,
            { reason: 'unexpected_type', actual_type: actualType, model: meta.model || null }
        );
    }

    const missing = requiredFields.filter(f => parsed[f] === undefined);
    if (missing.length) {
        throw new DeepSeekInvalidStructuredOutputError(
            `Structured output missing required field(s): ${missing.join(', ')}`,
            { reason: 'missing_fields', missing, model: meta.model || null }
        );
    }

    return parsed;
}

/** Truncated, secret-free sample for diagnostics. Never logs credentials. */
function redactSample(text, limit = 300) {
    return String(text || '')
        .slice(0, limit)
        .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***REDACTED***')
        .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer ***REDACTED***');
}

/**
 * Split V4 usage into input / reasoning / final-output tokens.
 * Values are only reported when the API supplies them — never invented.
 */
function extractUsage(usage = {}) {
    const details        = usage.completion_tokens_details || {};
    const reasoning      = details.reasoning_tokens;
    const completion     = usage.completion_tokens;
    const hasBoth        = typeof completion === 'number' && typeof reasoning === 'number';

    return {
        input_tokens:     usage.prompt_tokens ?? null,
        completion_tokens: completion ?? null,
        reasoning_tokens: reasoning ?? null,
        final_output_tokens: hasBoth ? completion - reasoning : null,
        total_tokens:     usage.total_tokens ?? null,
        cached_tokens:    usage.prompt_tokens_details ? (usage.prompt_tokens_details.cached_tokens ?? null) : null,
    };
}

module.exports = {
    DEFAULT_MODEL,
    PRO_MODEL,
    SUPPORTED_MODELS,
    RETIRED_MODELS,
    TIERS,
    REASONING_HEADROOM,
    MAX_TOKENS_CAP,
    resolveModel,
    resolveRequestedModel,
    assertModelSupported,
    withReasoningHeadroom,
    // v2.37.5 — explicit output contract
    CONTRACT_VERSION,
    resolveTokenBudget,
    DeepSeekOutputContractError,
    extractFinalContent,
    assertUsableContent,
    parseStructuredOutput,
    extractUsage,
    redactSample,
    DeepSeekModelError,
    DeepSeekEmptyContentError,
    DeepSeekInvalidStructuredOutputError,
};
