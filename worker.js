'use strict';

/**
 * LevelUp BullMQ Worker — Sprint A
 *
 * This is where tasks actually execute.
 * Flow per job:
 *   1. Pull job from 'levelup-tasks' queue
 *   2. Pass through governance gate
 *   3. If allowed → execute tool via registry
 *   4. Write result to memory (via WP callback)
 *   5. Send callback to WordPress with result
 */

require('dotenv').config();

const { Worker } = require('bullmq');
const axios      = require('axios');
const { createRedisConnection } = require('./redis');
const { evaluateGovernance }    = require('./governance');
const registry                  = require('./registry');

const WORKER_CONCURRENCY = 3; // Process up to 3 jobs simultaneously

const worker = new Worker(
    'levelup-tasks',
    async (job) => {
        const data    = job.data;
        const taskId  = data.task_id;
        const tool    = data.tool_name;
        const agentId = data.agent_id;

        console.log(`\n[WORKER] ── Job started ─────────────────────────────────`);
        console.log(`[WORKER] task_id    : ${taskId}`);
        console.log(`[WORKER] tool       : ${tool}`);
        console.log(`[WORKER] agent      : ${agentId}`);
        console.log(`[WORKER] workspace  : ${data.workspace_id}`);
        console.log(`[WORKER] attempt    : ${job.attemptsMade + 1}`);

        // ── Step 1: Governance Gate ────────────────────────────────────
        console.log(`[WORKER] Evaluating governance (tier ${data.governance_tier})…`);
        const govDecision = evaluateGovernance(data);

        if (!govDecision.allowed) {
            console.warn(`[WORKER] BLOCKED by governance: ${govDecision.action}`);
            // Notify WordPress that task was blocked
            await sendCallback(data, {
                success:          false,
                error:            `Task blocked by governance: ${govDecision.action}`,
                governance_record: govDecision.record,
                result:           null,
            });
            return { blocked: true, governance: govDecision };
        }

        console.log(`[WORKER] Governance: ${govDecision.action} ✓`);

        // ── Step 2: Execute Tool ───────────────────────────────────────
        console.log(`[WORKER] Executing tool: ${tool}…`);

        const context = {
            task_id:      taskId,
            agent_id:     agentId,
            workspace_id: data.workspace_id,
        };

        const toolResult = await registry.execute(tool, data.payload || {}, context);

        console.log(`[WORKER] Tool result: success=${toolResult.success} | ${toolResult.execution_ms}ms`);

        // ── Step 3: Callback to WordPress ─────────────────────────────
        console.log(`[WORKER] Sending callback to WordPress…`);

        await sendCallback(data, {
            success:           toolResult.success,
            result:            toolResult.data,
            error:             toolResult.error || null,
            execution_ms:      toolResult.execution_ms,
            memory_hint:       toolResult.memory_hint,
            governance_record: govDecision.record,
        });

        console.log(`[WORKER] ── Job complete ────────────────────────────────\n`);

        return {
            task_id:  taskId,
            success:  toolResult.success,
            tool,
            execution_ms: toolResult.execution_ms,
        };
    },
    {
        connection:  createRedisConnection(),
        concurrency: WORKER_CONCURRENCY,
    }
);

// ── Send result callback to WordPress ─────────────────────────────────────
async function sendCallback(jobData, payload) {
    const callbackUrl    = jobData.callback_url;
    const callbackSecret = jobData.callback_secret || process.env.WP_SECRET;

    if (!callbackUrl) {
        console.warn('[WORKER] No callback_url in job data — result not sent to WordPress.');
        return;
    }

    const body = {
        task_id:           jobData.task_id,
        success:           payload.success,
        result:            payload.result   || null,
        error:             payload.error    || null,
        execution_ms:      payload.execution_ms || 0,
        memory_hint:       payload.memory_hint  || null,
        governance_record: payload.governance_record || null,
        completed_at:      new Date().toISOString(),
    };

    try {
        const response = await axios.post(callbackUrl, body, {
            timeout: 15000,
            headers: {
                'Content-Type':     'application/json',
                'X-LevelUp-Secret': callbackSecret,
            },
        });

        console.log(`[CALLBACK] WordPress responded: ${response.status}`);

    } catch (err) {
        // Log but don't fail the job — the task completed even if WP callback fails
        if (err.response) {
            console.error(`[CALLBACK] WordPress returned ${err.response.status}: ${JSON.stringify(err.response.data)}`);
        } else {
            console.error(`[CALLBACK] Failed to reach WordPress: ${err.message}`);
        }
    }
}

// ── Worker Event Handlers ──────────────────────────────────────────────────
worker.on('completed', (job, result) => {
    console.log(`[WORKER] ✓ Completed job ${job.id} | task=${result.task_id}`);
});

worker.on('failed', (job, err) => {
    console.error(`[WORKER] ✗ Job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`);
});

worker.on('error', (err) => {
    console.error(`[WORKER] Worker error: ${err.message}`);
});

worker.on('stalled', (jobId) => {
    console.warn(`[WORKER] Job ${jobId} stalled — will be retried`);
});

console.log(`[WORKER] BullMQ worker started | concurrency=${WORKER_CONCURRENCY} | queue=levelup-tasks`);

module.exports = worker;
