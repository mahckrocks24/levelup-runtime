'use strict';

/**
 * LevelUp — Sarah Synthesis Routes
 *
 * Three endpoints that own the SYNTHESIS LAYER for Sarah (Digital
 * Marketing Manager). Until now, the prompts + system messages lived
 * in Laravel and the runtime was just an LLM passthrough — that
 * violated the hands-vs-brain rule (intelligence in runtime). These
 * routes pull the synthesis logic INTO the runtime.
 *
 *   POST /internal/sarah/synthesize-daily   — composite morning brief
 *   POST /internal/sarah/synthesize-weekly  — past-week retrospective + pivots
 *   POST /internal/sarah/synthesize-monthly — 30-day strategic plan
 *
 * Laravel-side contract (unchanged from the orchestrators' existing
 * tryDedicatedEndpoint() shape):
 *
 *   Request:   { workspace_id: int, state: <gathered state object> }
 *              + header X-LevelUp-Secret matching LU_SECRET
 *
 *   Response:  { brief_markdown: string, proposed_actions: array }
 *              for daily + weekly; monthly returns 30_day_plan_markdown
 *              + proposed_actions.
 *
 * Mount in index.js via: require('./lu-sarah-synthesis-routes').mountRoutes(app, requireSecret);
 */

// v2.37.6 — provider execution is delegated to the single routing engine.
// This route previously called llm.js callLLM(), which had NO recovery path:
// when DeepSeek V4 answered HTTP 200 with empty content (reasoning consumed the
// budget) callLLM rethrew it as "LLM network error", this handler mapped it to
// 502 llm_error, and Sarah's dedicated synthesis failed while /ai/run succeeded
// on the same workload purely because /ai/run had an inline fallback.
//
// The fallback was NOT copied here. It moved into lu-execution-router.js, which
// both endpoints now consume. This file owns prompt construction and its own
// response contract — nothing about providers.
const router = require('./lu-execution-router');
const runtimeErrors = require('./lu-runtime-errors');

// ── Common helpers ─────────────────────────────────────────────────────

/**
 * Strip empty sections from state before sending to LLM — saves tokens.
 */
function compactState(state) {
    if (!state || typeof state !== 'object') return {};
    const out = {};
    for (const [k, v] of Object.entries(state)) {
        if (v === null || v === undefined) continue;
        if (Array.isArray(v) && v.length === 0) continue;
        if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) continue;
        out[k] = v;
    }
    return out;
}

/**
 * Parse LLM JSON output. Handles three patterns the model emits:
 *   1. Clean JSON
 *   2. Markdown-fenced JSON (```json ... ```)
 *   3. Prose-wrapped JSON ("Here you go: {...} hope that helps")
 * Also strips smart quotes + trailing commas (LLM quirks).
 */
function parseLlmJson(text) {
    if (!text || typeof text !== 'string') return null;
    let t = text.trim();
    // Strip markdown fences
    t = t.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    // Normalize smart quotes
    t = t.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
    // Strip trailing commas before } or ]
    t = t.replace(/,(\s*[}\]])/g, '$1');

    try {
        const parsed = JSON.parse(t);
        if (parsed && typeof parsed === 'object') return parsed;
    } catch (_e) {}

    // Last-resort: pull the first { ... } block
    const m = t.match(/\{[\s\S]*\}/);
    if (m) {
        try {
            const parsed = JSON.parse(m[0]);
            if (parsed && typeof parsed === 'object') return parsed;
        } catch (_e) {}
    }
    return null;
}

// ── Prompts (intelligence layer — lives HERE, not in Laravel) ──────────

const SARAH_SYSTEM_DMM = 'You are Sarah, the Digital Marketing Manager for a small-business workspace. You are decisive, plain-spoken, and tie every recommendation to a real signal in the data. You operate under a STANDING APPROVAL from the owner: you AUTO-RUN routine content and SEO work (drafting articles, audits, internal link and meta work, video drafts, strategy prep) without asking each time, and you speak about that work in the future tense as your plan for today. You ONLY ask for explicit approval on external or irreversible actions — publishing, sending email, and posting to social. You never invent metrics, never name competitor brands, never reference years prior to the current year, never claim work is already finished when it has not run yet, and never describe a low credit burn as good news when the goals are behind.';

function buildDailyPrompt(state) {
    const currentYear = new Date().getFullYear();
    const compact = compactState(state);
    const stateJson = JSON.stringify(compact);

    return [
        'You have the FULL state across every engine (SEO, content, social, email, CRM, chatbot, AEO, traffic, builder, competitor, pipeline, tier, goals).',
        '',
        'Your team has pre-computed a checklist of deterministic candidate actions (_rule_candidates in the state). Each candidate is a real, data-driven opportunity (orphan pages found, opportunity-zone keyword, stale article, goal at risk, burn-rate warning, etc.). PREFER picking 3-5 of these over inventing new ones — they are grounded in real workspace state.',
        '',
        'Compose a SHORT morning brief (markdown) for the workspace owner AND a list of 3-8 proposed actions for today that respect the tier cadence.',
        '',
        'ACTION CLASSES — this determines how you frame each action:',
        '  - ROUTINE (auto-run under the owner standing approval; write these in the FUTURE tense as your plan, e.g. "I\'ll draft…", "Today I\'m running…"): write_article, deep_audit, link_suggestions, insert_link, generate_meta, generate_video, strategy_meeting.',
        '  - EXTERNAL / IRREVERSIBLE (require the owner to approve before they happen; write these as "Approve to…"): publishing an article or a Website Builder page live, and anything else that changes the public site.',
        '  - OUT OF SCOPE (NEVER propose these — the product does not include them): social posts, social scheduling, social engagement or analytics, email campaigns, newsletters, email sequences or drips. Never list them as actions, never as "Approve to…", never as future plans.',
        '  - DECISION: goal_pivot is a strategic call for the owner — present it as a recommendation the owner decides on, not as auto-run and not as "approve to send".',
        '',
        'Brief structure (markdown):',
        '  - Greeting + day-of-month + budget status (use tier_state.consumed_pct + burn_rate_status if present)',
        '  - YESTERDAY: cross-engine wins (3-5 bullets, only real signals from the state)',
        '  - GOALS: status of each active goal (progress vs target, with rank/leads/etc numbers from state.goals[].current)',
        "  - RUNNING TODAY: label this section exactly 'RUNNING TODAY'. The ROUTINE content/SEO work you will execute today under the owner standing approval. Future tense. Each item with credit cost + the real signal that justifies it.",
        "  - NEEDS YOUR OK: label this section exactly 'NEEDS YOUR OK'. ONLY the EXTERNAL/IRREVERSIBLE actions (publishing an article or page live) plus any goal_pivot DECISION. Phrase each as 'Approve to…'. If there are none today, write 'Nothing needs your sign-off today.'",
        '',
        'Rules:',
        '  - Reference REAL signals from the state JSON only. Never invent metrics.',
        "  - FRAMING BY CLASS: ROUTINE actions are stated as YOUR PLAN in the future tense — you are running them today, the owner does not need to click approve. EXTERNAL/IRREVERSIBLE actions and goal_pivot DECISIONS are the ONLY things phrased as 'Approve to…'. Do not put routine work behind an approval gate.",
        "  - HONESTY: NEVER claim any action is already finished, published, sent, or done when it has not run yet. Routine work is framed as happening TODAY (future/in-progress), not as already complete. It is fine to say \"I'll take care of the routine content today\" for ROUTINE items; never say that about EXTERNAL items.",
        "  - CREDIT HONESTY: never present a low credit burn or 'plenty of budget left' as good news when any goal is at_risk, off_track, or behind target. If goals are behind, low spend means under-investment — say so plainly and lean into the routine work that moves those goals.",
        '  - PRIORITIZE _rule_candidates (they are real, deterministic opportunities).',
        '  - Only add a new action if it is clearly higher value than every candidate.',
        '  - Respect tier cadence (do not schedule more than fits the tier).',
        '  - When tier_state.burn_rate_status is warning_80, critical_90, or over, INCLUDE a budget-aware framing in the brief and DO NOT plan actions that would exceed the remaining balance.',
        '  - When a goal is at_risk or off_track, INCLUDE a goal_pivot DECISION in NEEDS YOUR OK.',
        '  - When a goal is achieved, CELEBRATE in the brief and propose setting a follow-on goal.',
        '  - Never name competitor brands.',
        '  - Current year is ' + currentYear + '. Never reference a year prior to ' + currentYear + '.',
        '',
        'For each proposed action, set "requires_approval" to true ONLY for EXTERNAL/IRREVERSIBLE actions (publishing an article or page live) and for goal_pivot; set it to false for ROUTINE auto-run work.',
        'Return ONLY this JSON (no preamble, no code fences, no commentary):',
        '{"brief_markdown":"...","proposed_actions":[{"action":"write_article","title":"...","reason":"...","credit_cost":3,"priority":"high","rule":"opportunity_zone","agent":"sarah","requires_approval":false}]}',
        '',
        'WORKSPACE STATE:',
        stateJson,
    ].join('\n');
}

function buildWeeklyPrompt(state) {
    const currentYear = new Date().getFullYear();
    const compact = compactState(state);
    const stateJson = JSON.stringify(compact);

    return [
        'You are composing the WEEKLY retrospective for this workspace. The state includes both current snapshots AND a 7-day outcomes section (state.outcomes_7d) — completed tasks, credit usage, leads generated, rank movements, article performance.',
        '',
        'Brief structure (markdown):',
        '  - Greeting + week range',
        '  - WHAT WORKED: 3-5 concrete wins from outcomes_7d (use real numbers)',
        '  - WHAT STALLED: 1-3 items that did not pan out (state honestly, no spin)',
        '  - PIVOTS: 2-4 strategic shifts for the coming week (these become proposed_actions of type goal_pivot, strategy_meeting, or budget adjustment)',
        '  - NEXT WEEK FOCUS: 1-line directional summary',
        '',
        'Rules:',
        '  - Numbers come from the state. No invented metrics.',
        '  - Routine content/SEO work runs automatically under the owner standing approval — frame it as work that happened / will continue, not as something awaiting a click. Only publish/email/social and goal_pivot decisions need the owner\'s sign-off.',
        '  - NEVER claim a task is done, published, or sent when the state does not show it completed. Report only what outcomes_7d actually contains.',
        '  - CREDIT HONESTY: do not frame a low weekly burn as a win when goals are at_risk or off_track — low spend against behind goals is under-investment; call it out.',
        '  - If burn_rate_status is warning_80/critical_90/over, weave budget discipline into pivots.',
        '  - Goals at_risk get explicit pivot proposals.',
        '  - Current year is ' + currentYear + '.',
        '',
        'For each proposed action, set "requires_approval" true for goal_pivot decisions and any publish/email/social action, false for routine auto-run work.',
        'Return ONLY this JSON:',
        '{"brief_markdown":"...","proposed_actions":[{"action":"goal_pivot","title":"...","reason":"...","credit_cost":3,"priority":"high","rule":"weekly_pivot","requires_approval":true}]}',
        '',
        'WORKSPACE STATE (with outcomes_7d):',
        stateJson,
    ].join('\n');
}

function buildMonthlyPrompt(state) {
    const currentYear = new Date().getFullYear();
    const compact = compactState(state);
    const stateJson = JSON.stringify(compact);

    return [
        'You are composing the MONTHLY 30-day strategic plan for this workspace. The state has the full picture: 30-day outcomes, goal status, tier consumption, competitor signals, AEO findings, pipeline health.',
        '',
        'Plan structure (markdown for the 30_day_plan_markdown field):',
        '  - Executive summary (3-5 lines)',
        '  - GOALS REVIEW: status + decision for each active goal (continue / pivot / retire)',
        '  - 4-WEEK ROADMAP: week-by-week themes with credit budget per week',
        '  - KEY BETS: 2-4 specific initiatives with rationale (these become proposed_actions)',
        '  - RISKS + MITIGATIONS: 1-3 watch items',
        '',
        'Rules:',
        '  - Reference REAL signals from the state JSON only.',
        '  - Total weekly credit budgets must add up to <= tier_state.plan_credit_limit.',
        '  - Routine content/SEO execution runs automatically under the owner standing approval; only publish/email/social and strategic decisions need sign-off. Frame the roadmap as work Sarah will run, not a backlog of approvals.',
        '  - NEVER describe a plan item as already done. The roadmap is forward-looking; report only real completed outcomes from the state.',
        '  - CREDIT HONESTY: unspent budget is only good news when goals are on track. If goals are behind, flag under-investment and reallocate toward the work that moves them.',
        '  - Goals achieved get retired with a follow-on goal proposal.',
        '  - No competitor brand names.',
        '  - Current year is ' + currentYear + '.',
        '',
        'For each proposed action, set "requires_approval" true for strategic decisions and any publish/email/social action, false for routine auto-run work.',
        'Return ONLY this JSON:',
        '{"30_day_plan_markdown":"...","proposed_actions":[{"action":"strategy_meeting","title":"...","reason":"...","credit_cost":8,"priority":"high","rule":"monthly_keystone","requires_approval":false}]}',
        '',
        'WORKSPACE STATE (with outcomes_30d):',
        stateJson,
    ].join('\n');
}

// ── Route handler factory ──────────────────────────────────────────────

function makeHandler({ kind, buildPrompt, expectedFields, maxTokens }) {
    return async (req, res) => {
        const t0 = Date.now();
        const wsId = req.body && req.body.workspace_id;
        const state = req.body && req.body.state;

        if (!wsId || typeof wsId !== 'number') {
            return res.status(400).json({ error: 'workspace_id required (integer)' });
        }
        if (!state || typeof state !== 'object') {
            return res.status(400).json({ error: 'state required (object)' });
        }

        const prompt = buildPrompt(state);

        // Delegate execution. This handler does not know which providers exist,
        // in what order they are tried, or when a fallback is permitted.
        const result = await router.execute({
            messages: [
                { role: 'system', content: SARAH_SYSTEM_DMM },
                { role: 'user',   content: prompt },
            ],
            capability:          'long_synthesis',
            max_tokens:          maxTokens,
            temperature:         0.6,
            signal:              req.abortSignal,
            request_id:          req.requestId || req.id || null,
            deadline_ms:         req.timeoutBudgetMs || null,
            provider_timeout_ms: req.timeoutBudgetMs
                ? Math.max(5_000, req.timeoutBudgetMs - 15_000)
                : 55_000,
        });

        const meta = router.metadata(result);

        if (!result.ok) {
            console.error(`[sarah-synth/${kind}] ${result.error_code}: ${String(result.error_message).slice(0, 200)}`);
            // Typed envelope. `error` and `detail` are retained verbatim so the
            // existing Laravel readers keep working; `message` is added because
            // Laravel's telemetry looks for it. Additive — nothing removed.
            const body = runtimeErrors.buildError(result.error_code, {
                request_id: result.request_id,
                elapsed_ms: result.elapsed_ms,
                provider:   result.provider,
                message:    result.error_message,
                // v2.37.7 — one canonical stage. The router knows exactly where
                // it stopped; without this the body fell back to the taxonomy's
                // generic default and reported `unknown` while meta reported
                // `primary_provider_call` for the same failure.
                stage:      result.stage,
                detail:     { kind, workspace_id: wsId, ...meta },
            });
            body.detail_message = result.error_message;   // legacy `detail` string
            body.detail         = result.error_message;   // backward compatible shape
            body.meta           = meta;
            return res.status(runtimeErrors.ERRORS[result.error_code]?.http || 502).json(body);
        }

        const text = result.content || '';
        const parsed = parseLlmJson(text);
        if (!parsed) {
            console.warn(`[sarah-synth/${kind}] parse failed for ws=${wsId}, text_preview=${text.slice(0, 240)}`);
            return res.status(502).json({
                success: false, error: 'parse_failed', detail: 'Model output was not valid JSON.',
                message: 'Model output was not valid JSON.',
                preview: text.slice(0, 240), meta,
                contract_version: runtimeErrors.CONTRACT_VERSION,
            });
        }

        for (const f of expectedFields) {
            if (parsed[f] === undefined || parsed[f] === null) {
                return res.status(502).json({
                    success: false, error: `missing_field:${f}`,
                    detail: `Model output omitted required field "${f}".`,
                    message: `Model output omitted required field "${f}".`,
                    parsed, meta, contract_version: runtimeErrors.CONTRACT_VERSION,
                });
            }
        }

        // Success contract unchanged for Laravel (brief_markdown + proposed_actions),
        // with routing metadata added alongside it.
        const payload = {
            ...parsed,
            workspace_id: wsId,
            elapsed_ms: Date.now() - t0,
            contract_version: runtimeErrors.CONTRACT_VERSION,
            ...meta,
        };
        return res.json(payload);
    };
}

// ── Mount ──────────────────────────────────────────────────────────────

function mountRoutes(app, requireSecret) {
    app.post('/internal/sarah/synthesize-daily', requireSecret, makeHandler({
        kind: 'daily',
        buildPrompt: buildDailyPrompt,
        expectedFields: ['brief_markdown', 'proposed_actions'],
        maxTokens: 3000,
    }));

    app.post('/internal/sarah/synthesize-weekly', requireSecret, makeHandler({
        kind: 'weekly',
        buildPrompt: buildWeeklyPrompt,
        expectedFields: ['brief_markdown', 'proposed_actions'],
        maxTokens: 3000,
    }));

    app.post('/internal/sarah/synthesize-monthly', requireSecret, makeHandler({
        kind: 'monthly',
        buildPrompt: buildMonthlyPrompt,
        expectedFields: ['30_day_plan_markdown', 'proposed_actions'],
        maxTokens: 4000,
    }));

    console.log('[sarah-synthesis] mounted: /internal/sarah/synthesize-{daily,weekly,monthly}');
}

module.exports = { mountRoutes };
