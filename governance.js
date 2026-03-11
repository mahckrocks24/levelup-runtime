'use strict';

/**
 * LevelUp Governance Gate — Sprint A
 *
 * Every tool execution passes through here before running.
 * Returns a decision object the worker uses to proceed, queue, or block.
 *
 * Tier definitions:
 *   0 — Auto-execute.   No notification. Proceeds immediately.
 *   1 — Notify only.    Executes immediately, WP notified after.
 *   2 — Approve first.  Queued for user approval. (Sprint B+)
 *   3 — Explicit only.  Hard stop. Requires explicit confirmation. (Sprint B+)
 *   4 — Super Admin.    BOSS888 only. (Sprint G+)
 */

const GOVERNANCE_TIERS = {
    AUTO:         0,
    NOTIFY:       1,
    APPROVE:      2,
    EXPLICIT:     3,
    SUPER_ADMIN:  4,
};

/**
 * Evaluate a task against the governance rules.
 *
 * @param {object} job  BullMQ job data
 * @returns {object}    { allowed: bool, tier: number, action: string, record: object }
 */
function evaluateGovernance(job) {
    const tier     = job.governance_tier ?? GOVERNANCE_TIERS.AUTO;
    const tool     = job.tool_name;
    const agent    = job.agent_id;
    const taskId   = job.task_id;

    console.log(`[GOVERNANCE] task=${taskId} tool=${tool} agent=${agent} tier=${tier}`);

    const record = {
        task_id:     taskId,
        tier,
        description: `Agent '${agent}' wants to execute tool '${tool}'`,
        evaluated_at: new Date().toISOString(),
    };

    // Sprint A: Tiers 0 and 1 auto-proceed.
    // Tiers 2+ will be wired to user approval flows in Sprint B.
    switch (tier) {
        case GOVERNANCE_TIERS.AUTO:
            return {
                allowed: true,
                tier,
                action:  'auto_approved',
                record:  { ...record, status: 'auto_approved', note: 'Tier 0 — auto-execute' },
            };

        case GOVERNANCE_TIERS.NOTIFY:
            return {
                allowed: true,
                tier,
                action:  'execute_and_notify',
                record:  { ...record, status: 'auto_approved', note: 'Tier 1 — execute, notify user after' },
            };

        case GOVERNANCE_TIERS.APPROVE:
            // Sprint A: log as blocked, return not allowed
            // Sprint B: this queues an approval request to WordPress
            console.warn(`[GOVERNANCE] BLOCKED — tier 2 approval required for task ${taskId}`);
            return {
                allowed: false,
                tier,
                action:  'requires_approval',
                record:  { ...record, status: 'pending_approval', note: 'Tier 2 — queued for user approval (Sprint B)' },
            };

        case GOVERNANCE_TIERS.EXPLICIT:
        case GOVERNANCE_TIERS.SUPER_ADMIN:
            console.warn(`[GOVERNANCE] BLOCKED — tier ${tier} explicit approval required for task ${taskId}`);
            return {
                allowed: false,
                tier,
                action:  'requires_explicit_approval',
                record:  { ...record, status: 'blocked', note: `Tier ${tier} — explicit approval required` },
            };

        default:
            console.warn(`[GOVERNANCE] Unknown tier ${tier} — defaulting to auto-approve`);
            return {
                allowed: true,
                tier:    0,
                action:  'auto_approved',
                record:  { ...record, status: 'auto_approved', note: 'Unknown tier — defaulted to auto' },
            };
    }
}

module.exports = { evaluateGovernance, GOVERNANCE_TIERS };
