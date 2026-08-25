'use strict';

/**
 * WORKSPACE_MEMORY — Persistent memory across all meetings
 * Agents reference this in every meeting to build on past context.
 */

const { createRedisConnection } = require('./redis');
const redis = createRedisConnection();
const TTL   = 86400 * 90; // 90 days
const mkey  = (workspaceId) => `workspace:${workspaceId}:memory`;

const EMPTY_MEMORY = () => ({
    business_profile:     {},   // { name, website, industry, size, location }
    target_audience:      [],   // audience segments discovered
    brand_positioning:    '',   // brand positioning statement
    key_strategies:       [],   // strategies validated across meetings
    previous_campaigns:   [],   // { topic, date, outcome } AND { task_id, agent, title, summary, engine, status, date }
    successful_content:   [],   // content types/topics that worked
    channel_performance:  {},   // { channel: "notes on what worked" }
    competitor_intel:     [],   // competitor observations
    vocabulary:           [],   // brand terms, client-specific language
    learned_patterns:     [],   // Intervention 1: heuristic-promoted patterns from repeated task success
    updated_at:           null,
    meeting_count:        0,
});

async function getMemory(workspaceId = 1) {
    try {
        const r = await redis.get(mkey(workspaceId));
        return r ? JSON.parse(r) : EMPTY_MEMORY();
    } catch(e) {
        return EMPTY_MEMORY();
    }
}

async function saveMemory(workspaceId, memory) {
    try {
        memory.updated_at = new Date().toISOString();
        await redis.set(mkey(workspaceId), JSON.stringify(memory), 'EX', TTL);
    } catch(e) {
        console.error('[MEMORY] save failed:', e.message);
    }
}

async function updateFromMeeting(workspaceId, meetingData) {
    const m = await getMemory(workspaceId);
    m.meeting_count = (m.meeting_count || 0) + 1;

    // ── Governance: upsert ALL 8 profile fields — WP values always override ──
    if (meetingData.businessName)    m.business_profile.name            = meetingData.businessName;
    if (meetingData.business_name)   m.business_profile.name            = meetingData.business_name;
    if (meetingData.website)         m.business_profile.website         = meetingData.website;
    if (meetingData.industry)        m.business_profile.industry        = meetingData.industry;
    if (meetingData.location)        m.business_profile.location        = meetingData.location;
    if (meetingData.brand_voice)     m.business_profile.brand_voice     = meetingData.brand_voice;
    if (meetingData.target_audience) m.business_profile.target_audience = meetingData.target_audience;
    if (meetingData.competitors)     m.business_profile.competitors     = meetingData.competitors;
    if (meetingData.business_desc)   m.business_profile.description     = meetingData.business_desc;
    // Services: prefer array, fall back to existing
    const svcs = Array.isArray(meetingData.services) && meetingData.services.length
        ? meetingData.services : null;
    if (svcs) m.business_profile.services = svcs;

    // Record campaign
    if (meetingData.topic) {
        const existing = m.previous_campaigns.find(c => c.topic === meetingData.topic);
        if (!existing) {
            m.previous_campaigns.push({
                topic: meetingData.topic,
                date: new Date().toISOString(),
                meeting_id: meetingData.meeting_id,
            });
        }
        // Keep last 20 campaigns
        if (m.previous_campaigns.length > 20) m.previous_campaigns = m.previous_campaigns.slice(-20);
    }

    // Absorb validated strategies
    if (meetingData.validated_ideas?.length) {
        meetingData.validated_ideas.forEach(idea => {
            if (!m.key_strategies.includes(idea)) m.key_strategies.push(idea);
        });
        if (m.key_strategies.length > 30) m.key_strategies = m.key_strategies.slice(-30);
    }

    await saveMemory(workspaceId, m);
    return m;
}

// ── Intervention 1: episodic + heuristic memory write on task completion ──
// Called from task-worker.js after saveDeliverable(). Adds task to previous_campaigns,
// promotes repeated agent/engine/content_type combos to learned_patterns with a
// confidence score. Wrapped in try/catch by the caller — never throws.
async function updateFromTask(workspaceId, taskData) {
    const m = await getMemory(workspaceId);

    // ── Episodic: record this task ──────────────────────────────
    if (taskData.task_id) {
        m.previous_campaigns = m.previous_campaigns || [];
        const exists = m.previous_campaigns.find(c => c.task_id === taskData.task_id);
        if (!exists) {
            m.previous_campaigns.push({
                task_id:  taskData.task_id,
                agent:    taskData.agent,
                title:    taskData.title,
                summary:  taskData.summary || '',
                engine:   taskData.engine  || '',
                status:   taskData.status  || 'completed',
                date:     new Date().toISOString(),
            });
            // Keep last 20
            if (m.previous_campaigns.length > 20)
                m.previous_campaigns = m.previous_campaigns.slice(-20);
        }
    }

    // ── Heuristic promotion: repeated patterns ──────────────────
    // If same agent + engine/content_type appears 3+ times → promote
    m.learned_patterns = m.learned_patterns || [];
    if (taskData.status === 'completed' && taskData.content_type) {
        const matchCount = (m.previous_campaigns || []).filter(c =>
            c.agent === taskData.agent &&
            (c.engine === taskData.engine || (c.title || '').includes(taskData.content_type))
        ).length;

        if (matchCount >= 3) {
            const patternKey = `${taskData.agent}:${taskData.engine}:${taskData.content_type}`;
            const existing = m.learned_patterns.find(p => p.key === patternKey);
            if (existing) {
                existing.confidence = Math.min(1.0, existing.confidence + 0.05);
                existing.last_seen  = new Date().toISOString();
            } else {
                m.learned_patterns.push({
                    key:         patternKey,
                    agent:       taskData.agent,
                    engine:      taskData.engine,
                    pattern:     `${taskData.agent} consistently succeeds at ${taskData.content_type}`,
                    confidence:  0.6,
                    source_task: taskData.task_id,
                    first_seen:  new Date().toISOString(),
                    last_seen:   new Date().toISOString(),
                });
            }
            // Keep last 50 patterns
            if (m.learned_patterns.length > 50)
                m.learned_patterns = m.learned_patterns.slice(-50);
        }
    }

    // ── Content success tracking ────────────────────────────────
    if (taskData.status === 'completed' && taskData.content_type) {
        m.successful_content = m.successful_content || [];
        if (!m.successful_content.includes(taskData.content_type)) {
            m.successful_content.push(taskData.content_type);
        }
    }

    await saveMemory(workspaceId, m);
    return m;
}

async function updateAudienceInsight(workspaceId, insight) {
    const m = await getMemory(workspaceId);
    if (!m.target_audience.includes(insight)) {
        m.target_audience.push(insight);
        if (m.target_audience.length > 15) m.target_audience = m.target_audience.slice(-15);
        await saveMemory(workspaceId, m);
    }
}

function formatMemoryForPrompt(memory) {
    if (!memory) return '';
    const parts = ['WORKSPACE MEMORY (persistent context from past meetings):'];
    const biz = memory.business_profile;
    if (biz?.name) {
        let bizLine = `BUSINESS: ${biz.name}`;
        if (biz.industry)  bizLine += ` — ${biz.industry}`;
        if (biz.location)  bizLine += ` | Location: ${biz.location}`;
        if (biz.website)   bizLine += ` (${biz.website})`;
        parts.push(bizLine);
        if (biz.description)     parts.push(`Description: ${biz.description}`);
        if (biz.brand_voice)     parts.push(`Brand voice: ${biz.brand_voice}`);
        if (biz.target_audience) parts.push(`Target audience: ${biz.target_audience}`);
        if (biz.competitors)     parts.push(`Key competitors: ${biz.competitors}`);
        if (Array.isArray(biz.services) && biz.services.length)
            parts.push(`Services:\n${biz.services.map(s=>`  • ${s}`).join('\n')}`);
    }
    if (memory.target_audience?.length)
        parts.push(`AUDIENCE SEGMENTS:\n${memory.target_audience.map(a=>`• ${a}`).join('\n')}`);
    if (memory.brand_positioning)
        parts.push(`BRAND POSITIONING: ${memory.brand_positioning}`);
    if (memory.key_strategies?.length)
        parts.push(`PROVEN STRATEGIES:\n${memory.key_strategies.slice(-8).map(s=>`✓ ${s}`).join('\n')}`);
    // Intervention 1: surface heuristic-promoted patterns (confidence >= 0.7)
    if (memory.learned_patterns?.length) {
        const highConf = memory.learned_patterns
            .filter(p => p.confidence >= 0.7)
            .slice(-5);
        if (highConf.length) {
            parts.push(
                'LEARNED HEURISTICS (high-confidence patterns):\n' +
                highConf.map(p => `⚡ ${p.pattern} (confidence: ${Math.round(p.confidence*100)}%)`).join('\n')
            );
        }
    }
    if (memory.previous_campaigns?.length) {
        const recent = memory.previous_campaigns.slice(-5);
        parts.push(`RECENT MEETINGS:\n${recent.map(c=>`• ${c.topic} (${new Date(c.date).toLocaleDateString()})`).join('\n')}`);
    }
    if (memory.channel_performance && Object.keys(memory.channel_performance).length)
        parts.push(`CHANNEL NOTES:\n${Object.entries(memory.channel_performance).map(([ch,n])=>`• ${ch}: ${n}`).join('\n')}`);
    return parts.length > 1 ? parts.join('\n\n') : '';
}

module.exports = { getMemory, saveMemory, updateFromMeeting, updateFromTask, updateAudienceInsight, formatMemoryForPrompt };
