'use strict';

/**
 * LevelUp Unified Tool Registry Bridge
 *
 * Previously: Sprint A-B legacy 4-tool registry (seoAudit, keywordResearch, contentBrief, testAudit)
 * Now: Delegates to the canonical 47-tool tool-registry.js used by all AI agents.
 *
 * This ensures the /internal/chat path and all AI subsystems share one tool source.
 */

const path       = require('path');
const canonical  = require('./tool-registry');   // 47-tool registry
const { getTool, listAll, getToolsForAgent } = canonical;

// Build a ToolRegistry-compatible wrapper so existing index.js callers
// (registry.list(), registry.get(), registry.execute()) keep working.

class UnifiedRegistry {
    constructor() {
        const all = listAll();
        console.log(`[REGISTRY] Unified: ${all.length} tools from canonical registry`);
    }

    has(toolName) { return !!getTool(toolName); }

    get(toolName) {
        const t = getTool(toolName);
        if (!t) return null;
        return {
            name:        t.id,
            description: t.description,
            parameters:  this._toOpenAI(t),
        };
    }

    // Execute via WP proxy — identical path used by agent task worker
    async execute(toolName, payload, context = {}) {
        const WP_BASE   = process.env.WP_BASE || process.env.WP_URL || '';
        const WP_SECRET = process.env.WP_SECRET || '';
        if (!WP_BASE) return { success: false, data: null, error: 'WP_BASE not configured' };

        const start = Date.now();
        const url   = `${process.env.LARAVEL_BASE_URL || process.env.LARAVEL_URL || WP_BASE}/api/internal/tools/execute`;
        try {
            const ctrl  = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 25000);
            const res   = await fetch(url, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json', 'X-LU-Secret': WP_SECRET },
                body:    JSON.stringify({ tool_id: toolName, agent_id: context.agent_id || 'system', params: payload }),
                signal:  ctrl.signal,
            });
            clearTimeout(timer);
            if (!res.ok) {
                const err = await res.text().catch(() => '');
                return { success: false, data: null, error: `HTTP ${res.status}: ${err.slice(0, 200)}` };
            }
            const json = await res.json();
            return { success: true, data: json.data ?? json, execution_ms: Date.now() - start };
        } catch (e) {
            return { success: false, data: null, error: e.message, execution_ms: Date.now() - start };
        }
    }

    // Returns tools in the shape needed by runAgentLoop / getToolDefinitionsForLLM
    list(agentId) {
        const tools = agentId ? getToolsForAgent(agentId) : listAll();
        return tools.map(t => ({
            name:           t.id,
            description:    t.description,
            execution_type: 'remote',
            governance_tier: t.requires_approval ? 'approval' : 'auto',
            parameters:     this._toOpenAI(t),
        }));
    }

    // Convert tool-registry.js param schema → OpenAI function-calling format
    _toOpenAI(tool) {
        const props = {};
        const required = [];
        for (const [k, v] of Object.entries(tool.params || {})) {
            props[k] = { type: v.type || 'string', description: v.description || k };
            if (v.required) required.push(k);
        }
        return { type: 'object', properties: props, required };
    }
}

module.exports = new UnifiedRegistry();
