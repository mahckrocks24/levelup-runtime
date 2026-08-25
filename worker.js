'use strict';

require('dotenv').config();

const { Worker } = require('bullmq');
const axios      = require('axios');
const { createRedisConnection } = require('./redis');
const { evaluateGovernance }    = require('./governance');
const registry                  = require('./registry');

const WORKER_CONCURRENCY = 3;

const worker = new Worker(
    'levelup-tasks',
    async (job) => {
        const data    = job.data;
        const taskId  = data.task_id;
        const tool    = data.tool_name;
        const agentId = data.agent_id;

        console.log(`\n[WORKER] ── Job started ──────────────────────────`);
        console.log(`[WORKER] task_id   : ${taskId}`);
        console.log(`[WORKER] tool      : ${tool}`);
        console.log(`[WORKER] agent     : ${agentId}`);
        console.log(`[WORKER] attempt   : ${job.attemptsMade + 1}`);

        // Step 1: Governance Gate
        const govDecision = evaluateGovernance(data);
        console.log(`[WORKER] Governance: ${govDecision.action}`);

        if (!govDecision.allowed) {
            await sendCallback(data, {
                success:           false,
                error:             `Blocked by governance: ${govDecision.action}`,
                governance_record: govDecision.record,
                result:            null,
            });
            return { blocked: true, governance: govDecision };
        }

        // Step 2: Execute Tool
        console.log(`[WORKER] Executing tool: ${tool}…`);
        const context = {
            task_id:      taskId,
            agent_id:     agentId,
            workspace_id: data.workspace_id,
        };

        const toolResult = await registry.execute(tool, data.payload || {}, context);
        console.log(`[WORKER] Tool: success=${toolResult.success} | ${toolResult.execution_ms}ms`);

        // Step 3: Callback to WordPress
        await sendCallback(data, {
            success:           toolResult.success,
            result:            toolResult.data,
            error:             toolResult.error || null,
            execution_ms:      toolResult.execution_ms,
            memory_hint:       toolResult.memory_hint,
            governance_record: govDecision.record,
        });

        console.log(`[WORKER] ── Job complete ──────────────────────────\n`);
        return { task_id: taskId, success: toolResult.success, tool };
    },
    {
        connection:  createRedisConnection(),
        concurrency: WORKER_CONCURRENCY,
    }
);

async function sendCallback(jobData, payload) {
    const callbackUrl    = jobData.callback_url;
    const callbackSecret = jobData.callback_secret || process.env.WP_SECRET;

    if (!callbackUrl) {
        console.warn('[WORKER] No callback_url — result not sent to WordPress.');
        return;
    }

    try {
        const response = await axios.post(callbackUrl, {
            task_id:           jobData.task_id,
            success:           payload.success,
            result:            payload.result   || null,
            error:             payload.error    || null,
            execution_ms:      payload.execution_ms || 0,
            memory_hint:       payload.memory_hint  || null,
            governance_record: payload.governance_record || null,
            completed_at:      new Date().toISOString(),
        }, {
            timeout: 15000,
            headers: {
                'Content-Type':     'application/json',
                'X-LevelUp-Secret': callbackSecret,
            },
        });
        console.log(`[CALLBACK] WordPress responded: ${response.status}`);
    } catch (err) {
        console.error(`[CALLBACK] Failed: ${err.response?.status || err.message}`);
    }
}

worker.on('completed', (job, result) => console.log(`[WORKER] ✓ Job ${job.id} complete`));
worker.on('failed',    (job, err)    => console.error(`[WORKER] ✗ Job ${job?.id} failed: ${err.message}`));
worker.on('error',     (err)         => console.error(`[WORKER] Error: ${err.message}`));

console.log(`[WORKER] BullMQ worker started | concurrency=${WORKER_CONCURRENCY}`);

module.exports = worker;
