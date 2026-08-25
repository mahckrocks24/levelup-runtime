'use strict';

/**
 * MEETING_STATE — Shared Intelligence Board
 * All agents read this before responding. Updated as insights emerge.
 */

const { createRedisConnection } = require('./redis');
const redis = createRedisConnection();
const TTL   = 86400 * 7;
const skey  = id => `meeting:${id}:state`;

const EMPTY_STATE = () => ({
    key_insights:        [],  // confirmed strategic insights
    open_questions:      [],  // unresolved questions needing answers
    proposed_strategies: [],  // strategies put on the table
    validated_ideas:     [],  // ideas the team agreed on
    disagreements:       [],  // active tensions between agents
    tasks_generated:     [],  // task titles already extracted
    files_uploaded:      [],  // { name, type, url, uploaded_at }
    agent_positions:     {},  // { agentId: "their current stance" }
    last_updated_by:     null,
    turn_count:          0,
    agent_response_count: 0,
});

async function getState(meetingId) {
    try {
        const r = await redis.get(skey(meetingId));
        return r ? JSON.parse(r) : EMPTY_STATE();
    } catch(e) {
        return EMPTY_STATE();
    }
}

async function saveState(meetingId, state) {
    try {
        await redis.set(skey(meetingId), JSON.stringify(state), 'EX', TTL);
    } catch(e) {
        console.error('[STATE] save failed:', e.message);
    }
}

async function initState(meetingId) {
    const s = EMPTY_STATE();
    await saveState(meetingId, s);
    return s;
}

async function addInsight(meetingId, insight, agentId) {
    const s = await getState(meetingId);
    if (!s.key_insights.includes(insight)) {
        s.key_insights.push(insight);
        s.last_updated_by = agentId;
        await saveState(meetingId, s);
    }
}

async function addQuestion(meetingId, question) {
    const s = await getState(meetingId);
    if (!s.open_questions.includes(question)) {
        s.open_questions.push(question);
        await saveState(meetingId, s);
    }
}

async function addStrategy(meetingId, strategy, agentId) {
    const s = await getState(meetingId);
    const existing = s.proposed_strategies.find(x => x.strategy === strategy);
    if (!existing) {
        s.proposed_strategies.push({ strategy, proposed_by: agentId, votes: 1 });
        s.last_updated_by = agentId;
        await saveState(meetingId, s);
    } else {
        existing.votes = (existing.votes || 1) + 1;
        await saveState(meetingId, s);
    }
}

async function addDisagreement(meetingId, agentA, agentB, topic) {
    const s = await getState(meetingId);
    const key = `${agentA} vs ${agentB}: ${topic}`;
    if (!s.disagreements.includes(key)) {
        s.disagreements.push(key);
        await saveState(meetingId, s);
    }
}

async function validateIdea(meetingId, idea) {
    const s = await getState(meetingId);
    if (!s.validated_ideas.includes(idea)) {
        s.validated_ideas.push(idea);
        await saveState(meetingId, s);
    }
}

async function registerFile(meetingId, fileInfo) {
    const s = await getState(meetingId);
    s.files_uploaded.push({ ...fileInfo, uploaded_at: new Date().toISOString() });
    await saveState(meetingId, s);
}

async function setAgentPosition(meetingId, agentId, position) {
    const s = await getState(meetingId);
    if (!s.agent_positions) s.agent_positions = {};
    s.agent_positions[agentId] = position;
    await saveState(meetingId, s);
}

async function incrementTurn(meetingId) {
    const s = await getState(meetingId);
    s.turn_count = (s.turn_count || 0) + 1;
    s.agent_response_count = (s.agent_response_count || 0) + 1;
    await saveState(meetingId, s);
    return s;
}

function formatStateForPrompt(state) {
    if (!state) return '';
    const lines = ['SHARED MEETING INTELLIGENCE BOARD (read before responding):'];
    if (state.key_insights?.length)
        lines.push(`KEY INSIGHTS:\n${state.key_insights.map(i=>`• ${i}`).join('\n')}`);
    if (state.proposed_strategies?.length)
        lines.push(`PROPOSED STRATEGIES:\n${state.proposed_strategies.map(s=>`• ${s.strategy} (by ${s.proposed_by})`).join('\n')}`);
    if (state.validated_ideas?.length)
        lines.push(`VALIDATED IDEAS (team agreed):\n${state.validated_ideas.map(i=>`✓ ${i}`).join('\n')}`);
    if (state.disagreements?.length)
        lines.push(`ACTIVE TENSIONS (need resolution):\n${state.disagreements.map(d=>`⚡ ${d}`).join('\n')}`);
    if (state.open_questions?.length)
        lines.push(`OPEN QUESTIONS:\n${state.open_questions.map(q=>`? ${q}`).join('\n')}`);
    if (state.agent_positions && Object.keys(state.agent_positions).length)
        lines.push(`AGENT POSITIONS:\n${Object.entries(state.agent_positions).map(([a,p])=>`• ${a}: ${p}`).join('\n')}`);
    if (state.files_uploaded?.length)
        lines.push(`FILES IN MEETING:\n${state.files_uploaded.map(f=>`📎 ${f.name} (${f.type})`).join('\n')}`);
    return lines.length > 1 ? lines.join('\n\n') : '';
}

module.exports = {
    getState, saveState, initState,
    addInsight, addQuestion, addStrategy, addDisagreement, validateIdea,
    registerFile, setAgentPosition, incrementTurn,
    formatStateForPrompt,
};
