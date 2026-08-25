/**
 * LevelUp — Multi-Agent Collaboration Protocol
 *
 * Enables agents to delegate subtasks to other agents and exchange
 * internal messages that are stored in the task log but not surfaced
 * to the user directly.
 *
 * Collaboration patterns:
 *
 *   DELEGATION
 *     Orchestrating agent (usually Sarah) assigns a subtask to a
 *     specialist agent. The subtask is enqueued as a child task linked
 *     to the parent goal. The orchestrator's output includes a summary
 *     of what was delegated and to whom.
 *
 *   INTERNAL MESSAGE
 *     One agent sends a message to another during execution.
 *     Stored in: lu:collab:{goal_id}:messages (Redis list)
 *     Visible in: reasoning trace and exec log
 *     NOT sent to the user.
 *
 *   HANDOFF
 *     Agent A completes its work and explicitly marks its output as
 *     input for Agent B. The handoff record lives in the task's
 *     reasoning trace.
 *
 * Redis key:  lu:collab:{goal_id}:messages
 * TTL:        90 days
 */

'use strict';

const { redis }                  = require('./lu-lifecycle');
const { appendLog }              = require('./lu-lifecycle');
const { traceAppendCollaboration } = require('./lu-reasoning');

const COLLAB_TTL   = 90 * 24 * 60 * 60;
const MSG_LIST_MAX = 200;

const KEY_MSGS   = (goal_id)  => `lu:collab:${goal_id}:messages`;
const KEY_DELEGATION = (goal_id) => `lu:collab:${goal_id}:delegations`;

// ─────────────────────────────────────────────────────────────────────
// INTERNAL MESSAGES
// ─────────────────────────────────────────────────────────────────────

/**
 * Record an internal agent-to-agent message.
 * Not visible to the user — stored for trace/debug only.
 *
 * @param {string} goal_id
 * @param {string} task_id
 * @param {string} from_agent
 * @param {string} to_agent      — or 'all' for broadcast
 * @param {string} type          — 'info' | 'request' | 'handoff' | 'status'
 * @param {string} content
 */
async function sendInternalMessage({ goal_id, task_id, from_agent, to_agent, type = 'info', content }) {
  const msg = {
    id:         `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    goal_id,
    task_id,
    from:       from_agent,
    to:         to_agent || 'all',
    type,
    content:    String(content).slice(0, 1000),
    ts:         Math.floor(Date.now() / 1000),
  };

  // Store in goal collaboration log
  if (goal_id) {
    await redis.pipeline()
      .rpush(KEY_MSGS(goal_id), JSON.stringify(msg))
      .ltrim(KEY_MSGS(goal_id), -MSG_LIST_MAX, -1)
      .expire(KEY_MSGS(goal_id), COLLAB_TTL)
      .exec();
  }

  // Append to reasoning trace for the sending task
  if (task_id) {
    await traceAppendCollaboration(task_id, {
      direction: 'sent',
      from: from_agent,
      to:   to_agent || 'all',
      type,
      content: msg.content,
    }).catch(() => {});
  }

  // Write to task exec log for visibility in admin UI
  if (task_id) {
    await appendLog(task_id, {
      ts:      msg.ts,
      event:   `collab:${type}`,
      from:    from_agent,
      to:      to_agent || 'all',
      content: msg.content.slice(0, 200),
    }).catch(() => {});
  }

  console.log(`[collab] ${from_agent} → ${to_agent || 'all'}: [${type}] ${msg.content.slice(0, 80)}`);
  return msg;
}

/**
 * Read all internal messages for a goal (for trace/debug endpoint).
 */
async function getGoalMessages(goal_id, limit = 50) {
  const raw = await redis.lrange(KEY_MSGS(goal_id), -limit, -1);
  return raw.map(r => JSON.parse(r));
}

// ─────────────────────────────────────────────────────────────────────
// DELEGATION
// ─────────────────────────────────────────────────────────────────────

/**
 * Record a delegation from an orchestrating agent to a specialist.
 * This is informational — actual task enqueue happens via the normal
 * dispatch path. This records the intent and links parent/child.
 *
 * @param {object} opts
 * @param {string} opts.goal_id
 * @param {string} opts.parent_task_id   — orchestrator's task
 * @param {string} opts.child_task_id    — specialist's task
 * @param {string} opts.from_agent       — orchestrator (e.g. sarah)
 * @param {string} opts.to_agent         — specialist (e.g. james)
 * @param {string} opts.subtask_title
 * @param {string[]} opts.tools
 * @param {string} opts.reason           — why this agent was chosen
 */
async function recordDelegation({ goal_id, parent_task_id, child_task_id, from_agent, to_agent, subtask_title, tools = [], reason = '' }) {
  const delegation = {
    id:             `del_${Date.now()}`,
    goal_id,
    parent_task_id,
    child_task_id,
    from_agent,
    to_agent,
    subtask_title,
    tools,
    reason:         String(reason).slice(0, 300),
    ts:             Math.floor(Date.now() / 1000),
    status:         'pending',
  };

  if (goal_id) {
    await redis.pipeline()
      .rpush(KEY_DELEGATION(goal_id), JSON.stringify(delegation))
      .expire(KEY_DELEGATION(goal_id), COLLAB_TTL)
      .exec();
  }

  // Notify via internal message
  await sendInternalMessage({
    goal_id,
    task_id: parent_task_id,
    from_agent,
    to_agent,
    type: 'request',
    content: `Delegating "${subtask_title}" to you. Tools: ${tools.join(', ')}. Reason: ${reason}`,
  });

  return delegation;
}

async function updateDelegationStatus(goal_id, child_task_id, status) {
  const raw = await redis.lrange(KEY_DELEGATION(goal_id), 0, -1);
  const updated = raw.map(r => {
    const d = JSON.parse(r);
    if (d.child_task_id === child_task_id) d.status = status;
    return JSON.stringify(d);
  });
  if (!updated.length) return;
  const pipeline = redis.pipeline();
  pipeline.del(KEY_DELEGATION(goal_id));
  updated.forEach(v => pipeline.rpush(KEY_DELEGATION(goal_id), v));
  pipeline.expire(KEY_DELEGATION(goal_id), COLLAB_TTL);
  await pipeline.exec();
}

async function getDelegations(goal_id) {
  const raw = await redis.lrange(KEY_DELEGATION(goal_id), 0, -1);
  return raw.map(r => JSON.parse(r));
}

// ─────────────────────────────────────────────────────────────────────
// HANDOFF
// ─────────────────────────────────────────────────────────────────────

/**
 * Record a handoff: Agent A completed work and its output feeds Agent B.
 * Stored in both the reasoning trace and the collaboration log.
 */
async function recordHandoff({ goal_id, from_task_id, to_task_id, from_agent, to_agent, output_summary }) {
  await sendInternalMessage({
    goal_id,
    task_id: from_task_id,
    from_agent,
    to_agent,
    type: 'handoff',
    content: `Completed. Passing output to ${to_agent}: ${String(output_summary || '').slice(0, 300)}`,
  });

  // Mark delegation as complete
  if (goal_id && to_task_id) {
    await updateDelegationStatus(goal_id, to_task_id, 'received').catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────
// COLLABORATION SUMMARY
// Returns a concise summary for injection into LLM synthesis
// ─────────────────────────────────────────────────────────────────────

async function getCollaborationSummary(goal_id) {
  if (!goal_id) return null;
  const delegations = await getDelegations(goal_id);
  if (!delegations.length) return null;

  const completed = delegations.filter(d => d.status !== 'pending');
  if (!completed.length) return null;

  return completed
    .map(d => `${d.from_agent} → ${d.to_agent}: "${d.subtask_title}" [${d.status}]`)
    .join('\n');
}

module.exports = {
  sendInternalMessage,
  getGoalMessages,
  recordDelegation,
  updateDelegationStatus,
  getDelegations,
  recordHandoff,
  getCollaborationSummary,
};
