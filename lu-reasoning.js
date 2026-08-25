/**
 * LevelUp — Agent Reasoning Trace
 *
 * Stores structured reasoning data per task for debugging,
 * transparency, and future UI components.
 *
 * Redis key: lu:trace:{task_id}
 * TTL: 90 days (matches task memory TTL)
 *
 * Structure:
 * {
 *   task_id, agent_id, title,
 *   agent_thoughts:    string   — agent's reasoning before execution
 *   task_plan:         object[] — steps the agent planned
 *   context_used:      object   — workspace context injected
 *   memory_used:       object   — memory packet used
 *   execution_steps:   object[] — each step with result
 *   tool_outputs:      object[] — raw tool results
 *   collaboration:     object[] — delegation messages
 *   synthesis_prompt:  string   — prompt sent to LLM for synthesis
 *   output_summary:    string   — final output summary
 *   started_at, finished_at, duration_ms
 * }
 */

'use strict';

const { redis } = require('./lu-lifecycle');

const TRACE_TTL = 90 * 24 * 60 * 60;  // 90 days
const KEY_TRACE = (task_id) => `lu:trace:${task_id}`;

// ─────────────────────────────────────────────────────────────────────
// TRACE LIFECYCLE
// ─────────────────────────────────────────────────────────────────────

async function traceInit(task_id, { agent_id, title, context_used, memory_used }) {
  const trace = {
    task_id,
    agent_id,
    title:            title || task_id,
    agent_thoughts:   null,
    task_plan:        [],
    context_used:     context_used || {},
    memory_used:      memory_used  || {},
    execution_steps:  [],
    tool_outputs:     [],
    collaboration:    [],
    synthesis_prompt: null,
    output_summary:   null,
    started_at:       Math.floor(Date.now() / 1000),
    finished_at:      null,
    duration_ms:      null,
  };
  await redis.set(KEY_TRACE(task_id), JSON.stringify(trace), 'EX', TRACE_TTL);
  return trace;
}

async function traceRead(task_id) {
  const raw = await redis.get(KEY_TRACE(task_id));
  return raw ? JSON.parse(raw) : null;
}

async function traceUpdate(task_id, updates) {
  const existing = await traceRead(task_id);
  if (!existing) return null;
  const updated = { ...existing, ...updates };
  await redis.set(KEY_TRACE(task_id), JSON.stringify(updated), 'EX', TRACE_TTL);
  return updated;
}

async function traceFinalize(task_id, { output_summary, duration_ms }) {
  return traceUpdate(task_id, {
    output_summary,
    duration_ms,
    finished_at: Math.floor(Date.now() / 1000),
  });
}

// ─────────────────────────────────────────────────────────────────────
// APPEND HELPERS — add to array fields without rewriting full trace
// ─────────────────────────────────────────────────────────────────────

async function traceAppendStep(task_id, step) {
  const trace = await traceRead(task_id);
  if (!trace) return;
  trace.execution_steps.push({ ...step, ts: Math.floor(Date.now() / 1000) });
  await redis.set(KEY_TRACE(task_id), JSON.stringify(trace), 'EX', TRACE_TTL);
}

async function traceAppendToolOutput(task_id, tool_result) {
  const trace = await traceRead(task_id);
  if (!trace) return;
  trace.tool_outputs.push(tool_result);
  await redis.set(KEY_TRACE(task_id), JSON.stringify(trace), 'EX', TRACE_TTL);
}

async function traceAppendCollaboration(task_id, message) {
  const trace = await traceRead(task_id);
  if (!trace) return;
  trace.collaboration.push({ ...message, ts: Math.floor(Date.now() / 1000) });
  await redis.set(KEY_TRACE(task_id), JSON.stringify(trace), 'EX', TRACE_TTL);
}

module.exports = {
  traceInit,
  traceRead,
  traceUpdate,
  traceFinalize,
  traceAppendStep,
  traceAppendToolOutput,
  traceAppendCollaboration,
};
