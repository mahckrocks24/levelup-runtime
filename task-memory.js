'use strict';

/**
 * Task Memory — Sprint D
 * Full task lifecycle store in Redis.
 * Replaces the flat lu_tasks WP option as the source of truth for status/history/deliverables.
 * WP options remain the approval inbox — once approved, tasks live here.
 */

const { createRedisConnection } = require('./redis');
const launchScope = require('./launch-scope');
const redis = createRedisConnection();
const TTL   = 86400 * 90; // 90 days

const tkey  = (wsId, taskId) => `task:${wsId}:${taskId}`;
const idxkey = wsId           => `tasks:${wsId}:index`;   // sorted set by created_at score

// ── Task status values ────────────────────────────────────────────────────
const STATUS = {
    BACKLOG:     'backlog',
    PLANNED:     'planned',
    IN_PROGRESS: 'in_progress',
    REVIEW:      'review',
    COMPLETED:   'completed',
};

// ── Agent deliverable schemas ─────────────────────────────────────────────
//
// LAUNCH SCOPE (2026-07-21, v2.37.3): the `marcus` social_plan schema was
// removed — it defined the shape of a deliverable (posting_cadence, paid
// strategy, platform mix) for work the product no longer does. Elena's
// lead_funnel dropped `nurture_sequence` for the same reason: it invited an
// email-drip deliverable from a retained agent.
const DELIVERABLE_SCHEMA = {
    james: {
        type: 'keyword_cluster',
        fields: ['keywords', 'primary_keyword', 'monthly_volume', 'difficulty', 'intent', 'serp_features', 'recommended_page_type'],
    },
    priya: {
        type: 'content_brief',
        fields: ['title', 'target_keyword', 'word_count', 'structure', 'cta', 'internal_links', 'tone', 'content_type'],
    },
    elena: {
        type: 'lead_funnel',
        fields: ['lead_magnet', 'capture_mechanism', 'lead_scoring', 'handoff_threshold', 'attribution'],
    },
    alex: {
        type: 'technical_audit',
        fields: ['issues', 'priority_fixes', 'core_web_vitals', 'schema_opportunities', 'crawl_notes'],
    },
    dmm: {
        type: 'strategy_summary',
        fields: ['objective', 'key_decisions', 'next_actions', 'success_metrics'],
    },
};

// ── CRUD ──────────────────────────────────────────────────────────────────
async function getTask(wsId, taskId) {
    try {
        const r = await redis.get(tkey(wsId, taskId));
        return r ? launchScope.markHistoricalRecord(JSON.parse(r)) : null;
    } catch(e) { return null; }
}

async function saveTask(wsId, task) {
    try {
        task.updated_at = new Date().toISOString();
        await redis.set(tkey(wsId, task.id), JSON.stringify(task), 'EX', TTL);
        // Keep sorted index by created timestamp
        const score = task.created_at ? new Date(task.created_at).getTime() : Date.now();
        await redis.zadd(idxkey(wsId), score, task.id);
    } catch(e) { console.error('[TASK-MEM] save:', e.message); }
}

// ── LAUNCH SCOPE COMPATIBILITY FILTER ─────────────────────────────────────
// Redis holds up to 90 days of task history, including tasks assigned to
// agents and tools that are no longer part of the product. That history is NOT
// erased — deleting it would corrupt the audit trail and break attribution on
// completed work. Instead every read is stamped: removed-agent / removed-tool
// records come back flagged `launch_scope_removed`, `executable: false`,
// `assignable: false`, so they survive as inert history but can never be
// re-planned, re-assigned, re-executed, or used to populate a meeting.
async function getAllTasks(wsId = 1) {
    try {
        const ids = await redis.zrevrange(idxkey(wsId), 0, -1);
        if (!ids.length) return [];
        const keys = ids.map(id => tkey(wsId, id));
        const raws = await redis.mget(...keys);
        return raws.filter(Boolean)
            .map(r => JSON.parse(r))
            .map(launchScope.markHistoricalRecord);
    } catch(e) { return []; }
}

async function getTasksByStatus(wsId, status) {
    const all = await getAllTasks(wsId);
    return all.filter(t => t.status === status);
}

/**
 * Tasks assigned to an agent. A removed agent always returns [] — stale
 * history must never make a launch-excluded agent look like it has a workload.
 */
async function getTasksByAssignee(wsId, agentId) {
    if (launchScope.isRemovedAgent(agentId)) return [];
    const all = await getAllTasks(wsId);
    return all.filter(t => t.assignee === agentId);
}

/** Historical tasks that may still influence routing, planning or execution. */
async function getExecutableTasks(wsId = 1) {
    const all = await getAllTasks(wsId);
    return all.filter(launchScope.isExecutableRecord);
}

// ── Import approved tasks from WP ─────────────────────────────────────────
async function importApprovedTask(wsId, wpTask) {
    // LAUNCH SCOPE: refuse to admit new work for a removed agent. Laravel
    // already guards this at TaskService::create; this is the runtime-side
    // safety net for anything arriving through an older approval payload.
    if (launchScope.isRemovedAgent(wpTask?.assignee)) {
        console.warn(`[TASK-MEM] Refused import of task ${wpTask?.id}: assignee '${wpTask?.assignee}' is not available at launch`);
        return null;
    }

    const existing = await getTask(wsId, wpTask.id);
    if (existing) return existing; // already imported

    const task = {
        id:              wpTask.id,
        title:           wpTask.title,
        description:     wpTask.description,
        assignee:        wpTask.assignee,
        coordinator:     wpTask.coordinator || null,
        priority:        wpTask.priority || 'medium',
        estimated_time:  wpTask.estimated_time || 60,
        estimated_tokens: wpTask.estimated_tokens || 5000,
        success_metric:  wpTask.success_metric || '',
        meeting_id:      wpTask.meeting_id || null,
        status:          STATUS.PLANNED,
        history: [
            { status: STATUS.PLANNED, at: new Date().toISOString(), by: 'system', note: 'Approved and moved to Projects' }
        ],
        notes:           [],
        deliverable:     null,
        created_at:      wpTask.approved_at || new Date().toISOString(),
        workspace_id:    wsId,
    };

    await saveTask(wsId, task);
    return task;
}

// ── Status transition ─────────────────────────────────────────────────────
async function updateStatus(wsId, taskId, newStatus, meta = {}) {
    const task = await getTask(wsId, taskId);
    if (!task) return null;

    const oldStatus = task.status;
    task.status = newStatus;
    task.history = task.history || [];
    task.history.push({
        status: newStatus,
        from:   oldStatus,
        at:     new Date().toISOString(),
        by:     meta.by || 'user',
        note:   meta.note || '',
    });

    if (newStatus === STATUS.IN_PROGRESS) task.started_at = new Date().toISOString();
    if (newStatus === STATUS.COMPLETED)   task.completed_at = new Date().toISOString();

    await saveTask(wsId, task);
    return { task, oldStatus };
}

// ── Notes ─────────────────────────────────────────────────────────────────
async function addNote(wsId, taskId, note) {
    const task = await getTask(wsId, taskId);
    if (!task) return null;
    if (!task.notes) task.notes = [];
    task.notes.push({
        ...note,
        id:  `note_${Date.now()}`,
        at:  new Date().toISOString(),
    });
    await saveTask(wsId, task);
    return task;
}

// ── Deliverable ───────────────────────────────────────────────────────────
async function saveDeliverable(wsId, taskId, deliverable) {
    const task = await getTask(wsId, taskId);
    if (!task) return null;
    task.deliverable = {
        ...deliverable,
        saved_at: new Date().toISOString(),
    };
    task.status = STATUS.REVIEW;
    task.history = task.history || [];
    task.history.push({
        status: STATUS.REVIEW,
        from:   STATUS.IN_PROGRESS,
        at:     new Date().toISOString(),
        by:     task.assignee,
        note:   'Deliverable submitted — moved to Review',
    });
    await saveTask(wsId, task);
    return task;
}

function getDeliverableSchema(agentId) {
    if (launchScope.isRemovedAgent(agentId)) return null;
    return DELIVERABLE_SCHEMA[agentId] || DELIVERABLE_SCHEMA.dmm;
}

module.exports = {
    STATUS, DELIVERABLE_SCHEMA,
    getTask, saveTask, getAllTasks, getTasksByStatus, getTasksByAssignee,
    getExecutableTasks,
    importApprovedTask, updateStatus, addNote, saveDeliverable, getDeliverableSchema,
};
