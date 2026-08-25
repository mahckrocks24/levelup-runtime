/**
 * LevelUp — Agent Memory Subsystem
 *
 * Three memory layers, all Redis-backed:
 *
 * SHORT-TERM  lu:mem:short:{task_id}
 *   Active conversation context and scratchpad for the current task.
 *   TTL: 24 hours. Discarded after task completes.
 *
 * TASK        lu:mem:task:{task_id}
 *   Persisted task result summary. Written on task completion.
 *   Includes: goal, agent, tools used, output summary, duration, status.
 *   TTL: 90 days. Accessible to planner for context in future tasks.
 *
 * LONG-TERM   lu:mem:ws:{ws_id}:*
 *   Workspace-level knowledge: brand voice, audience, services, past campaigns.
 *   TTL: 365 days (effectively permanent — refreshed on each write).
 *   Shared across all agents in the workspace.
 *
 * Memory retrieval is called automatically before task dispatch.
 * Memory write is called automatically on task completion.
 */

'use strict';

const { redis } = require('./lu-lifecycle');

// ── TTLs ─────────────────────────────────────────────────────────────
const TTL_SHORT     = 24 * 60 * 60;          // 24 hours
const TTL_TASK      = 90 * 24 * 60 * 60;     // 90 days
const TTL_LONGTERM  = 365 * 24 * 60 * 60;    // 365 days

// ── Key builders ─────────────────────────────────────────────────────
const KEY_SHORT     = (task_id)         => `lu:mem:short:${task_id}`;
const KEY_TASK      = (task_id)         => `lu:mem:task:${task_id}`;
const KEY_WS        = (ws_id, field)    => `lu:mem:ws:${ws_id}:${field}`;
const KEY_WS_INDEX  = (ws_id)           => `lu:mem:ws:${ws_id}:_index`;
const KEY_WS_RECENT = (ws_id)           => `lu:mem:ws:${ws_id}:_recent_tasks`;
const KEY_AGENT_CTX = (ws_id, agent_id) => `lu:mem:agent:${ws_id}:${agent_id}`;

const WS_ID = 1;  // Single-workspace for now — extend later

// ─────────────────────────────────────────────────────────────────────
// SHORT-TERM MEMORY
// ─────────────────────────────────────────────────────────────────────

async function shortTermWrite(task_id, data) {
  const key = KEY_SHORT(task_id);
  await redis.set(key, JSON.stringify({ ...data, updated_at: Math.floor(Date.now() / 1000) }), 'EX', TTL_SHORT);
}

async function shortTermRead(task_id) {
  const raw = await redis.get(KEY_SHORT(task_id));
  return raw ? JSON.parse(raw) : null;
}

async function shortTermAppend(task_id, key, value) {
  const existing = await shortTermRead(task_id) || {};
  existing[key] = value;
  await shortTermWrite(task_id, existing);
}

async function shortTermDelete(task_id) {
  await redis.del(KEY_SHORT(task_id));
}

// ─────────────────────────────────────────────────────────────────────
// TASK MEMORY
// ─────────────────────────────────────────────────────────────────────

async function taskMemoryWrite(task_id, record) {
  // record: { goal_id, agent_id, title, tools, status, output_summary, duration_ms, ws_id, created_at }
  // Pre-Intervention 0: respect record.ws_id when supplied; fall back to WS_ID for legacy callers.
  const ws_id = record.ws_id || WS_ID;
  const key = KEY_TASK(task_id);
  const payload = {
    task_id,
    ws_id,
    goal_id:        record.goal_id || null,
    agent_id:       record.agent_id,
    title:          record.title || task_id,
    tools:          record.tools || [],
    status:         record.status,
    output_summary: typeof record.output === 'string'
                      ? record.output.slice(0, 500)
                      : JSON.stringify(record.output || '').slice(0, 500),
    duration_ms:    record.duration_ms || 0,
    tool_count:     (record.tool_results || []).length,
    tools_ok:       (record.tool_results || []).filter(r => r.status === 'ok').length,
    completed_at:   Math.floor(Date.now() / 1000),
  };

  await redis.pipeline()
    .set(key, JSON.stringify(payload), 'EX', TTL_TASK)
    // Add to workspace recent-tasks list (last 100) — scoped to the actual ws_id
    .lpush(KEY_WS_RECENT(ws_id), task_id)
    .ltrim(KEY_WS_RECENT(ws_id), 0, 99)
    .expire(KEY_WS_RECENT(ws_id), TTL_LONGTERM)
    .exec();

  return payload;
}

async function taskMemoryRead(task_id) {
  const raw = await redis.get(KEY_TASK(task_id));
  return raw ? JSON.parse(raw) : null;
}

/**
 * Retrieve recent completed task summaries for context injection.
 * Returns last N task memory records, most recent first.
 *
 * Pre-Intervention 0: accepts ws_id; falls back to WS_ID default for legacy callers.
 */
async function recentTaskMemory(limit = 10, ws_id = WS_ID) {
  const ids = await redis.lrange(KEY_WS_RECENT(ws_id), 0, limit - 1);
  if (!ids.length) return [];

  const pipeline = redis.pipeline();
  ids.forEach(id => pipeline.get(KEY_TASK(id)));
  const results = await pipeline.exec();

  return results
    .map(([err, raw]) => (!err && raw) ? JSON.parse(raw) : null)
    .filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────
// LONG-TERM WORKSPACE MEMORY
// ─────────────────────────────────────────────────────────────────────

/**
 * Write a single workspace memory field.
 * Fields: brand_voice, target_audience, services, industry, business_desc,
 *         past_campaigns, website_data, goals, tone, competitors, etc.
 */
async function longTermWrite(field, value, ws_id = WS_ID) {
  const key = KEY_WS(ws_id, field);
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  const pipeline = redis.pipeline();
  pipeline.set(key, serialized, 'EX', TTL_LONGTERM);
  // Track which fields exist in an index set
  pipeline.sadd(KEY_WS_INDEX(ws_id), field);
  pipeline.expire(KEY_WS_INDEX(ws_id), TTL_LONGTERM);
  await pipeline.exec();
}

async function longTermRead(field, ws_id = WS_ID) {
  const raw = await redis.get(KEY_WS(ws_id, field));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

/**
 * Read all workspace memory fields at once.
 * Returns a flat object: { brand_voice: "...", target_audience: "...", ... }
 */
async function longTermReadAll(ws_id = WS_ID) {
  const fields = await redis.smembers(KEY_WS_INDEX(ws_id));
  if (!fields.length) return {};

  const pipeline = redis.pipeline();
  fields.forEach(f => pipeline.get(KEY_WS(ws_id, f)));
  const results = await pipeline.exec();

  const out = {};
  fields.forEach((field, i) => {
    const [err, raw] = results[i];
    if (!err && raw) {
      try { out[field] = JSON.parse(raw); } catch { out[field] = raw; }
    }
  });
  return out;
}

/**
 * Bulk write workspace memory from an object.
 * Called when WP sends workspace settings to runtime.
 */
async function longTermWriteAll(fields_obj, ws_id = WS_ID) {
  for (const [field, value] of Object.entries(fields_obj)) {
    if (value !== null && value !== undefined) {
      await longTermWrite(field, value, ws_id);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// AGENT CONTEXT MEMORY
// Per-agent learned context within a workspace (preferences, tone notes, etc.)
// ─────────────────────────────────────────────────────────────────────

async function agentContextWrite(agent_id, data, ws_id = WS_ID) {
  const key = KEY_AGENT_CTX(ws_id, agent_id);
  const existing = await agentContextRead(agent_id, ws_id) || {};
  const merged = { ...existing, ...data, updated_at: Math.floor(Date.now() / 1000) };
  await redis.set(key, JSON.stringify(merged), 'EX', TTL_TASK);
}

async function agentContextRead(agent_id, ws_id = WS_ID) {
  const raw = await redis.get(KEY_AGENT_CTX(ws_id, agent_id));
  return raw ? JSON.parse(raw) : null;
}

// ─────────────────────────────────────────────────────────────────────
// MEMORY RETRIEVAL — called before dispatch
// Returns a memory packet to inject into task context
// ─────────────────────────────────────────────────────────────────────

/**
 * Retrieve all relevant memory for a task before execution.
 * Returns: { workspace, recent_tasks, agent_context, short_term }
 */
async function retrieveForTask({ task_id, agent_id, title, tools = [], ws_id = WS_ID }) {
  const [workspace, recent_tasks, agent_context, short_term] = await Promise.all([
    longTermReadAll(ws_id),
    recentTaskMemory(8),
    agentContextRead(agent_id, ws_id),
    shortTermRead(task_id),
  ]);

  // Filter recent tasks to those relevant to this agent or overlapping tools
  const relevant_recent = recent_tasks.filter(t =>
    t.agent_id === agent_id ||
    (t.tools || []).some(tool => tools.includes(tool))
  ).slice(0, 5);

  return {
    workspace,
    recent_tasks:  relevant_recent,
    agent_context: agent_context || {},
    short_term:    short_term || {},
    retrieved_at:  Math.floor(Date.now() / 1000),
  };
}

module.exports = {
  // Short-term
  shortTermWrite,
  shortTermRead,
  shortTermAppend,
  shortTermDelete,
  // Task
  taskMemoryWrite,
  taskMemoryRead,
  recentTaskMemory,
  // Long-term
  longTermWrite,
  longTermRead,
  longTermReadAll,
  longTermWriteAll,
  // Agent context
  agentContextWrite,
  agentContextRead,
  // Retrieval
  retrieveForTask,
  // Constants
  WS_ID,
};
