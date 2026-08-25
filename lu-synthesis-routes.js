'use strict';

/**
 * LevelUp — Synthesis Route
 *
 * POST /internal/synthesize
 *
 * Called by lu-task-worker.js when SYNTHESIS_ENDPOINT is set.
 * Receives tool results + workspace context and produces an
 * agent-voiced, human-readable summary using DeepSeek.
 *
 * Request body (sent by lu-task-worker.js synthesize()):
 * {
 *   task_id:        string,
 *   agent_id:       string,    // e.g. "james", "priya"
 *   task_title:     string,
 *   tool_results:   Array<{ tool_id, status, data, error, duration_ms }>,
 *   context_prompt: string,    // pre-built by buildContextPrompt()
 *   collab_summary: string | null,
 * }
 *
 * Response:
 * {
 *   output: string,            // agent-voiced synthesis
 *   task_id: string,
 *   tokens_used: number,
 * }
 *
 * Authentication: X-LU-Secret header === process.env.LU_SECRET
 */

const express = require('express');
const router  = express.Router();
const { callLLM } = require('./llm');

// ── Auth middleware (same secret as all other internal routes) ────────────
router.use((req, res, next) => {
    const secret = process.env.LU_SECRET;
    if (!secret) return res.status(500).json({ error: 'LU_SECRET not configured on runtime.' });
    if (req.headers['x-lu-secret'] !== secret) {
        return res.status(401).json({ error: 'Unauthorized.' });
    }
    next();
});

// ── Agent persona index ───────────────────────────────────────────────────
const AGENT_PERSONAS = {
    dmm:    'Sarah, Digital Marketing Manager — strategic, decisive, ties everything to business outcomes',
    james:  'James, SEO Strategist — data-driven, specific about search metrics and keyword intent',
    priya:  'Priya, Content Manager — editorial, focused on narrative quality and audience relevance',
    elena:  'Elena, CRM & Leads Specialist — pipeline-oriented, commercial, focused on conversion',
    alex:   'Alex, Technical SEO Engineer — technical precision, performance metrics, crawl and structure',
};

function getPersona(agent_id) {
    return AGENT_PERSONAS[agent_id]
        || `a marketing specialist (agent: ${agent_id})`;
}

// ── Format tool results for the prompt ───────────────────────────────────
function formatToolResults(tool_results) {
    if (!Array.isArray(tool_results) || !tool_results.length) {
        return '(No tool results available.)';
    }

    return tool_results.map(r => {
        const header = `TOOL: ${r.tool_id} — ${r.status === 'ok' ? 'SUCCESS' : 'FAILED'}`;
        if (r.status !== 'ok') {
            return `${header}\nError: ${r.error || 'Unknown error'}`;
        }
        const data = r.data;
        if (!data) return `${header}\n(No data returned)`;

        // Compact JSON for large objects — truncate at 800 chars
        const raw = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
        return `${header}\n${raw.slice(0, 800)}${raw.length > 800 ? '\n…(truncated)' : ''}`;
    }).join('\n\n---\n\n');
}

// ── Build synthesis system prompt ─────────────────────────────────────────
function buildSynthesisSystemPrompt(agent_id, task_title, context_prompt, collab_summary) {
    const persona = getPersona(agent_id);

    return `You are ${persona}.

You have just completed a task and your tools have returned real data.
Your job is to synthesise this data into a clear, actionable deliverable.

${context_prompt ? `${context_prompt}\n` : ''}TASK YOU COMPLETED: "${task_title}"
${collab_summary ? `\nCOLLABORATION CONTEXT:\n${collab_summary}\n` : ''}
SYNTHESIS RULES:
- Write as yourself (${persona.split(' — ')[0]}). Use first person.
- Do NOT say "Based on the tool results" or "According to the data". Just deliver your analysis.
- Be specific. Reference actual numbers, URLs, keywords, names from the tool data.
- Structure your output clearly: lead with the most important finding, then supporting detail.
- End with 1–3 concrete next steps or recommendations.
- Keep it under 400 words unless the data genuinely demands more.
- This is a professional deliverable, not a chat message. Format it accordingly.`;
}

// ── POST /internal/synthesize ─────────────────────────────────────────────
router.post('/', async (req, res) => {
    const {
        task_id,
        agent_id       = 'dmm',
        task_title     = 'Untitled Task',
        tool_results   = [],
        context_prompt = '',
        collab_summary = null,
    } = req.body;

    if (!task_id) {
        return res.status(400).json({ error: 'task_id is required.' });
    }

    const toolBlock = formatToolResults(tool_results);
    const system    = buildSynthesisSystemPrompt(agent_id, task_title, context_prompt, collab_summary);

    const user_prompt = `Here are your tool results:\n\n${toolBlock}\n\nWrite your synthesis now.`;

    console.log(`[synthesis] task=${task_id} agent=${agent_id} tools=${tool_results.length}`);

    try {
        const r = await Promise.race([
            callLLM({
                messages: [
                    { role: 'system', content: system },
                    { role: 'user',   content: user_prompt },
                ],
                max_tokens:  800,
                temperature: 0.6,
            }),
            new Promise((_, rej) =>
                setTimeout(() => rej(new Error('synthesis timeout after 28s')), 28_000)
            ),
        ]);

        const output      = (r.content || '').trim();
        const tokens_used = r.usage?.total_tokens || 0;

        console.log(`[synthesis] task=${task_id} done | tokens=${tokens_used}`);

        return res.json({ output, task_id, tokens_used });

    } catch (e) {
        console.error(`[synthesis] task=${task_id} error:`, e.message);
        // Graceful degradation — return plain tool join so worker doesn't fail
        const fallback = tool_results
            .map(r => `[${r.tool_id}] ${r.status === 'ok' ? JSON.stringify(r.data ?? '') : r.error}`)
            .join('\n\n');
        return res.status(500).json({
            error:  e.message,
            output: fallback || '(Synthesis unavailable)',
            task_id,
            tokens_used: 0,
        });
    }
});

module.exports = router;
