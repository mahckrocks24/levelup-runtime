'use strict';

/**
 * Task Worker — Sprint F: Tool-Aware Delivery
 * When an agent delivers a task, they can now call real tools (SEO audit,
 * keyword lookup, content draft, CRM write) to produce data-grounded output.
 */

const { callLLM }         = require('./llm');
const taskMemory          = require('./task-memory');
const workspaceMemory     = require('./workspace-memory');
const luMemory            = require('./lu-memory'); // Intervention 1: dual-write target
const { AGENTS, TOKENS }  = require('./agents');
const { formatMemoryForPrompt } = require('./workspace-memory');
const { parseToolCall, executeTool, formatToolResult } = require('./tool-executor');
const { resolveToolParams, buildRetryStrategy }           = require('./param-resolver');
const { buildToolPromptBlock } = require('./tool-registry');

// ── Per-agent delivery prompts ────────────────────────────────────────────
function buildDeliveryPrompt(agentId, task, memory, schema) {
    const a        = AGENTS[agentId];
    const mem      = formatMemoryForPrompt(memory);
    const toolBlock = buildToolPromptBlock(agentId);

    const schemaGuide = {
        james: `Return a JSON object with these exact fields:
{
  "primary_keyword": "exact match keyword",
  "keywords": [{"keyword":"...","monthly_volume":0,"difficulty":0,"intent":"informational|commercial|transactional","serp_feature":"featured_snippet|PAA|local_pack|none"}],
  "recommended_page_type": "pillar|comparison|listicle|landing_page|blog",
  "cluster_summary": "1 sentence on the topical cluster strategy"
}`,
        priya: `Return a JSON object with these exact fields:
{
  "title": "exact H1 title",
  "target_keyword": "primary keyword",
  "content_type": "pillar|comparison|listicle|case_study|thought_leadership",
  "word_count": 0,
  "structure": ["H2 section 1","H2 section 2","H2 section 3"],
  "cta": "specific CTA text and placement",
  "internal_links": ["page 1 to link to","page 2"],
  "tone": "authoritative|conversational|technical",
  "brief_summary": "1 sentence on the content strategy"
}`,
        elena: `Return a JSON object with these exact fields:
{
  "lead_magnet": {"type":"...","title":"...","format":"PDF|calculator|checklist|webinar"},
  "capture_mechanism": "form|exit-intent|content-upgrade|chatbot",
  "lead_scoring": {"mql_threshold":0,"scoring_criteria":["..."]},
  "handoff_threshold": "description of when SQL handed to sales",
  "funnel_summary": "1 sentence on the lead strategy"
}`,
        alex: `Return a JSON object with these exact fields:
{
  "issues": [{"issue":"...","severity":"critical|high|medium","fix":"..."}],
  "priority_fixes": ["fix 1","fix 2","fix 3"],
  "core_web_vitals": {"lcp":"target or current","cls":"target or current","inp":"target or current"},
  "schema_opportunities": ["schema type 1","schema type 2"],
  "audit_summary": "1 sentence on the most critical technical finding"
}`,
        dmm: `Return a JSON object with these exact fields:
{
  "objective": "clear measurable objective",
  "key_decisions": ["decision 1","decision 2"],
  "next_actions": [{"action":"...","owner":"...","deadline":"..."}],
  "success_metrics": ["metric 1","metric 2"],
  "strategy_summary": "1 sentence strategic overview"
}`
    };

    return `You are ${a.name}, ${a.title} at LevelUp Growth. You have been assigned a task and must now deliver.

${mem ? `WORKSPACE CONTEXT:\n${mem}\n` : ''}
${toolBlock}
YOUR ASSIGNED TASK:
Title: ${task.title}
Description: ${task.description}
Success Metric: ${task.success_metric}
Priority: ${task.priority}
Meeting Context: ${task.meeting_id ? `From meeting ${task.meeting_id}` : 'Directly assigned'}

DELIVERY INSTRUCTIONS:
If a tool is available that gives you real data for this task, USE IT FIRST — output only the <tool_call> block.
After the tool result is returned, produce your full deliverable using the real data.
If no tool is needed, deliver directly.

You must produce TWO things in a single JSON response:

1. DELIVERABLE — structured output matching your role schema
2. SUMMARY — 3-5 sentence plain English explanation of what you produced and why

${schemaGuide[agentId] || schemaGuide.dmm}

Wrap everything in this outer structure:
{
  "deliverable": { ...your schema above... },
  "summary": "3-5 sentences plain English. Be specific — reference the task title, give your key finding, explain what the user should do with this deliverable.",
  "agent": "${agentId}",
  "schema_type": "${taskMemory.getDeliverableSchema(agentId).type}",
  "tool_used": "tool_id or null"
}

Be specific. Use real data from tools where available. No vague filler.
Return ONLY valid JSON. No markdown fences.`;
}

// ── Main trigger ──────────────────────────────────────────────────────────
async function triggerTaskDelivery(wsId, taskId) {
    const task = await taskMemory.getTask(wsId, taskId);
    if (!task) { console.error(`[TASK-WORKER] Task not found: ${taskId}`); return; }
    if (task.status !== taskMemory.STATUS.IN_PROGRESS) return;

    const agentId = task.assignee;
    const agent   = AGENTS[agentId];
    if (!agent) { console.error(`[TASK-WORKER] Unknown agent: ${agentId}`); return; }

    console.log(`[TASK-WORKER] ${agent.name} starting delivery on: ${task.title}`);

    // Post acknowledgement note immediately
    await taskMemory.addNote(wsId, taskId, {
        author:    agentId,
        author_name: agent.name,
        type:      'ack',
        content:   getAck(agentId, task),
    });

    try {
        const memory = await workspaceMemory.getMemory(wsId);
        const schema = taskMemory.getDeliverableSchema(agentId);
        const prompt = buildDeliveryPrompt(agentId, task, memory, schema);

        const deliveryMsg = { role: 'user', content: 'Deliver your output now. Use a tool first if you need real data.' };

        // Step 1 — initial LLM call
        let r = await Promise.race([
            callLLM({
                messages: [{ role: 'system', content: prompt }, deliveryMsg],
                max_tokens: TOKENS.specialist,
                temperature: 0.5,
            }),
            new Promise((_,rej) => setTimeout(() => rej(new Error('delivery timeout')), 90000)),
        ]);

        // Step 2 — tool call intercept
        const toolCheck = parseToolCall(r.content || '');
        if (toolCheck.hasToolCall) {
            console.log(`[TASK-WORKER] ${agent.name} calling tool: ${toolCheck.tool}`);

            // Post a note so the user can see the tool was used
            await taskMemory.addNote(wsId, taskId, {
                author:      agentId,
                author_name: agent.name,
                type:        'tool_call',
                content:     `Using ${toolCheck.tool} to get real data for this task…`,
            });

            // ── Reliability layer: param resolution before execution ──
            const memory_ws  = memory?.workspace || {};
            const task_desc  = task?.description || task?.title || '';
            const resolution = resolveToolParams(toolCheck.tool, toolCheck.params, task_desc, { workspace: memory_ws });
            resolution.log.forEach(l => console.log(l));

            let execResult;
            if (!resolution.ready) {
                // Required params missing — post clarification note, do not execute
                console.log(`[TASK-WORKER] param resolution blocked for ${toolCheck.tool}: ${resolution.missing.join(', ')}`);
                await taskMemory.addNote(wsId, taskId, {
                    author:      agentId,
                    author_name: agent.name,
                    type:        'clarification',
                    content:     resolution.clarification_question,
                });
                // Fall through to delivery without tool data
                execResult = { status: 'error', error: `Missing required params: ${resolution.missing.join(', ')}. ${resolution.clarification_question}` };
            } else {
                execResult = await executeTool(agentId, toolCheck.tool, resolution.resolved_params, taskId);
                // ── Retry once on recoverable errors ──────────────────────────
                if (execResult.status === 'error') {
                    const strategy = buildRetryStrategy(toolCheck.tool, execResult.error || '', task_desc, resolution.resolved_params);
                    strategy.log?.forEach(l => console.log(l));
                    if (strategy.action === 'retry' && strategy.suggested_params) {
                        console.log(`[TASK-WORKER] retrying ${toolCheck.tool}`);
                        execResult = await executeTool(agentId, toolCheck.tool, strategy.suggested_params, taskId);
                    } else if (strategy.action === 'ask') {
                        await taskMemory.addNote(wsId, taskId, {
                            author:      agentId,
                            author_name: agent.name,
                            type:        'clarification',
                            content:     strategy.message,
                        });
                    }
                }
            }
            const toolBlock  = formatToolResult(toolCheck.tool, execResult);

            // If the tool requires governance approval, note it and bail — task stays In Progress
            // until the user approves and the agent can be re-triggered (future: auto-resume)
            if (execResult.status === 'pending_approval') {
                await taskMemory.addNote(wsId, taskId, {
                    author:      agentId,
                    author_name: agent.name,
                    type:        'governance',
                    content:     `Action queued for approval: ${execResult.preview}\nAction ID: ${execResult.action_id}`,
                });
                console.log(`[TASK-WORKER] Task ${taskId} paused — governance approval needed: ${execResult.action_id}`);
                return; // task stays In Progress; will resume after approval
            }

            // Step 3 — second LLM call with real tool data
            r = await Promise.race([
                callLLM({
                    messages: [
                        { role: 'system',    content: prompt },
                        deliveryMsg,
                        { role: 'assistant', content: r.content },
                        { role: 'user',      content: `${toolBlock}\n\nNow produce your full JSON deliverable using this real data.` },
                    ],
                    max_tokens: TOKENS.specialist,
                    temperature: 0.5,
                }),
                new Promise((_,rej) => setTimeout(() => rej(new Error('tool delivery timeout')), 90000)),
            ]);
        }

        // Parse response
        let parsed;
        try {
            const clean = (r.content || '').replace(/```json\s*/gi,'').replace(/```/g,'').trim();
            const s = clean.indexOf('{'), e = clean.lastIndexOf('}');
            parsed = JSON.parse(clean.slice(s, e + 1));
        } catch(e) {
            parsed = {
                deliverable: { raw: r.content },
                summary: r.content,
                agent: agentId,
                schema_type: schema.type,
            };
        }

        // Save deliverable — also moves task to Review
        const updated = await taskMemory.saveDeliverable(wsId, taskId, parsed);

        // ── Intervention 1: dual memory write on task completion ──
        // BOTH writes wrapped in independent try/catch — memory failure NEVER breaks task.

        // (a) workspace-memory: business-context layer (episodic + heuristic)
        try {
            await workspaceMemory.updateFromTask(wsId, {
                task_id:      taskId,
                agent:        agentId,
                title:        task.title,
                summary:      parsed.summary || '',
                engine:       task.engine    || '',
                content_type: parsed.schema_type || schema.type || '',
                status:       'completed',
            });
        } catch (memErr) {
            console.warn('[TASK-WORKER] workspace memory write failed (non-blocking):', memErr.message);
        }

        // (b) lu-memory: execution-context layer (per-task record + agent context)
        try {
            await luMemory.taskMemoryWrite(taskId, {
                ws_id:        wsId,
                goal_id:      task.goal_id || null,
                agent_id:     agentId,
                title:        task.title,
                tools:        task.tools  || [],
                status:       'completed',
                output:       parsed.summary || '',
                duration_ms:  task.duration_ms || 0,
                tool_results: task.tool_results || [],
            });
        } catch (memErr) {
            console.warn('[TASK-WORKER] lu-memory task write failed (non-blocking):', memErr.message);
        }

        // Add completion note
        await taskMemory.addNote(wsId, taskId, {
            author:      agentId,
            author_name: agent.name,
            type:        'deliverable',
            content:     parsed.summary || 'Deliverable ready.',
        });

        // Notify coordinator if any
        if (task.coordinator && AGENTS[task.coordinator]) {
            await taskMemory.addNote(wsId, taskId, {
                author:      'system',
                author_name: 'System',
                type:        'coordinator_notify',
                content:     `${AGENTS[task.coordinator].name} — ${agent.name} has completed this task and it's ready for your review.`,
            });
        }

        console.log(`[TASK-WORKER] ${agent.name} delivered: ${task.title}`);
        return updated;

    } catch(e) {
        console.error(`[TASK-WORKER] Delivery failed for ${taskId}:`, e.message);
        await taskMemory.addNote(wsId, taskId, {
            author:      agentId,
            author_name: agent.name,
            type:        'error',
            content:     `I ran into an issue delivering this task: ${e.message}. I'll retry shortly.`,
        });
    }
}

function getAck(agentId, task) {
    const acks = {
        james:  [`On it — pulling keyword data for "${task.title}" now.`, `Starting keyword analysis for this. Give me a moment.`, `Let me run the search volume and difficulty check on this now.`],
        priya:  [`On it — drafting the content brief for "${task.title}".`, `Starting the brief now. Won't be long.`, `Got it — mapping out the content structure now.`],
        elena:  [`On it — mapping the funnel logic for "${task.title}".`, `Starting the CRM and lead-capture structure now.`, `Got it — working through the lead capture framework.`],
        alex:   [`Running the technical audit now.`, `On it — checking the architecture and vitals.`, `Starting the technical review now.`],
        dmm:    [`On it — pulling the strategy together now.`, `Starting the overview now.`],
    };
    const list = acks[agentId] || [`On it — working on "${task.title}" now.`];
    return list[Math.floor(Math.random() * list.length)];
}

module.exports = { triggerTaskDelivery };
