'use strict';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * LevelUp Runtime — typed error taxonomy (v2.37.5)
 *
 * WHY THIS EXISTS
 * Until v2.37.4 the runtime answered every slow request with one untyped
 * envelope:
 *
 *     503 {"error":"request_timeout","message":"Request took too long …"}
 *
 * A caller could not tell a provider timeout from a runtime deadline from an
 * upstream network stall, so it could not decide whether retrying was sensible.
 * Laravel's RuntimeClient::aiRun() mapped the whole class to
 * ['success' => false] with NO 'text' key, which is how Sarah's daily brief read
 * `text_len=0` and skipped silently for ten days across every workspace.
 *
 * CONTRACT
 * Every failure returns the same shape, so one parser handles all of them:
 *
 *   {
 *     success:      false,
 *     error:        "<stable machine code>",
 *     message:      "<human readable, safe to surface>",
 *     retryable:    true | false,
 *     retry_after_ms: <int|null>,
 *     stage:        "<where in the pipeline it failed>",
 *     request_id:   "<x-request-id echoed back>",
 *     elapsed_ms:   <int>,
 *     provider:     "deepseek" | "openai" | null,
 *     contract_version: "<runtime contract version>"
 *   }
 *
 * `error` values are STABLE. Adding a new one is additive; changing or removing
 * one is a breaking change requiring a contract-version bump.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const CONTRACT_VERSION = '1.0';

/**
 * The canonical taxonomy.
 *
 * retryable answers exactly one question: "would issuing this same request
 * again, unchanged, plausibly succeed?" A deadline breach is NOT retryable —
 * repeating identical work that already ran out of time simply burns the budget
 * twice. That distinction is what stops the blind-retry behaviour v2.37.4 had.
 */
const ERRORS = {
    provider_timeout: {
        http: 504,
        retryable: false,
        stage: 'provider_call',
        message: 'The model provider did not respond within its budget.',
    },
    runtime_deadline: {
        http: 503,
        retryable: false,
        stage: 'runtime_deadline',
        message: 'The runtime reached its request deadline before the work completed.',
    },
    // v2.37.9 — admission control refused the call because the process is at
    // its concurrency limit. Retryable and honest: the work was never started,
    // nothing was spent, and a moment later there will be room. This exists so
    // saturation surfaces as a typed 503 the caller can retry, instead of the
    // process accepting everything and becoming unreachable to the edge —
    // which is what produced 13 bare "upstream error" 502s in Pass A.
    runtime_saturated: {
        http: 503,
        retryable: true,
        stage: 'admission_control',
        message: 'The runtime is at its concurrency limit; the request was not started.',
    },
    upstream_timeout: {
        http: 504,
        retryable: true,
        stage: 'upstream_call',
        message: 'An upstream dependency timed out.',
    },
    rate_limited: {
        http: 429,
        retryable: true,
        retry_after_ms: 2000,
        stage: 'provider_call',
        message: 'The model provider rate-limited this request.',
    },
    provider_authentication_failed: {
        http: 502,
        retryable: false,
        stage: 'provider_call',
        message: 'The model provider rejected the runtime credentials.',
    },
    provider_unavailable: {
        http: 502,
        retryable: true,
        retry_after_ms: 5000,
        stage: 'provider_call',
        message: 'The model provider is unavailable.',
    },
    malformed_provider_response: {
        http: 502,
        retryable: false,
        stage: 'response_parse',
        message: 'The model provider returned a response the runtime could not use.',
    },
    output_contract_violation: {
        http: 400,
        retryable: false,
        stage: 'request_validation',
        message: 'The requested output budget is not permitted by the runtime contract.',
    },
    input_too_large: {
        http: 413,
        retryable: false,
        stage: 'request_validation',
        message: 'The request exceeds the documented maximum input size.',
    },
    request_cancelled: {
        http: 499,
        retryable: false,
        stage: 'cancelled',
        message: 'The request was cancelled before completion.',
    },
    unknown_runtime_failure: {
        http: 500,
        retryable: false,
        stage: 'unknown',
        message: 'The runtime failed for an unclassified reason.',
    },
};

/** Build the standard failure body. Never leaks prompts, payloads or secrets. */
function buildError(code, opts = {}) {
    const spec = ERRORS[code] || ERRORS.unknown_runtime_failure;
    const resolved = ERRORS[code] ? code : 'unknown_runtime_failure';

    return {
        success: false,
        error: resolved,
        message: opts.message || spec.message,
        retryable: typeof opts.retryable === 'boolean' ? opts.retryable : spec.retryable,
        retry_after_ms: opts.retry_after_ms ?? spec.retry_after_ms ?? null,
        stage: opts.stage || spec.stage,
        request_id: opts.request_id || null,
        elapsed_ms: typeof opts.elapsed_ms === 'number' ? opts.elapsed_ms : null,
        provider: opts.provider || null,
        contract_version: CONTRACT_VERSION,
        // Optional structured detail. Callers must tolerate its absence.
        detail: opts.detail || null,
    };
}

/** Send a typed failure. No-ops if the response has already been sent. */
function sendError(res, code, opts = {}) {
    if (res.headersSent) return false;
    const spec = ERRORS[code] || ERRORS.unknown_runtime_failure;
    res.status(opts.http || spec.http).json(buildError(code, opts));
    return true;
}

/**
 * Abort provenance (v2.37.7).
 *
 * WHY: an aborted HTTP request tells you almost nothing about WHO aborted it.
 * In production, DeepSeek exceeding the 55s provider budget mid-response made
 * axios reject with `AxiosError: aborted` — code ECONNRESET, no ECONNABORTED,
 * no ERR_CANCELED, and no "timeout" substring anywhere. The classifier could
 * not identify it, returned unknown_runtime_failure, and because that class is
 * fallback-prohibited the centralized fallback never fired. The router was
 * correct; it was simply told the wrong thing.
 *
 * Inferring intent from an error string is guesswork. The runtime already KNOWS
 * why it aborted at the moment it decides to, so it now records that reason
 * before aborting and classification reads it instead of guessing.
 */
const ABORT_REASONS = {
    PROVIDER_TIMEOUT: 'provider_timeout',
    CALLER_CANCELLED: 'caller_cancelled',
    RUNTIME_DEADLINE: 'runtime_deadline',
};

const ABORT_REASON_TO_CODE = {
    [ABORT_REASONS.PROVIDER_TIMEOUT]: 'provider_timeout',
    [ABORT_REASONS.CALLER_CANCELLED]: 'request_cancelled',
    [ABORT_REASONS.RUNTIME_DEADLINE]: 'runtime_deadline',
};

/** Does this error look like an aborted/cancelled transfer, whoever caused it? */
function isAbortShaped(err) {
    if (!err) return false;
    if (err.name === 'CanceledError' || err.name === 'AbortError') return true;
    if (['ERR_CANCELED', 'ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET'].includes(err.code)) return true;
    return /\b(aborted|canceled|cancelled|socket hang up|timeout)\b/i.test(err.message || '');
}

/**
 * Classify a thrown provider/axios error into the taxonomy.
 * Deliberately conservative: anything it cannot positively identify becomes
 * unknown_runtime_failure rather than being guessed into a retryable class.
 *
 * `abortReason` is the provenance recorded by whoever aborted the request. When
 * present AND the error is abort-shaped it is authoritative — provenance beats
 * string matching, always. The string heuristics below are retained only for
 * aborts with no recorded provenance (a genuine peer reset, or a code path not
 * yet carrying provenance).
 */
function classifyProviderError(err, provider = null, abortReason = null) {
    if (!err) return 'unknown_runtime_failure';

    // ── Provenance first ────────────────────────────────────────────────────
    // Guarded by isAbortShaped so a stale reason cannot hijack an unrelated
    // failure (e.g. a 401 arriving just after the timeout marker was set).
    if (abortReason && isAbortShaped(err)) {
        const mapped = ABORT_REASON_TO_CODE[abortReason];
        if (mapped) return mapped;
    }

    // ── Defensive heuristics, provenance absent ─────────────────────────────
    // Cancellation raised by an AbortController with no reason recorded.
    if (err.name === 'CanceledError' || err.name === 'AbortError' || err.code === 'ERR_CANCELED') {
        return 'request_cancelled';
    }
    // Axios socket/connection timeout — the provider never answered in time.
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || /timeout/i.test(err.message || '')) {
        return 'provider_timeout';
    }
    // The exact production shape: the socket was destroyed after the response
    // began. Without provenance this is indistinguishable from a peer reset, and
    // both are the provider failing to deliver — so it is a provider fault, not
    // an unclassifiable runtime defect. This is the compatibility net; the
    // provenance branch above is the mechanism.
    if (err.code === 'ECONNRESET' || /^aborted$/i.test((err.message || '').trim())) {
        return 'provider_timeout';
    }
    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') {
        return 'provider_unavailable';
    }

    const status = err.response && err.response.status;
    if (status === 401 || status === 403) return 'provider_authentication_failed';
    if (status === 429) return 'rate_limited';
    if (status === 408 || status === 504) return 'upstream_timeout';
    if (status >= 500) return 'provider_unavailable';
    if (status === 400) return 'malformed_provider_response';

    // Runtime-side response guards (deepseek-models.js).
    if (err.code === 'DEEPSEEK_EMPTY_FINAL_CONTENT') return 'malformed_provider_response';
    if (err.code === 'DEEPSEEK_INVALID_STRUCTURED_OUTPUT') return 'malformed_provider_response';
    if (err.code === 'DEEPSEEK_INVALID_MODEL') return 'output_contract_violation';

    return 'unknown_runtime_failure';
}

/** Is retrying this class of failure, unchanged, ever sensible? */
function isRetryable(code) {
    const spec = ERRORS[code];
    return spec ? Boolean(spec.retryable) : false;
}

module.exports = {
    CONTRACT_VERSION,
    ERRORS,
    ABORT_REASONS,
    ABORT_REASON_TO_CODE,
    isAbortShaped,
    buildError,
    sendError,
    classifyProviderError,
    isRetryable,
};
