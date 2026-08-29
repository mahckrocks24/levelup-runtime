'use strict';

/**
 * LevelUp Agent System — Phase 3: DB-Aware Agent Adapter
 *
 * Agent identities now come from WordPress DB (lu/v1/agents).
 * Static AGENTS object kept as fallback — ensures zero downtime
 * if the DB endpoint is unreachable during startup.
 *
 * agent_id values are permanent: dmm, james, priya, elena, alex.
 * capability_set is now DB-driven (seeded from capability-map.js — identical behavior).
 * model_preference field supported on each role for future multi-provider routing.
 *
 * ── LAUNCH SCOPE (2026-07-21, v2.37.3) ──
 * Launch-excluded agents are filtered out of BOTH the static fallback roster
 * and the DB-fetched roster. The DB path already returns a sanitised roster
 * from Laravel, but filtering here too means a Laravel/API outage can never
 * restore a removed agent through AGENTS_STATIC. See launch-scope.js.
 */

const axios = require('axios');
const launchScope = require('./launch-scope');

// Lazy ref to capability-map — fallback if DB unreachable
let _capMap = null;
function capMap() {
    if (!_capMap) _capMap = require('./capability-map');
    return _capMap;
}

// ── Static fallback AGENTS (used if DB fetch fails) ──────────────────────
//
// EXPANDED 2026-04-13 (Phase 0.6b runtime PR): registered the 15 missing
// specialists to match the canonical 21-agent roster in the Laravel `agents`
// table. Source of truth: GET /api/internal/agents on staging (verified live
// before this PR was written; full roster also documented in
// boss888-audit/logs/2026-04-12-write-builder-audit/17-RUNTIME-E2E-VERIFY.md).
//
// IMPORTANT: Sarah's key stays `dmm` (not `sarah`) because ~25+ call sites
// across this runtime (meeting-room, meeting-prompts, lu-planner,
// intelligence-validation, lu-synthesis-routes, etc.) reference `'dmm'` as
// the canonical orchestrator slug. The DB-fetch path explicitly maps the
// Laravel `slug=sarah` row to the `dmm` key for backward compat — see
// fetchAgentsFromDB() below.
//
// Categories used for emoji/color: dmm | seo | content | crm.
//
// TRIMMED 2026-07-21 (v2.37.3, W3 runtime sanitation): the 10 launch-excluded
// agents (marcus, jordan, tyler, zara, zoe, maya, vera, kai, chris, leo) were
// REMOVED from this fallback. Previously an API outage would fall back to a
// 20-agent roster and silently resurrect the removed social/email specialists.
// The retained 10 below match the Laravel launch-scope roster exactly.
const AGENTS_STATIC = {
    // ── Lead (1)
    dmm:    { id:'dmm',    name:'Sarah',  title:'Digital Marketing Manager',    emoji:'👩‍💼', color:'#6C5CE7' },

    // ── SEO specialists (5)
    james:  { id:'james',  name:'James',  title:'SEO Strategist',               emoji:'📊',  color:'#3B8BF5' },
    alex:   { id:'alex',   name:'Alex',   title:'Technical SEO Engineer',       emoji:'⚙️',  color:'#00E5A8' },
    diana:  { id:'diana',  name:'Diana',  title:'Local SEO Specialist',         emoji:'📍',  color:'#14B8A6' },
    ryan:   { id:'ryan',   name:'Ryan',   title:'Link Building Specialist',     emoji:'🔗',  color:'#06B6D4' },
    sofia:  { id:'sofia',  name:'Sofia',  title:'International SEO Director',   emoji:'🌍',  color:'#0EA5E9' },

    // ── Content specialists (2)
    priya:  { id:'priya',  name:'Priya',  title:'Content Manager',              emoji:'✍️',  color:'#A78BFA' },
    nora:   { id:'nora',   name:'Nora',   title:'Content Strategy Director',    emoji:'📚',  color:'#7C3AED' },

    // ── CRM / lifecycle specialists (2)
    marcus: { id:'marcus', name:'Marcus', title:'Social Media Manager',         emoji:'📱',  color:'#F59E0B' }, // v2.37.10 (DEC-0028) restored
    elena:  { id:'elena',  name:'Elena',  title:'Lead & CRM Manager',           emoji:'🎯',  color:'#F87171' },
    max:    { id:'max',    name:'Max',    title:'Growth & CRO Director',        emoji:'🚀',  color:'#DC2626' },
};

// Fail-closed guard: if anyone re-adds a launch-excluded agent to the literal
// above, strip it at module load rather than serving it.
for (const key of Object.keys(AGENTS_STATIC)) {
    if (launchScope.isRemovedAgent(key)) delete AGENTS_STATIC[key];
}

// Live agent roster — populated from DB on startup, refreshed every 5 minutes
let _agentsLive  = null;
let _agentsFetch = null; // in-flight promise dedup
let _lastFetched = 0;
const REFRESH_MS = 5 * 60 * 1000;

// Default emoji + color per category — used when the DB row doesn't include
// a UI hint (Laravel /api/internal/agents currently doesn't return emoji/color).
const CATEGORY_DEFAULTS = {
    dmm:     { emoji: '👩‍💼', color: '#6C5CE7' },
    seo:     { emoji: '📊',  color: '#3B8BF5' },
    content: { emoji: '✍️',  color: '#A78BFA' },
    social:  { emoji: '📱',  color: '#F59E0B' },
    crm:     { emoji: '🎯',  color: '#F87171' },
    general: { emoji: '🤖',  color: '#8B97B0' },
};

async function fetchAgentsFromDB() {
    // 2026-06-29 (v2.34.0): call Laravel /api/internal/* directly via
    // LARAVEL_BASE_URL || LARAVEL_URL (no nginx rewrite exists; the old
    // /wp-json/lu/v1 facade 404s). Falls back to WP_URL only as last resort.
    const wpUrl = process.env.WP_URL || process.env.WP_CALLBACK_URL?.replace('/wp-json/levelup/v1/core/task-result', '') || '';
    if (!wpUrl) return null;

    try {
        const { data } = await axios.get(`${process.env.LARAVEL_BASE_URL || process.env.LARAVEL_URL || wpUrl}/api/internal/agents`, { timeout: 8000 });
        if (!data?.agents?.length) return null;

        // FIX 2026-04-13 (Phase 0.6b runtime PR): the canonical roster now
        // comes from Laravel /api/internal/agents which returns `slug` (not
        // `agent_id`), `capabilities_json` (not `capability_set`), and
        // `skills_json` (not `skill_domains`). Fall back to the old WP field
        // names for safety in case any legacy endpoint is still in use.
        // The Sarah row has `slug=sarah` but ~25 runtime call sites reference
        // `dmm`, so map sarah → dmm for backward compat.
        const map = {};
        for (const a of data.agents) {
            const rawSlug = a.slug || a.agent_id || '';
            if (!rawSlug) continue;
            // Sarah's row is slug=sarah in Laravel but `dmm` in this runtime.
            const key = rawSlug === 'sarah' ? 'dmm' : rawSlug;
            // LAUNCH SCOPE: never admit a removed agent, even if Laravel
            // regresses and starts returning one again.
            if (launchScope.isRemovedAgent(rawSlug) || launchScope.isRemovedAgent(key)) {
                console.warn(`[AGENTS] Dropped launch-excluded agent from DB roster: ${rawSlug}`);
                continue;
            }
            const category = a.category || 'general';
            const defaults = CATEGORY_DEFAULTS[category] || CATEGORY_DEFAULTS.general;

            map[key] = {
                id:               key,
                name:             a.name,
                title:            a.title,
                description:      a.description || '',
                emoji:            a.avatar || a.emoji || defaults.emoji,
                color:            a.color  || defaults.color,
                category:         category,
                role_slug:        a.role || a.role_slug || 'specialist',
                // LAUNCH SCOPE: strip removed tools from DB-supplied grants so
                // the runtime can never select a capability the kernel denies.
                capability_set:   launchScope.filterToolIds(a.capabilities_json || a.capability_set || []),
                skill_domains:    a.skills_json || a.skill_domains || [],
                model_preference: a.model_preference || null,
                is_dmm:           !!a.is_dmm,
            };
        }
        console.log(`[AGENTS] Loaded ${Object.keys(map).length} agents from DB`);
        return map;
    } catch (e) {
        console.warn(`[AGENTS] DB fetch failed, using static fallback: ${e.message}`);
        return null;
    }
}

// Get current AGENTS — DB if fresh, else static fallback
async function getAgents() {
    const now = Date.now();
    if (_agentsLive && (now - _lastFetched) < REFRESH_MS) return _agentsLive;
    if (_agentsFetch) return _agentsFetch; // deduplicate concurrent calls

    _agentsFetch = fetchAgentsFromDB().then(result => {
        _agentsFetch = null;
        if (result) {
            _agentsLive  = result;
            _lastFetched = Date.now();
        }
        return _agentsLive || AGENTS_STATIC;
    }).catch(() => {
        _agentsFetch = null;
        return _agentsLive || AGENTS_STATIC;
    });

    return _agentsFetch;
}

// Sync accessor (uses live cache if populated, static otherwise)
// Safe to call from synchronous code — non-blocking
//
// LAUNCH SCOPE: final filter at the accessor. Both sources are already
// sanitised; this is the last gate so no code path anywhere in the runtime can
// observe a removed agent, regardless of how the roster was populated.
function getAgentsSync() {
    return launchScope.filterAgentMap(_agentsLive || AGENTS_STATIC);
}

// AGENTS export — backward-compat alias to sync accessor
// All existing code that does `require('./agents').AGENTS` still works
const AGENTS = new Proxy({}, {
    get(_, key) { return getAgentsSync()[key]; },
    ownKeys()   { return Object.keys(getAgentsSync()); },
    has(_, key) { return key in getAgentsSync(); },
    getOwnPropertyDescriptor(_, key) {
        return key in getAgentsSync()
            ? { configurable: true, enumerable: true, writable: false }
            : undefined;
    },
});

const TOKENS = {
    manager:      600,
    specialist:   600,
    synthesis:    1400,
    tasks:        800,
    deliberation: 250,
    vision:       700,
};

const MAX_TURNS_PER_ROUND   = 3;
const MAX_AGENT_RESPONSES   = 15;
const DUPLICATE_THRESHOLD   = 0.90;

// ── TEAM_ROSTER ────────────────────────────────────────────────────────────
// Assembled dynamically from live agent data. Lists every agent with name,
// title, and (when available) description. The DMM is always pinned at the
// top so meeting prompts always treat her as the orchestrator.
//
// EXPANDED 2026-04-13 (Phase 0.6b runtime PR): used to enumerate only the
// 6 hardcoded original agents — Sarah was half-blind to her own team
// because the meeting roster never mentioned the 15 specialists.
function getTeamRoster() {
    const a = getAgentsSync();
    const ids = Object.keys(a);
    if (ids.length === 0) {
        return 'YOUR TEAM — no agents available.';
    }

    // Sort: DMM first, then alphabetical by id
    ids.sort((x, y) => (x === 'dmm' ? -1 : y === 'dmm' ? 1 : x.localeCompare(y)));

    const lines = ids.map(id => {
        const agent = a[id];
        if (!agent) return null;
        const desc = agent.description ? `: ${agent.description}` : '';
        const tag  = id === 'dmm' ? ' (Lead — orchestrates the team)' : '';
        return `- ${agent.name} (${agent.title})${tag}${desc}`;
    }).filter(Boolean);

    return `
YOUR TEAM — know exactly who owns what:
${lines.join('\n')}
HARD RULES: All agents always present. Never claim someone is unavailable. When @mentioned you MUST respond. Deliver — never promise to deliver later.`;
}

// Keep TEAM_ROSTER as a getter for backward compat
const TEAM_ROSTER = getTeamRoster();

// ── buildAssistantPrompt (unchanged from Sprint F) ─────────────────────────
function buildAssistantPrompt(message, context = {}, memory = {}, toolSuggestion = '') {
    const agents    = getAgentsSync();
    const agentList = Object.values(agents)
        .map(a => `  ${a.id || a.agent_id} — ${a.name} (${a.title})`)
        .join('\n');

    const bizParts = [
        context.business_name || context.businessName
            ? `Business: ${context.business_name || context.businessName}` : '',
        context.industry  ? `Industry: ${context.industry}` : '',
        context.location  ? `Location: ${context.location}` : '',
        context.goals     ? `Goals: ${context.goals}` : '',
        Array.isArray(context.services) && context.services.length
            ? `Services: ${context.services.join(', ')}` : '',
    ].filter(Boolean).join('\n');

    const memBlock = memory.previous_campaigns?.length
        ? `Recent campaigns: ${memory.previous_campaigns.slice(-3).map(c=>c.topic).join(', ')}`
        : '';

    return `You are the LevelUp AI Assistant — the intelligent interface for the LevelUp Growth marketing platform.

Your job: help the user navigate, understand agent activity, consult specialists, and execute tools.

WORKSPACE PROFILE:
${bizParts || '(No workspace profile configured — ask the user about their business.)'}
${memBlock}

SPECIALIST TEAM:
${agentList}

TOOLS:
<assistant_tool>{ "tool": "navigate", "params": { "view": "workspace|projects|agents|crm|seo|calendar|reports|approvals" } }</assistant_tool>
<assistant_tool>{ "tool": "ask_agent", "params": { "agent": "<agent_id>", "question": "specific question" } }</assistant_tool>
<assistant_tool>{ "tool": "execute_tool", "params": { "tool_id": "<tool_id>", "params": {} } }</assistant_tool>
<assistant_tool>{ "tool": "web_search", "params": { "query": "<search query>" } }</assistant_tool>
<assistant_tool>{ "tool": "web_fetch", "params": { "url": "https://..." } }</assistant_tool>
<assistant_tool>{ "tool": "improve_draft", "params": { "article_id": 123, "instructions": "rewrite intro, tighten body" } }</assistant_tool>
<assistant_tool>{ "tool": "ai_builder_action", "params": { "page_id": 7, "command": "add a testimonials section after the hero" } }</assistant_tool>
<assistant_tool>{ "tool": "fill_missing_images", "params": { "limit": 10 } }</assistant_tool>

PRODUCT SCOPE (HARD RULE): LevelUp Growth does NOT include social-media management or email marketing. There is no social posting, scheduling, engagement, listening or analytics; no email campaigns, newsletters, sequences or drips. Never offer, plan, or claim to perform that work, and never name a specialist for it. If asked, say plainly it isn't part of the product, then offer a retained alternative: a blog article, sharing a published article, a Studio image or video, a Website Builder page, or a CRM follow-up task.

RULES:
- For SEO, content, CRM, or technical questions → use ask_agent for expert input.
- For live platform data → use execute_tool.
- For information you don't have or that may have changed (news, competitor info, current stats, time-sensitive facts) → use web_search.
- To read a specific page (a competitor's site, an article URL the user mentioned) → use web_fetch.
- Don't browse for things you reliably know from training (basic geography, well-known facts, math, syntax).
- When web_search/web_fetch return results, cite the source domain in your reply.
- To EDIT an existing article (rewrite, improve, refresh) → emit the <assistant_tool>{ "tool": "improve_draft", "params": { "article_id": N, "instructions": "..." } }</assistant_tool> block.
- To EDIT a website page → emit the <assistant_tool>{ "tool": "ai_builder_action", "params": { "page_id": N, "command": "..." } }</assistant_tool> block.
- To add hero / featured images to articles that are MISSING an image (bulk backfill) → emit <assistant_tool>{ "tool": "fill_missing_images", "params": { "limit": N } }</assistant_tool>. "limit" is OPTIONAL (caps how many articles are processed this run; omit it to let the backend choose a safe default). The backend FINDS the articles that are missing images by itself — you do NOT know and MUST NOT invent article ids for this tool. Never fabricate an id: this tool takes no id, only the optional limit.
- CRITICAL: edits ONLY happen when you emit the <assistant_tool> block. Describing what you "will do" or claiming you've edited without the block means NOTHING HAPPENS — the system will not run the edit and the user will see no change. ALWAYS emit the block first; you can add a brief intro line above it but the block MUST be present.
- The tool will execute and return the result (audit_id, duration, content changes). You will then get a SECOND turn to compose the final user-facing reply with the REAL audit_id (a numeric DB id like 2341, never a made-up string).
- Edits mutate live content — if the user's request is ambiguous, ask for clarification BEFORE emitting the tool block; once emitted, the edit runs immediately.
- Match response length to complexity. No artificial word limits.
- Never invent data — use web_search if you don't have it.
- METRICS HONESTY (HARD RULE): NEVER claim Google Search Console or Analytics is "connected", and NEVER state a keyword's ranking position, clicks, impressions, CTR, or traffic numbers UNLESS a tool you called THIS turn explicitly returned that exact data. If a tool returns "not connected" or has no ranking/traffic data, say so plainly ("Search Console isn't connected yet — connect it in Insights to see live rankings"). Do NOT invent positions (e.g. "position 9"), do NOT assume connection, do NOT recall a rank/metric from an earlier turn as if it were fresh. A number you did not just retrieve from a tool this turn does not exist — omit it.
- You have full conversation history — use it for continuity.`;
}

function buildAgentConsultPrompt(agentId, question, context = {}) {
    // LAUNCH SCOPE: a removed agent must never be given a persona to speak as.
    // Fail closed — the caller gets an explicit "not available" system prompt
    // instead of an invented specialist identity.
    if (launchScope.isRemovedAgent(agentId)) {
        return `That specialist is not part of the LevelUp Growth team and is not available. `
            + `Do not answer as them and do not describe their role as if it existed. `
            + `Briefly say the capability isn't part of the product, then redirect to what the `
            + `team does cover: SEO, technical SEO, blog and website content, the Website Builder, `
            + `CRM and lead management, and Studio creative.`;
    }
    const agents = getAgentsSync();
    const agent  = agents[agentId] || AGENTS_STATIC[agentId] || { name: agentId, title: 'Specialist' };
    const biz    = [
        context.business_name || context.businessName ? (context.business_name || context.businessName) : '',
        context.industry      ? `Industry: ${context.industry}` : '',
        context.location      ? `Location: ${context.location}` : '',
        Array.isArray(context.services) && context.services.length
            ? `Services: ${context.services.join(', ')}` : '',
    ].filter(Boolean).join(' | ');
    return `You are ${agent.name}, ${agent.title} at LevelUp Growth.
${biz ? `Working for: ${biz}` : ''}
Answer as your specialist role. Be direct, specific, and actionable. No filler.`;
}

// Pre-fetch agents on module load (non-blocking)
getAgents().catch(() => {});

// Re-export meeting prompt architecture so meeting-room.js
// can require everything from a single './agents' path (backward compat).
const meetingPrompts = require('./meeting-prompts');

module.exports = {
    AGENTS,
    AGENTS_STATIC,
    TOKENS,
    TEAM_ROSTER,
    MAX_TURNS_PER_ROUND,
    MAX_AGENT_RESPONSES,
    DUPLICATE_THRESHOLD,
    getAgents,
    getAgentsSync,
    getTeamRoster,
    buildAssistantPrompt,
    buildAgentConsultPrompt,

    // Meeting prompt architecture (restored from meeting-prompts.js)
    ...meetingPrompts,
};
