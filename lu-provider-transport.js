'use strict';
/**
 * SARAH888 v2.37.9 — shared provider transport and admission control.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Certification Pass A produced 13 HTTP 502s in 15 minutes against a
 * historical baseline of roughly one every few days. Laravel logged the body
 * as the plain string "upstream error" — a shape this codebase never emits
 * (every application failure is the structured {success:false,error:<code>}
 * envelope from lu-runtime-errors). That string is Railway's edge telling us
 * it could not reach the container at all.
 *
 * The container was not crashing on provider errors. It was becoming
 * unreachable under load, and the reason was in the transport:
 *
 *   · axios was using Node's DEFAULT global agent
 *   · which means keepAlive: false and maxSockets: Infinity
 *   · so every concurrent provider call opened a NEW TCP + TLS connection
 *   · and nothing anywhere bounded how many could be in flight at once
 *
 * A burst of background write_article work alongside chat therefore produced
 * dozens of simultaneous TLS handshakes. TLS negotiation is CPU-bound and runs
 * on the same single event loop that answers the edge, so the process stopped
 * responding long enough for the proxy to give up. The 502s clustered
 * immediately after a 20-task burst, which is exactly the shape this predicts.
 *
 * ── WHAT THIS DOES ─────────────────────────────────────────────────────────
 * 1. ONE keep-alive agent per protocol, with a bounded socket pool. Connections
 *    are reused, so a burst costs a handshake once rather than once per call.
 * 2. Admission control with WORKLOAD ISOLATION. The conversation lane holds a
 *    reserved share of concurrency that background work can never occupy, so a
 *    synthesis or article burst cannot starve a human waiting in a chat window.
 *    The ruling was explicit that isolation is preferred over pausing customer
 *    automation, and this is that mechanism.
 * 3. BOUNDED backpressure. A caller that cannot be admitted waits only as long
 *    as its own lane deadline allows, then fails fast with a typed, retryable
 *    error. Nothing queues indefinitely, so saturation degrades honestly
 *    instead of collapsing the process.
 *
 * Deliberately NOT here: retries. The 502 is an edge failure the runtime never
 * sees, so a router-side retry cannot observe it. Retry belongs to the caller
 * that received the 502 — Laravel's shared RuntimeClient — and is delivered
 * separately. Adding retries here as well would produce a retry storm, which is
 * the failure mode this module exists to prevent.
 */

const http  = require('http');
const https = require('https');

// ── Socket pool ─────────────────────────────────────────────────────────────
// maxSockets is per-host. Providers are few, so this is effectively the cap on
// concurrent outbound provider connections. It sits ABOVE MAX_CONCURRENT so the
// limiter, not the socket pool, is what applies backpressure — a request should
// be told to wait by admission control, never silently parked in the agent's
// internal queue where it has no deadline and no telemetry.
const MAX_SOCKETS = Number(process.env.RUNTIME_MAX_SOCKETS || 64);

const agentOptions = {
    keepAlive: true,
    keepAliveMsecs: 15_000,
    maxSockets: MAX_SOCKETS,
    maxFreeSockets: 16,
    timeout: 90_000,
    scheduling: 'lifo',   // reuse warm sockets first; cold ones idle out
};

const httpAgent  = new http.Agent(agentOptions);
const httpsAgent = new https.Agent(agentOptions);

// ── Admission control ───────────────────────────────────────────────────────
// Total concurrent provider calls allowed across the whole process.
const MAX_CONCURRENT = Number(process.env.RUNTIME_MAX_CONCURRENT_PROVIDER_CALLS || 24);

// Slots only the conversation lane may occupy. Background work is capped at
// (MAX_CONCURRENT - CONVERSATION_RESERVED) no matter how much of it arrives.
const CONVERSATION_RESERVED = Number(process.env.RUNTIME_CONVERSATION_RESERVED_SLOTS || 8);

// Longest a caller will wait for a slot before failing fast. Overridden per
// call by the lane's own remaining deadline where that is smaller.
const MAX_WAIT_MS = Number(process.env.RUNTIME_ADMISSION_MAX_WAIT_MS || 10_000);

const state = {
    inFlight: 0,               // total
    inFlightByLane: Object.create(null),
    waiting: [],               // { lane, resolve, reject, timer, enqueuedAt }
    admitted: 0,
    rejected: 0,
    peakInFlight: 0,
    peakWaiting: 0,
};

function laneCount(lane) { return state.inFlightByLane[lane] || 0; }

/**
 * Is there room for this lane right now?
 *
 * Conversation may use the whole pool. Everything else must leave the
 * conversation reserve untouched — that subtraction IS the isolation.
 */
function hasCapacity(lane) {
    if (state.inFlight >= MAX_CONCURRENT) return false;
    if (lane === 'conversation') return true;
    return state.inFlight < (MAX_CONCURRENT - CONVERSATION_RESERVED);
}

function grant(lane) {
    state.inFlight += 1;
    state.inFlightByLane[lane] = laneCount(lane) + 1;
    state.admitted += 1;
    if (state.inFlight > state.peakInFlight) state.peakInFlight = state.inFlight;
}

/**
 * Acquire a concurrency slot.
 *
 * Resolves with a release function. Rejects with a `__code` of
 * 'runtime_saturated' if no slot becomes free inside the wait budget, so the
 * caller can surface a typed, retryable error rather than hanging.
 */
function acquire(lane = 'interactive', waitMs = MAX_WAIT_MS) {
    if (hasCapacity(lane)) {
        grant(lane);
        return Promise.resolve(() => release(lane));
    }

    const budget = Math.max(0, Math.min(waitMs, MAX_WAIT_MS));
    if (budget === 0) return Promise.reject(saturated(lane));

    return new Promise((resolve, reject) => {
        const entry = { lane, enqueuedAt: Date.now() };
        entry.resolve = resolve;
        entry.reject = reject;
        entry.timer = setTimeout(() => {
            const i = state.waiting.indexOf(entry);
            if (i >= 0) state.waiting.splice(i, 1);
            state.rejected += 1;
            reject(saturated(lane));
        }, budget);
        state.waiting.push(entry);
        if (state.waiting.length > state.peakWaiting) state.peakWaiting = state.waiting.length;
    });
}

function release(lane) {
    state.inFlight = Math.max(0, state.inFlight - 1);
    state.inFlightByLane[lane] = Math.max(0, laneCount(lane) - 1);
    pump();
}

/**
 * Hand the freed slot to the longest-waiting caller that may have it.
 *
 * Conversation waiters are considered first: they are the ones with a person
 * watching a cursor blink, and they are the lane the reserve exists for.
 */
function pump() {
    for (let pass = 0; pass < 2; pass++) {
        const wantConversation = pass === 0;
        for (let i = 0; i < state.waiting.length; i++) {
            const e = state.waiting[i];
            if (wantConversation !== (e.lane === 'conversation')) continue;
            if (!hasCapacity(e.lane)) continue;
            state.waiting.splice(i, 1);
            clearTimeout(e.timer);
            grant(e.lane);
            e.resolve(() => release(e.lane));
            return pump();
        }
    }
}

function saturated(lane) {
    const e = new Error(
        `Runtime is at its concurrency limit (${MAX_CONCURRENT} in flight) and no slot became free for the ${lane} lane.`);
    e.__code = 'runtime_saturated';
    e.__lane = lane;
    return e;
}

/** Telemetry for /health and the metrics snapshot. */
function snapshot() {
    return {
        max_concurrent: MAX_CONCURRENT,
        conversation_reserved: CONVERSATION_RESERVED,
        max_sockets: MAX_SOCKETS,
        in_flight: state.inFlight,
        in_flight_by_lane: { ...state.inFlightByLane },
        waiting: state.waiting.length,
        peak_in_flight: state.peakInFlight,
        peak_waiting: state.peakWaiting,
        admitted: state.admitted,
        rejected_saturated: state.rejected,
    };
}

/** Test-only. Never called in production paths. */
function __reset() {
    state.waiting.forEach((e) => clearTimeout(e.timer));
    state.inFlight = 0;
    state.inFlightByLane = Object.create(null);
    state.waiting = [];
    state.admitted = 0;
    state.rejected = 0;
    state.peakInFlight = 0;
    state.peakWaiting = 0;
}

module.exports = {
    httpAgent,
    httpsAgent,
    acquire,
    snapshot,
    __reset,
    MAX_CONCURRENT,
    CONVERSATION_RESERVED,
    MAX_SOCKETS,
};
