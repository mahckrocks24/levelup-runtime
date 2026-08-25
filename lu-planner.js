/**
 * LevelUp — Task Planning Engine
 *
 * Converts a user goal + workspace context into a structured, ordered
 * multi-agent execution plan using DeepSeek.
 *
 * Called by:
 *   POST /internal/agent/plan   (from PHP lu_agent_plan_create)
 *   lu-task-worker.js           (for inline re-planning on complex tasks)
 *
 * Plan output:
 * {
 *   goal_id, goal, tasks: [
 *     { seq, title, agent, tools[], params{}, rationale, depends_on[] }
 *   ]
 * }
 *
 * Falls back to single-task scaffold if LLM is unavailable.
 */

'use strict';

const { selectBestAgentForTool, fetchAgentExperience } = require('./behavior-analysis');

const { buildContextPrompt } = require('./lu-context');

const dsModels = require('./deepseek-models'); // DeepSeek V4 registry
const DEEPSEEK_URL   = 'https://api.deepseek.com/v1/chat/completions';
const PLAN_TIMEOUT   = 45_000;
const MAX_PLAN_TASKS = 8;

// ── Agent roster — built dynamically from capability-map ─────────────
// capability-map.js is the single source of truth for agent permissions.
// This eliminates duplication and ensures planner always matches WP capabilities.
const { CAPABILITY_MAP } = require('./capability-map');
const launchScope = require('./launch-scope');

// LAUNCH SCOPE (2026-07-21, v2.37.3): `marcus` removed. CAPABILITY_MAP is
// already launch-scope clean, so the roster below inherits that automatically.
const AGENT_ROLES = {
  dmm:    'Digital Marketing Manager',
  james:  'SEO Strategist',
  priya:  'Content Manager',
  elena:  'CRM & Lead Manager',
  alex:   'Technical SEO',
  _any:   'Any Agent',
};

// Build AGENT_ROSTER from CAPABILITY_MAP — same shape as before
const AGENT_ROSTER = Object.keys(CAPABILITY_MAP).reduce((acc, agent_id) => {
  if (launchScope.isRemovedAgent(agent_id)) return acc;
  acc[agent_id] = {
    role:  AGENT_ROLES[agent_id] || agent_id,
    tools: launchScope.filterToolIds(CAPABILITY_MAP[agent_id] || []),
  };
  return acc;
}, {
  // _any tools from CAPABILITY_MAP don't have a separate entry — add static fallback.
  // `record_metric` was dropped here: it is an email-campaign analytics tool
  // (POST /lumkt/v1/campaigns/:id/analytics) and was previously granted to
  // EVERY agent through this shared list.
  _any: { role: 'Any Agent', tools: ['ai_status','create_event','list_events','update_event','check_availability'] },
});

// ─────────────────────────────────────────────────────────────────────
// PLAN REQUEST SCHEMA (for LLM system prompt)
// ─────────────────────────────────────────────────────────────────────

function buildPlanSystemPrompt(context) {
  const contextBlock = buildContextPrompt(context);
  const agentBlock   = Object.entries(AGENT_ROSTER)
    .filter(([id]) => id !== '_any')
    .map(([id, a]) => `  ${id} (${a.role}): ${a.tools.join(', ')}`)
    .join('\n');

  return `You are the LevelUp task planner for a digital marketing platform.
Your job is to decompose a user's goal into an ordered list of agent tasks.

${contextBlock}

AVAILABLE AGENTS AND THEIR TOOLS:
${agentBlock}

PRODUCT SCOPE — HARD LIMITS (violating these produces an INVALID plan):
- This product does NOT include social-media management or email marketing.
- NEVER plan: social posts, social campaigns, posting schedules, hashtags, social engagement/replies/comments, social listening or sentiment, social analytics.
- NEVER plan: email campaigns, newsletters, email sequences/drips, email automation, subject-line or email-copy generation, sending or test-sending email.
- NEVER plan work for a specialist that is not in the agent list above. Do not invent agents.
- If the goal asks for out-of-scope work, DO NOT produce a task for it. Instead plan the closest genuinely supported alternative and say so in the rationale — for example: write a blog article, share an already-published article, generate a Studio image or video, build or update a Website Builder page, or create a CRM follow-up task. Never imply the unsupported work will happen.
- If NOTHING in the goal is supported, return {"tasks": []}.

RULES:
- Return ONLY valid JSON. No markdown, no explanation outside the JSON.
- Maximum ${MAX_PLAN_TASKS} tasks.
- Each task must use only tools that belong to the assigned agent (or _any tools).
- Tasks that can run independently should have empty depends_on[].
- Tasks that need results from a previous task should list its seq number in depends_on.
- Keep rationale short (one sentence max).
- Prefer sequential plans over parallel when output of one task feeds the next.

RESPONSE FORMAT (strict JSON):
{
  "tasks": [
    {
      "seq": 1,
      "title": "Short task title",
      "agent": "agent_id",
      "tools": ["tool_id"],
      "params": {},
      "rationale": "Why this step is needed.",
      "depends_on": []
    }
  ]
}`;
}

// ─────────────────────────────────────────────────────────────────────
// DEEPSEEK CALL
// ─────────────────────────────────────────────────────────────────────

async function callDeepSeek(system_prompt, user_message) {
  const api_key = process.env.DEEPSEEK_API_KEY;
  if (!api_key) throw new Error('DEEPSEEK_API_KEY not set');

  const body = JSON.stringify({
    // V4 migration 2026-07-26. Restoration default = flash. PRO_TIER is
    // available via env but NOT enabled: measured Pro reasoning on this exact
    // planner prompt was 1238 tokens vs 194 for flash, which would truncate
    // against the historic 1500 budget. Revisit once V4 pricing is confirmed.
    model: dsModels.resolveModel(process.env.PLANNER_TIER || 'flash'),
    messages: [
      { role: 'system',  content: system_prompt },
      { role: 'user',    content: user_message },
    ],
    temperature:  0.3,
    max_tokens:   dsModels.withReasoningHeadroom(1500),
    response_format: { type: 'json_object' },
  });

  const res = await fetch(DEEPSEEK_URL, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${api_key}`,
    },
    body,
    signal: AbortSignal.timeout(PLAN_TIMEOUT),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`DeepSeek API error ${res.status}: ${err.slice(0, 200)}`);
  }

  const data    = await res.json();
  const choice  = data?.choices?.[0];
  const content = dsModels.extractFinalContent(choice?.message);

  // V4: empty content on HTTP 200 means reasoning consumed the budget.
  dsModels.assertUsableContent(content, {
    finish_reason:    choice?.finish_reason,
    model:            data?.model,
    reasoning_tokens: dsModels.extractUsage(data?.usage || {}).reasoning_tokens,
  });

  // Truncated or malformed plans are rejected outright rather than thrown as a
  // bare SyntaxError, so callers can classify the failure.
  return dsModels.parseStructuredOutput(content, {
    requiredFields: ['tasks'],
    meta: { finish_reason: choice?.finish_reason, model: data?.model },
  });
}

// ─────────────────────────────────────────────────────────────────────
// VALIDATE & NORMALISE PLAN
// ─────────────────────────────────────────────────────────────────────

function normalisePlan(raw_plan, goal_id, goal) {
  const tasks = (raw_plan?.tasks || []).slice(0, MAX_PLAN_TASKS);
  if (!tasks.length) return null;

  const now = Math.floor(Date.now() / 1000);
  const built = tasks.map((t, i) => {
    const requested = String(t.agent || 'dmm').toLowerCase();

    // LAUNCH SCOPE: a plan that names a removed agent is not silently
    // re-pointed at a lookalike specialist — the task is dropped. Reassigning
    // (e.g. marcus → alex) would quietly keep out-of-scope work alive under a
    // retained agent's name, which is exactly what W3 set out to stop.
    if (launchScope.isRemovedAgent(requested)) {
      console.warn(`[planner] Dropped task ${i + 1}: assigned to launch-excluded agent '${requested}'`);
      return null;
    }

    const agent  = AGENT_ROSTER[requested] ? requested : 'dmm';
    const roster = AGENT_ROSTER[agent] || AGENT_ROSTER.dmm;
    const any    = AGENT_ROSTER._any.tools;

    // Sanitise tools — keep only tools this agent is allowed to use, and never
    // a launch-removed tool even if it somehow appears in a roster.
    const all_allowed = launchScope.filterToolIds([...roster.tools, ...any]);
    let tools = (Array.isArray(t.tools) ? t.tools : [])
      .map(String)
      .filter(tool => all_allowed.includes(tool));

    // Phase 5: Avoid tools with < 40% success rate from experience data
    if (normalisePlan._toolStats) {
      const failingTools = tools.filter(toolId => {
        const stat = normalisePlan._toolStats[toolId];
        if (!stat) return false;
        const total = stat.call_count || 0;
        if (total < 3) return false; // not enough data to flag
        const successRate = total > 0 ? (total - (stat.error_count || 0)) / total : 1;
        if (successRate < 0.4) {
          console.log(`[planner] Avoiding tool ${toolId} — success rate ${Math.round(successRate*100)}% (< 40%)`);
          return true;
        }
        return false;
      });
      tools = tools.filter(t => !failingTools.includes(t));
    }

    // Part 5: Health filtering done async in createPlan() after normalisePlan returns.
    // If nothing survived sanitisation there is no in-scope tool for this task —
    // drop it rather than emitting `[undefined]` as the tool list.
    const fallback = roster.tools.length ? [roster.tools[0]] : [];
    const final_tools = tools.length ? tools : fallback;
    if (!final_tools.length) {
      console.warn(`[planner] Dropped task ${i + 1}: no in-scope tool available for agent '${agent}'`);
      return null;
    }

    return {
      _origSeq:   i + 1,
      task_id:    `t_${goal_id}_${i + 1}`,
      seq:        i + 1,
      title:      String(t.title  || `Task ${i + 1}`).slice(0, 120),
      agent,
      tools:      final_tools,
      params:     (t.params && typeof t.params === 'object') ? t.params : {},
      rationale:  String(t.rationale || '').slice(0, 200),
      depends_on: Array.isArray(t.depends_on)
                    ? t.depends_on.map(Number).filter(n => n > 0 && n < i + 1)
                    : [],
      status:     'pending',
      output_id:  null,
      created_at: now,
    };
  });

  // Drop launch-scope rejections, then re-sequence. Dependencies are remapped
  // to the new numbering; a dependency on a dropped task is discarded rather
  // than left dangling (a task must never wait on work that will never run).
  const kept = built.filter(Boolean);
  if (!kept.length) {
    console.warn('[planner] All planned tasks were out of launch scope — returning empty plan');
    return null;
  }

  const seqRemap = new Map();
  kept.forEach((task, idx) => seqRemap.set(task._origSeq, idx + 1));

  return kept.map((task, idx) => {
    const { _origSeq, ...rest } = task;
    return {
      ...rest,
      task_id:    `t_${goal_id}_${idx + 1}`,
      seq:        idx + 1,
      depends_on: rest.depends_on
                    .map(n => seqRemap.get(n))
                    .filter(n => typeof n === 'number' && n < idx + 1),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────
// SCAFFOLD FALLBACK
// ─────────────────────────────────────────────────────────────────────

function scaffoldPlan(goal_id, goal) {
  return [{
    task_id:    `t_${goal_id}_1`,
    seq:        1,
    title:      goal,
    agent:      'dmm',
    tools:      ['autonomous_goal'],
    params:     { goal },
    rationale:  'Single-agent fallback — planner unavailable.',
    depends_on: [],
    status:     'pending',
    output_id:  null,
    created_at: Math.floor(Date.now() / 1000),
  }];
}

// ─────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────

/**
 * Generate a task plan for a goal.
 *
 * @param {string} goal_id
 * @param {string} goal
 * @param {object} context   — workspace context from lu-context.js
 * @param {string} extra_ctx — optional freeform context string from user
 * @returns {Promise<{tasks, used_llm, error?}>}
 */
async function createPlan({ goal_id, goal, context = {}, extra_ctx = '' }) {
  // Phase 5: Fetch agent experience for intelligent routing
  const wp_url    = process.env.WP_URL || '';
  const wp_secret = process.env.LU_SECRET || '';
  let experienceMap = null;
  try {
    const expData = await fetchAgentExperience(wp_url, wp_secret, null);
    if (expData?.experience) {
      experienceMap = {};
      for (const row of expData.experience) {
        experienceMap[row.agent_id] = row;
      }
    }
  } catch (_) { /* non-critical — plan still runs without experience */ }

  const system_prompt = buildPlanSystemPrompt(context);
  const user_message  = extra_ctx
    ? `Goal: ${goal}\n\nAdditional context: ${extra_ctx}`
    : `Goal: ${goal}`;

  try {
    const raw = await callDeepSeek(system_prompt, user_message);
    // Phase 5: Attach tool stats to normalisePlan for reliability filtering
    try {
      const statsRes = await fetch(`${process.env.LARAVEL_BASE_URL || process.env.LARAVEL_URL || wp_url}/api/internal/tools/status`, {
        headers:{ 'X-LU-Secret': wp_secret, Accept:'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (statsRes.ok) {
        const statsData = await statsRes.json();
        normalisePlan._toolStats = statsData.stats || {};
        console.log('[planner] Tool stats loaded for reliability check');
      }
    } catch(_) { normalisePlan._toolStats = {}; }

    let tasks = normalisePlan(raw, goal_id, goal);
    if (!tasks || !tasks.length) {
      console.warn('[planner] LLM returned empty plan — using scaffold');
      return { tasks: scaffoldPlan(goal_id, goal), used_llm: false, error: 'empty_plan' };
    }

    // Phase 5: Re-route tasks to best-performing agent per tool when experience data exists
    if (experienceMap) {
      tasks = tasks.map(task => {
        const primaryTool = task.tools?.[0];
        if (!primaryTool) return task;
        const { getToolsForAgent } = require('./tool-registry');
        const allowedAgents = Object.keys(AGENT_ROSTER).filter(a =>
          a !== '_any' && getToolsForAgent(a).some(t => t.id === primaryTool)
        );
        if (allowedAgents.length <= 1) return task; // no routing decision needed
        const bestAgent = selectBestAgentForTool(primaryTool, experienceMap, task.agent, allowedAgents);
        if (bestAgent !== task.agent) {
          console.log(`[planner] Routing ${primaryTool} to ${bestAgent} (experience-based, was ${task.agent})`);
          return { ...task, agent: bestAgent };
        }
        return task;
      });
    }

    console.log(`[planner] Generated ${tasks.length}-task plan for goal ${goal_id}${experienceMap ? ' (experience-routed)' : ''}`);
    return { tasks, used_llm: true };
  } catch (e) {
    console.error('[planner] Planning failed, using scaffold:', e.message);
    return { tasks: scaffoldPlan(goal_id, goal), used_llm: false, error: e.message };
  }
}

/**
 * Re-plan a single task given partial results from completed dependencies.
 * Used when a running task needs to adapt based on earlier outputs.
 */
async function refineSingleTask({ task_id, title, agent, tools, context, dependency_outputs = [] }) {
  if (!dependency_outputs.length) return null;

  const system_prompt = buildPlanSystemPrompt(context);
  const dep_summary = dependency_outputs
    .map(d => `[${d.agent_id}] ${d.output_summary || ''}`)
    .join('\n');

  const user_message = `Refine params for this single task based on prior results.

Task: ${title}
Agent: ${agent}
Tools: ${tools.join(', ')}

Prior agent outputs:
${dep_summary}

Return a JSON object with a single "params" key containing refined task parameters.
Example: {"params": {"keyword": "landing page optimization", "tone": "professional"}}`;

  try {
    const raw = await callDeepSeek(system_prompt, user_message);
    return raw?.params || null;
  } catch (e) {
    console.warn('[planner] Param refinement failed:', e.message);
    return null;
  }
}

module.exports = { createPlan, refineSingleTask, scaffoldPlan, AGENT_ROSTER };
