'use strict';

/**
 * LevelUp Tool Registry — Sprint A
 *
 * The registry is loaded into memory when the Node runtime boots.
 * In Sprint B+ it will also load tool metadata from WordPress via
 * an internal API call on startup.
 *
 * Every tool must conform to the ToolDefinition interface:
 * {
 *   name:                 string,
 *   description:          string,
 *   execution_type:       'worker_job' | 'wordpress_api' | 'external_api' | 'sync_function',
 *   governance_tier:      0 | 1 | 2 | 3 | 4,
 *   required_permissions: string[],
 *   timeout_ms:           number,
 *   handler:              async function(payload, context) => ToolResult,
 * }
 *
 * ToolResult shape:
 * {
 *   success:      boolean,
 *   data:         any,
 *   error?:       string,
 *   execution_ms: number,
 *   memory_hint?: string,   // what the agent should remember from this result
 * }
 */

const tools = require('./tools');

class ToolRegistry {
    constructor() {
        this._registry = new Map();
        this._loadBuiltInTools();
        console.log(`[REGISTRY] Loaded ${this._registry.size} tool(s): ${[...this._registry.keys()].join(', ')}`);
    }

    _loadBuiltInTools() {
        for (const tool of tools) {
            this._registry.set(tool.name, tool);
        }
    }

    /**
     * Check if a tool exists and is active.
     */
    has(toolName) {
        return this._registry.has(toolName);
    }

    /**
     * Get tool definition.
     */
    get(toolName) {
        return this._registry.get(toolName) || null;
    }

    /**
     * Execute a tool by name.
     *
     * @param {string} toolName
     * @param {object} payload    — inputs for the tool
     * @param {object} context    — { task_id, agent_id, workspace_id }
     * @returns {Promise<object>} — ToolResult
     */
    async execute(toolName, payload, context = {}) {
        const start = Date.now();

        const tool = this._registry.get(toolName);
        if (!tool) {
            return {
                success:      false,
                data:         null,
                error:        `Tool '${toolName}' is not registered.`,
                execution_ms: Date.now() - start,
            };
        }

        console.log(`[REGISTRY] Executing tool: ${toolName} | task=${context.task_id}`);

        try {
            // Execute with timeout
            const result = await Promise.race([
                tool.handler(payload, context),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error(`Tool '${toolName}' timed out after ${tool.timeout_ms}ms`)),
                    tool.timeout_ms)
                ),
            ]);

            const execution_ms = Date.now() - start;
            console.log(`[REGISTRY] Tool ${toolName} completed in ${execution_ms}ms`);

            return {
                success:      true,
                data:         result,
                execution_ms,
                memory_hint:  tool.memory_hint ? tool.memory_hint(result) : null,
            };

        } catch (err) {
            const execution_ms = Date.now() - start;
            console.error(`[REGISTRY] Tool ${toolName} failed: ${err.message}`);
            return {
                success:      false,
                data:         null,
                error:        err.message,
                execution_ms,
            };
        }
    }

    /**
     * List all registered tools (for debugging / admin).
     */
    list() {
        return [...this._registry.values()].map(t => ({
            name:           t.name,
            description:    t.description,
            execution_type: t.execution_type,
            governance_tier: t.governance_tier,
        }));
    }
}

// Singleton — one registry per runtime instance
const registry = new ToolRegistry();
module.exports = registry;
