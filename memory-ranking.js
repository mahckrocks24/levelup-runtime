'use strict';

/**
 * LevelUp — Semantic Memory Ranking
 * Phase 4: Score and rank past memories by relevance to current query.
 *
 * No external ML — uses keyword overlap, tool overlap, recency, and agent match.
 * Scoring is deterministic and fast (pure JS, no API calls).
 *
 * Usage:
 *   const { rankMemories, formatRankedMemory } = require('./memory-ranking');
 *   const top = rankMemories(query, agentId, tools, recentTasks);
 *   const block = formatRankedMemory(top);
 */

// ── Stop words to exclude from keyword extraction ─────────────────────────
const STOP_WORDS = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','with',
  'by','from','is','it','we','our','us','this','that','what','how','why',
  'do','can','should','would','could','will','have','has','been','are','was',
  'were','be','as','if','than','then','so','about','into','more','my','your',
  'their','its','he','she','they','who','when','where','which','all','any',
  'both','each','no','not','just','also','make','get','use','per','new',
]);

function extractKeywords(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOP_WORDS.has(w));
}

function keywordOverlap(kwA, kwB) {
  if (!kwA.length || !kwB.length) return 0;
  const setA = new Set(kwA);
  const matches = kwB.filter(w => setA.has(w)).length;
  return matches / Math.max(kwA.length, kwB.length);
}

function toolOverlap(toolsA = [], toolsB = []) {
  if (!toolsA.length || !toolsB.length) return 0;
  const setA = new Set(toolsA);
  const matches = toolsB.filter(t => setA.has(t)).length;
  return matches / Math.max(toolsA.length, toolsB.length);
}

function recencyScore(completedAt) {
  // completedAt: Unix timestamp (seconds). Score decays over 30 days.
  if (!completedAt) return 0;
  const ageSecs  = Math.floor(Date.now() / 1000) - completedAt;
  const ageDays  = ageSecs / 86400;
  if (ageDays <= 1)  return 1.0;
  if (ageDays <= 7)  return 0.8;
  if (ageDays <= 14) return 0.6;
  if (ageDays <= 30) return 0.4;
  return 0.2;
}

/**
 * Score a single memory record against a query.
 *
 * @param {object} memory   — task memory record { title, tools, agent_id, output_summary, completed_at }
 * @param {string[]} queryKw  — keywords extracted from the current query
 * @param {string}  agentId — current agent_id
 * @param {string[]} queryTools — tools mentioned or expected for the current task
 * @returns {number} — 0–1 composite score
 */
function scoreMemory(memory, queryKw, agentId, queryTools) {
  const memKw    = extractKeywords((memory.title || '') + ' ' + (memory.output_summary || ''));
  const kwScore  = keywordOverlap(queryKw, memKw);
  const toolScore = toolOverlap(queryTools, memory.tools || []);
  const rec      = recencyScore(memory.completed_at);
  const agentMatch = memory.agent_id === agentId ? 0.2 : 0;

  // Weighted composite: keyword=40%, tool=30%, recency=20%, agent=10%
  return (kwScore * 0.4) + (toolScore * 0.3) + (rec * 0.2) + agentMatch;
}

/**
 * Rank an array of task memory records by relevance to current context.
 * Returns top N sorted by score descending.
 *
 * @param {string}   query      — current question or task title
 * @param {string}   agentId    — current agent
 * @param {string[]} queryTools — tools expected for this task
 * @param {object[]} memories   — array of task memory records
 * @param {number}   topN       — max records to return (default 5)
 */
function rankMemories(query, agentId, queryTools = [], memories = [], topN = 5) {
  if (!memories.length) return [];
  const queryKw = extractKeywords(query);

  const scored = memories
    .map(m => ({ ...m, _score: scoreMemory(m, queryKw, agentId, queryTools) }))
    .filter(m => m._score > 0.05)       // discard unrelated memories
    .sort((a, b) => b._score - a._score)
    .slice(0, topN);

  return scored;
}

/**
 * Format ranked memories as a prompt block.
 */
function formatRankedMemory(rankedMemories, heading = 'MOST RELEVANT PAST INSIGHTS') {
  if (!rankedMemories.length) return '';
  const lines = [`${heading}:`];
  for (const m of rankedMemories) {
    const when  = m.completed_at
      ? new Date(m.completed_at * 1000).toLocaleDateString('en-GB', { day:'numeric', month:'short' })
      : 'earlier';
    const score = Math.round((m._score || 0) * 100);
    const tools = m.tools?.length ? ` [${m.tools.slice(0,2).join(', ')}]` : '';
    lines.push(`  • [${when}${tools}] ${m.title}: ${m.output_summary || '(no summary)'}`);
  }
  lines.push('Reference these insights. Do not repeat work already done unless the context has changed.');
  return lines.join('\n');
}

/**
 * Score and rank workspace long-term memory fields by relevance to current query.
 * Returns: { field: value, score } sorted desc.
 */
function rankWorkspaceMemory(query, memoryObj = {}) {
  const queryKw = extractKeywords(query);
  const scored  = Object.entries(memoryObj)
    .filter(([, v]) => v && typeof v === 'string' && v.length > 10)
    .map(([field, value]) => {
      const fieldKw = extractKeywords(field + ' ' + value);
      return { field, value, score: keywordOverlap(queryKw, fieldKw) };
    })
    .filter(e => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);
  return scored;
}

module.exports = { rankMemories, formatRankedMemory, rankWorkspaceMemory, extractKeywords };
