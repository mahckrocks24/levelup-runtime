'use strict';

/**
 * LevelUp Prompt Assembler
 *
 * Assembles the 5-layer prompt stack before every LLM call.
 * Layer order (always in this sequence):
 *
 *   Layer 1 — Static Persona       (never changes per agent)
 *   Layer 2 — Workspace Context    (ICP, brand, goals, compressed)
 *   Layer 3 — Conversation Context (recent history, token-budgeted)
 *   Layer 4 — Task Context         (what this specific call is about)
 *   Layer 5 — Behavioural Rails    (disagreement, uncertainty, length rules)
 *
 * Returns a system prompt string ready for the LLM.
 */

// ── Dynamic persona builder — no hardcoded agent names ───────────────────────
// Names/titles come from DB (lu_workspace_agents) via agents.js getAgentsSync()
const { getAgentsSync } = require('./agents');
const { buildToolPromptBlock } = require('./tool-registry');

function buildDynamicPersona(agentId) {
    const agents = getAgentsSync();
    const agent  = agents[agentId];
    if (!agent) {
        return `You are a marketing specialist (role: ${agentId}) at LevelUp Growth. Be professional, direct, and data-driven.`;
    }
    const isDMM = agentId === 'dmm';
    const teamNote = isDMM
        ? 'You lead the marketing team. In chat, handle queries personally or delegate to the right specialist.'
        : `You provide specialist expertise as ${agent.title}. Give precise, data-grounded analysis.`;

    return `You are ${agent.name}, ${agent.title} at LevelUp Growth.

IDENTITY:
You are a seasoned ${agent.title.toLowerCase()} with deep expertise in your domain.
You are direct, commercially minded, and always tie your work to business outcomes.
You speak like a colleague, not a tool. You have opinions and share them clearly.

YOUR ROLE: ${teamNote}
Always summarise findings into clear, actionable recommendations.
When you use a tool, explain what you found and what it means — not just raw data.

CRITICAL BEHAVIOURS:
- Never say "As an AI" or "I'm a language model". You are ${agent.name}.
- Never apologise for having opinions or making recommendations.
- If something won't help the business, say so.
- Keep responses conversational and focused. No unnecessary padding.
- Make lists actionable — not just observations.`;
}


const BEHAVIOURAL_RAILS = `
RESPONSE GUIDELINES:
- Match the length to the complexity. Simple questions get short answers. Complex analyses get thorough responses.
- Use markdown formatting for readability: headers, bullet points, bold for emphasis.
- When uncertain, say so clearly and explain what you'd need to be more confident.
- Never invent data. If you don't have the information, say so and offer to find it.
- When a tool provides data, interpret it — don't just repeat raw numbers.
- End responses with a clear next step or question when appropriate.`;

/**
 * Assemble the full system prompt for a given agent.
 *
 * @param {string} agentId         — 'dmm' | 'aria' | custom agent ID
 * @param {object} workspaceContext — { businessName, industry, goals, brandVoice }
 * @param {object} taskContext      — { description, availableTools }
 * @returns {string}               — assembled system prompt
 */
function assembleSystemPrompt(agentId, workspaceContext = {}, taskContext = {}) {
    // Layer 1: Dynamic persona — name and title from DB, no hardcoded strings
    const persona = buildDynamicPersona(agentId);

    // Layer 2: Workspace context
    const workspaceLayer = buildWorkspaceLayer(workspaceContext);

    // Layer 4: Task context + unified tool catalogue
    const taskLayer  = buildTaskLayer(taskContext);
    const toolsLayer = buildToolPromptBlock(agentId); // Phase 2: 47-tool catalogue

    // Assemble in order
    const parts = [
        persona,            // Layer 1: Dynamic persona
        workspaceLayer,     // Layer 2: Workspace
        taskLayer,          // Layer 4: Task context
        toolsLayer,         // Layer 4b: Tool catalogue (all tools this agent can use)
        BEHAVIOURAL_RAILS,  // Layer 5: Behavioural rails
    ].filter(Boolean);

    return parts.join('\n\n');
}

function buildWorkspaceLayer(ctx) {
    if (!ctx || Object.keys(ctx).length === 0) {
        return 'WORKSPACE: No workspace context loaded yet. Ask the user about their business when relevant.';
    }

    const lines = ['WORKSPACE CONTEXT:'];
    if (ctx.businessName) lines.push(`Business: ${ctx.businessName}`);
    if (ctx.industry)     lines.push(`Industry: ${ctx.industry}`);
    if (ctx.website)      lines.push(`Website: ${ctx.website}`);
    if (ctx.goals)        lines.push(`Current goals: ${ctx.goals}`);
    if (ctx.brandVoice)   lines.push(`Brand voice: ${ctx.brandVoice}`);
    if (ctx.targetAudience) lines.push(`Target audience: ${ctx.targetAudience}`);

    return lines.join('\n');
}

function buildTaskLayer(ctx) {
    if (!ctx || Object.keys(ctx).length === 0) return '';

    const lines = ['CURRENT TASK CONTEXT:'];
    if (ctx.description)     lines.push(`Task: ${ctx.description}`);
    if (ctx.availableTools && ctx.availableTools.length > 0) {
        lines.push(`Available tools: ${ctx.availableTools.join(', ')}`);
        lines.push('Use tools when they would provide better, more accurate information than your training data alone.');
    }

    return lines.join('\n');
}

function buildGenericPersona(agentId) {
    return `You are a marketing specialist at LevelUp Growth (agent ID: ${agentId}). You are professional, helpful, and focused on delivering actionable marketing insights.`;
}

/**
 * Get OpenAI-format tool definitions for the LLM.
 * Reads from the unified 47-tool registry for the given agent.
 */
function getToolDefinitionsForLLM(tools, agentId) {
    // If agentId provided, load from unified registry; else use passed-in list
    if (agentId) {
        const registry = require('./registry');
        return registry.list(agentId).map(tool => ({
            type: 'function',
            function: {
                name:        tool.name,
                description: tool.description,
                parameters:  tool.parameters || { type: 'object', properties: {}, required: [] },
            },
        }));
    }
    return (tools || []).map(tool => ({
        type: 'function',
        function: {
            name:        tool.name,
            description: tool.description,
            parameters:  tool.parameters || { type: 'object', properties: {}, required: [] },
        },
    }));
}

// Remove unused buildGenericPersona — now using buildDynamicPersona
function buildGenericPersona(agentId) {
    return buildDynamicPersona(agentId);
}

module.exports = { assembleSystemPrompt, getToolDefinitionsForLLM };
