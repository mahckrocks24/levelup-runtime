'use strict';

/**
 * LevelUp — Parameter Intelligence Layer
 *
 * Sits between intent/tool selection and executeTool().
 * Before any tool runs:
 *   1. Load required fields from tool registry
 *   2. Check which are present in the agent-assembled params
 *   3. For missing fields, attempt deterministic extraction from user message
 *   4. For still-missing fields, generate a focused clarification question
 *
 * Returns: { resolved_params, missing, extracted, clarification_needed, clarification_question, log }
 *
 * NEVER executes a tool. Only resolves params.
 * Caller is responsible for acting on clarification_needed.
 */

const { getTool } = require('./tool-registry');

// ── Extraction patterns ────────────────────────────────────────────────────
// Deterministic regex-based extractors for common field types.
// Each entry: { field, patterns[], extractor(match) → value, safe }
// safe=false means we won't auto-fill without user confirmation.

const EXTRACTORS = [

    // ── business_name / company_name ────────────────────────────────────
    {
        fields:   ['business_name', 'company_name', 'brand_name'],
        patterns: [
            /(?:my|our)\s+(?:business|company|brand|agency|firm|startup|studio)\s+(?:is|called|named)\s+["']?([A-Za-z0-9 &'.,-]+?)["']?(?:\s|$|,|\.)/i,
            /(?:for|build|create|make)\s+(?:a\s+)?(?:website|site|page|landing page|campaign)\s+for\s+["']?([A-Za-z0-9 &'.,-]+?)["']?(?:\s+in\s|\s+at\s|$|,|\.)/i,
            /(?:company|business|brand)\s*:\s*["']?([A-Za-z0-9 &'.,-]+?)["']?(?:\s|$|,|\.)/i,
            /(?:called|named)\s+["']?([A-Za-z0-9 &'.,-]+?)["']?(?:\s|$|,|\.)/i,
        ],
        extractor: (m) => m[1].trim(),
        safe:      true,
    },

    // ── name (lead/contact name) ────────────────────────────────────────
    {
        fields:   ['name'],
        patterns: [
            /(?:lead|contact|person|client|prospect)\s+(?:is|named|called)\s+([A-Za-z][A-Za-z '-]+)/i,
            /(?:add|create|new lead?)\s+(?:for\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/,
        ],
        extractor: (m) => m[1].trim(),
        safe:      true,
    },

    // ── email ────────────────────────────────────────────────────────────
    {
        fields:   ['email'],
        patterns: [
            /\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/,
        ],
        extractor: (m) => m[1].trim(),
        safe:      true,
    },

    // ── keyword (SEO) ────────────────────────────────────────────────────
    {
        fields:   ['keyword'],
        patterns: [
            /(?:keyword|keywords?|for|target|about|rank\s+for)\s+["']?([a-zA-Z0-9 \-]+?)["']?(?:\s+(?:in|at|on)\s|$|,|\.)/i,
            /(?:analyse|analyze|research|check|look\s+up)\s+["']?([a-zA-Z0-9 \-]{3,50})["']?/i,
        ],
        extractor: (m) => m[1].trim(),
        safe:      true,
    },

    // ── platform (social) ────────────────────────────────────────────────
    {
        fields:   ['platform'],
        patterns: [
            /\b(linkedin|facebook|instagram|twitter|x\.com|tiktok|youtube|google[_ ]?business|google business)\b/i,
        ],
        extractor: (m) => {
            const raw = m[1].toLowerCase().replace(/[\s_]/g, '_');
            const map = { 'x.com': 'x', 'google_business': 'google_business', 'googlebusiness': 'google_business' };
            return map[raw] || raw;
        },
        safe: true,
    },

    // ── content / post content ───────────────────────────────────────────
    {
        fields:   ['content'],
        patterns: [
            /(?:post|caption|message|content)(?:\s+saying|:)\s*["'](.+?)["']/i,
        ],
        extractor: (m) => m[1].trim(),
        safe:      true,
    },

    // ── title / event title ──────────────────────────────────────────────
    {
        fields:   ['title'],
        patterns: [
            /(?:title(?:d)?|called|named|event)\s*[:\s]+["']?([A-Za-z0-9 &'\-:]+?)["']?(?:\s|$|,|\.)/i,
        ],
        extractor: (m) => m[1].trim(),
        safe:      true,
    },

    // ── scheduled_at / date+time ─────────────────────────────────────────
    {
        fields:   ['scheduled_at', 'start_time', 'start', 'date'],
        patterns: [
            /\b(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}(?::\d{2})?)?)\b/,
            /(?:at|on|for)\s+(tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i,
        ],
        extractor: (m) => {
            // ISO datetime → use directly
            if (/\d{4}-\d{2}-\d{2}/.test(m[0])) return m[1];
            // Relative day → build rough datetime for context
            const day  = m[1].toLowerCase();
            const time = m[2];
            const now  = new Date();
            const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
            const idx  = days.indexOf(day);
            if (idx !== -1) {
                const diff = (idx - now.getDay() + 7) % 7 || 7;
                const d    = new Date(now);
                d.setDate(d.getDate() + (day === 'today' ? 0 : day === 'tomorrow' ? 1 : diff));
                return `${d.toISOString().slice(0, 10)} ${time}`;
            }
            if (day === 'today')    return `${now.toISOString().slice(0, 10)} ${time}`;
            if (day === 'tomorrow') { const t = new Date(now); t.setDate(t.getDate() + 1); return `${t.toISOString().slice(0, 10)} ${time}`; }
            return m[0];
        },
        safe: true,
    },

    // ── campaign name ────────────────────────────────────────────────────
    {
        fields:   ['name'],   // campaign context
        patterns: [
            /(?:campaign|email campaign|newsletter)\s+(?:called|named|for)\s+["']?([A-Za-z0-9 &'\-:]+?)["']?(?:\s|$|,|\.)/i,
        ],
        extractor: (m) => m[1].trim(),
        safe:      true,
    },

    // ── prompt (builder layout) ──────────────────────────────────────────
    {
        fields:   ['prompt'],
        patterns: [
            /(?:generate|create|build|make)\s+(?:a\s+)?(?:page|landing page|website|layout)\s+(?:for|about)\s+(.+?)(?:\s+in\s+|\s+at\s+|$|\.)/i,
        ],
        extractor: (m) => m[1].trim(),
        safe:      true,
    },

    // ── goal (autonomous_goal) ───────────────────────────────────────────
    {
        fields:   ['goal'],
        patterns: [
            /(?:goal|objective|aim|target)\s*[:\s]+(.+?)(?:\s*$|\.|,)/i,
            /(?:i want to|we should|help me)\s+(.+?)(?:\s*$|\.|,)/i,
        ],
        extractor: (m) => m[1].trim(),
        safe:      true,
    },
];

// ── Clarification templates per field ─────────────────────────────────────
const CLARIFICATION_TEMPLATES = {
    business_name:  'What is the business name I should use?',
    company_name:   'What is the company name?',
    name:           'What name should I use for this contact/lead?',
    email:          'What email address should I use?',
    keyword:        'What keyword should I target for this?',
    platform:       'Which platform should this be published to? (e.g. linkedin, facebook, instagram)',
    content:        'What content should the post say?',
    title:          'What title should I use?',
    scheduled_at:   'What date and time should I schedule this for? (e.g. 2026-03-25 09:00:00)',
    start_time:     'What start time should I use? (YYYY-MM-DD HH:MM:SS)',
    end_time:       'What end time should I use? (YYYY-MM-DD HH:MM:SS)',
    prompt:         'Can you describe what the page should look like or be about?',
    goal:           'What goal should I set for the agent?',
    post_id:        'Which post or page ID should I use? (run list_builder_pages or get_site_pages first)',
    id:             'Which item ID should I use? (run the relevant list tool first to get the ID)',
    lead_id:        'Which lead should I use? (run list_leads to get the ID)',
    stage_id:       'Which pipeline stage? (run list_leads to see available stages)',
};

function getClarificationQuestion(fieldName, toolName) {
    if (CLARIFICATION_TEMPLATES[fieldName]) return CLARIFICATION_TEMPLATES[fieldName];
    // Generic fallback — still specific about the field
    return `What value should I use for "${fieldName}" when running ${toolName}?`;
}

// ── ID fields — require prior tool call, cannot be extracted from text ─────
const ID_FIELDS = new Set(['id', 'post_id', 'page_id', 'lead_id', 'campaign_id',
    'sequence_id', 'stage_id', 'goal_id', 'task_id', 'action_id',
    'serp_run_id', 'ai_report_id']);

// ── Main resolver ──────────────────────────────────────────────────────────

/**
 * Resolve parameters for a tool call.
 *
 * @param {string} toolId        — tool being called
 * @param {object} agentParams   — params assembled by LLM
 * @param {string} userMessage   — raw latest user message (for extraction)
 * @param {object} [context]     — optional: workspace context, prior tool outputs
 * @returns {{
 *   resolved_params: object,
 *   missing: string[],
 *   extracted: object,
 *   clarification_needed: boolean,
 *   clarification_question: string|null,
 *   ready: boolean,
 *   log: string[]
 * }}
 */
function resolveToolParams(toolId, agentParams = {}, userMessage = '', context = {}) {
    const tool = getTool(toolId);
    const log  = [];

    if (!tool) {
        return {
            resolved_params:        agentParams,
            missing:                [],
            extracted:              {},
            clarification_needed:   false,
            clarification_question: null,
            ready:                  true,
            log:                    [`[param-resolver] Unknown tool: ${toolId} — skipping validation`],
        };
    }

    // Start with agent-assembled params, then overlay any context defaults
    const resolved = { ...agentParams };
    const extracted = {};

    // Inject workspace context fields if relevant
    if (context.workspace) {
        const ws = context.workspace;
        if (ws.businessName && !resolved.business_name) {
            resolved.business_name = ws.businessName;
            extracted.business_name = ws.businessName;
            log.push(`[param-resolver] Injected business_name from workspace: "${ws.businessName}"`);
        }
    }

    // Carry forward outputs from prior tool calls in the workflow
    if (context.priorOutputs && typeof context.priorOutputs === 'object') {
        for (const [k, v] of Object.entries(context.priorOutputs)) {
            if (!resolved[k] && v !== undefined && v !== null) {
                resolved[k] = v;
                extracted[k] = v;
                log.push(`[param-resolver] Carried forward from prior step: ${k}=${JSON.stringify(v).slice(0, 60)}`);
            }
        }
    }

    // Find required fields
    const requiredFields = Object.entries(tool.params || {})
        .filter(([, v]) => v.required)
        .map(([k]) => k);

    log.push(`[param-resolver] Tool: ${toolId} | Required: [${requiredFields.join(', ')}]`);

    // Check which required fields are already present
    const still_missing = requiredFields.filter(f =>
        resolved[f] === undefined || resolved[f] === null || resolved[f] === ''
    );

    if (still_missing.length === 0) {
        log.push(`[param-resolver] All required params present — ready to execute`);
        return {
            resolved_params:        resolved,
            missing:                [],
            extracted,
            clarification_needed:   false,
            clarification_question: null,
            ready:                  true,
            log,
        };
    }

    log.push(`[param-resolver] Missing required fields: [${still_missing.join(', ')}]`);

    // Attempt extraction from user message
    const extractable = [];
    const unextractable = [];

    for (const field of still_missing) {
        // ID fields can't be reliably extracted from text — need prior tool call
        if (ID_FIELDS.has(field)) {
            unextractable.push(field);
            log.push(`[param-resolver] Field "${field}" is an ID — cannot extract from text, needs prior list call`);
            continue;
        }

        let found = false;
        for (const extractor of EXTRACTORS) {
            if (!extractor.fields.includes(field)) continue;
            for (const pattern of extractor.patterns) {
                const m = userMessage.match(pattern);
                if (m) {
                    try {
                        const value = extractor.extractor(m);
                        if (value) {
                            resolved[field]  = value;
                            extracted[field] = value;
                            log.push(`[param-resolver] Extracted "${field}" = "${String(value).slice(0, 60)}" from user message`);
                            found = true;
                            break;
                        }
                    } catch (_) {}
                }
            }
            if (found) break;
        }
        if (!found) {
            unextractable.push(field);
            log.push(`[param-resolver] Could not extract "${field}" from message`);
        }
    }

    // Re-check after extraction
    const still_needed = requiredFields.filter(f =>
        resolved[f] === undefined || resolved[f] === null || resolved[f] === ''
    );

    if (still_needed.length === 0) {
        log.push(`[param-resolver] All required params resolved via extraction — ready to execute`);
        return {
            resolved_params:        resolved,
            missing:                [],
            extracted,
            clarification_needed:   false,
            clarification_question: null,
            ready:                  true,
            log,
        };
    }

    // Still missing — pick the most important one and ask
    // Priority: non-ID fields first, then ID fields
    const primaryMissing = still_needed.find(f => !ID_FIELDS.has(f)) || still_needed[0];
    const question = getClarificationQuestion(primaryMissing, tool.name);

    log.push(`[param-resolver] Clarification needed for "${primaryMissing}" — question: "${question}"`);

    return {
        resolved_params:        resolved,
        missing:                still_needed,
        extracted,
        clarification_needed:   true,
        clarification_question: question,
        ready:                  false,
        log,
    };
}

/**
 * Classify a tool execution error to guide retry/recovery behavior.
 *
 * Returns one of:
 *   'missing_params'     — required field absent → extract/ask
 *   'validation'         — format issue → retry with fix
 *   'permission'         — agent not allowed → no retry
 *   'not_found'          — resource ID doesn't exist → ask for correct ID
 *   'system'             — downstream failure → retry once
 *   'unknown'            — unclassified
 */
// Error class constants — aligned to prompt spec
const ERROR_CLASS = {
    MISSING_PARAM:    'MISSING_PARAM',
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    API_ERROR:        'API_ERROR',
    TIMEOUT:          'TIMEOUT',
    PERMISSION:       'PERMISSION',
    NOT_FOUND:        'NOT_FOUND',
    UNKNOWN:          'UNKNOWN',
};

function classifyToolError(errorMessage = '') {
    const msg = errorMessage.toLowerCase();
    if (/missing required|required param|is required|required field/i.test(msg)) return ERROR_CLASS.MISSING_PARAM;
    if (/not found|does not exist|no record|404/i.test(msg))                     return ERROR_CLASS.NOT_FOUND;
    if (/permission|not permitted|not allowed|capability|unauthorized|403/i.test(msg)) return ERROR_CLASS.PERMISSION;
    if (/invalid|format|type|must be|expected/i.test(msg))                       return ERROR_CLASS.VALIDATION_ERROR;
    if (/timeout/i.test(msg))                                                    return ERROR_CLASS.TIMEOUT;
    if (/connect|network|503|502|500|service unavailable/i.test(msg))            return ERROR_CLASS.API_ERROR;
    return ERROR_CLASS.UNKNOWN;
}

/**
 * Build a focused retry/clarification message for a failed tool call.
 * Used when a tool returns status='error' and we want to give the agent
 * a clear signal on how to recover.
 *
 * @param {string} toolId
 * @param {string} errorMessage
 * @param {string} userMessage
 * @param {object} lastParams
 * @returns {{ action: 'retry'|'ask'|'abort', message: string, suggested_params?: object }}
 */
function buildRetryStrategy(toolId, errorMessage, userMessage, lastParams) {
    const errorClass = classifyToolError(errorMessage);
    const tool       = getTool(toolId);

    if (errorClass === ERROR_CLASS.MISSING_PARAM) {
        // Try extraction first
        const resolution = resolveToolParams(toolId, lastParams, userMessage);
        if (resolution.ready) {
            return {
                action:          'retry',
                message:         `Retrying ${tool?.name || toolId} with extracted parameters.`,
                suggested_params: resolution.resolved_params,
                log:             resolution.log,
            };
        }
        return {
            action:  'ask',
            message: resolution.clarification_question || `What value should I use to complete this action?`,
            log:     resolution.log,
        };
    }

    if (errorClass === ERROR_CLASS.NOT_FOUND) {
        return {
            action:  'ask',
            message: `The item I was trying to access doesn't exist or the ID is incorrect. Can you confirm which one you meant?`,
            log:     [`[retry] not_found — ID may be wrong or stale`],
        };
    }

    if (errorClass === ERROR_CLASS.VALIDATION_ERROR) {
        return {
            action:  'ask',
            message: `There was a format issue with the request: "${errorMessage}". Can you clarify the correct value?`,
            log:     [`[retry] validation error — ${errorMessage}`],
        };
    }

    if (errorClass === ERROR_CLASS.PERMISSION) {
        return {
            action:  'abort',
            message: `I don't have permission to run this action. A different agent or manual action may be needed.`,
            log:     [`[retry] permission denied — no retry`],
        };
    }

    if (errorClass === ERROR_CLASS.TIMEOUT || errorClass === ERROR_CLASS.API_ERROR) {
        return {
            action:  'retry',
            message: `The service returned a temporary error. Retrying once.`,
            log:     [`[retry] ${errorClass} — will retry once`],
        };
    }

    return {
        action:  'abort',
        message: `The action failed: ${errorMessage}`,
        log:     [`[retry] ${errorClass} — aborting`],
    };
}

module.exports = { resolveToolParams, classifyToolError, buildRetryStrategy, ERROR_CLASS };
