'use strict';

/**
 * LevelUp Builder AI — runtime handler
 * Receives builder commands and generates structured builder actions via DeepSeek.
 * Returns JSON action objects, never raw HTML.
 *
 * Endpoints:
 *   POST /internal/builder/ai-action     — process a natural language command on an existing page
 *   POST /internal/builder/generate-layout — generate a full page layout from a prompt
 */

const { callLLM } = require('./llm');

// ── Action types the AI can return ─────────────────────────────────────────
const BUILDER_ACTIONS = {
    ADD_SECTION:       'add_section',
    UPDATE_SECTION:    'update_section',
    DELETE_SECTION:    'delete_section',
    REORDER_SECTIONS:  'reorder_sections',
    ADD_COMPONENT:     'add_component',
    UPDATE_COMPONENT:  'update_component',
    DELETE_COMPONENT:  'delete_component',
    UPDATE_THEME:      'update_theme',
    GENERATE_LAYOUT:   'generate_layout',
};

// ── Component types vocabulary ─────────────────────────────────────────────
const COMPONENT_TYPES = [
    'heading', 'text', 'image', 'button', 'form', 'video',
    'icon', 'divider', 'spacer', 'html', 'list', 'card',
    'testimonial', 'pricing', 'faq', 'cta',
];

// ── Spacing tokens ─────────────────────────────────────────────────────────
const SPACING = ['none', 'xs', 'sm', 'md', 'lg', 'xl', '2xl'];

// ── Schema validator + normalizer ──────────────────────────────────────────
// All AI output MUST pass through validateAndNormalizeActions() before
// being applied to builder state. This prevents AI from breaking editability.

const VALID_ACTION_TYPES = new Set([
    'add_section', 'update_section', 'delete_section', 'reorder_sections',
    'add_component', 'update_component', 'delete_component', 'update_theme',
    'generate_layout',
]);

/**
 * Validate and normalize a single builder action.
 * Returns { valid: bool, action: normalizedAction|null, reason: string }
 */
function validateBuilderAction(action) {
    if (!action || typeof action !== 'object') {
        return { valid: false, action: null, reason: 'Action is not an object' };
    }
    if (!action.type || !VALID_ACTION_TYPES.has(action.type)) {
        return { valid: false, action: null, reason: `Unknown action type: "${action.type}"` };
    }

    // Normalize add_component / update_component — most likely to have schema corruption
    if (action.type === 'add_component' || action.type === 'update_component') {
        const cmp = action.component || action.changes?.component || action.changes;
        if (cmp) {
            const normalizedCmp = normalizeComponent(cmp);
            if (!normalizedCmp.valid) {
                return { valid: false, action: null, reason: normalizedCmp.reason };
            }
            // Write back normalized component
            if (action.type === 'add_component') {
                action = { ...action, component: normalizedCmp.component };
            } else {
                // update_component: merge changes cleanly
                const changes = action.changes || {};
                action = {
                    ...action,
                    changes: {
                        ...changes,
                        content: normalizedCmp.component.content,
                        styles:  normalizedCmp.component.styles,
                        tokens:  normalizedCmp.component.tokens,
                    },
                };
            }
        }
    }

    // Normalize add_section — ensure containers is an array with proper structure
    if (action.type === 'add_section') {
        if (action.components_per_container) {
            // Validate each container's components
            const normalizedContainers = action.components_per_container.map(c => ({
                container_index: typeof c.container_index === 'number' ? c.container_index : 0,
                components: (c.components || []).map(cmp => {
                    const n = normalizeComponent(cmp);
                    return n.valid ? n.component : { type: 'text', content: { text: '' }, styles: {}, tokens: {} };
                }),
            }));
            action = { ...action, components_per_container: normalizedContainers };
        }
    }

    // update_theme: ensure tokens are all string values (no objects/arrays)
    if (action.type === 'update_theme' && action.tokens) {
        const safeTokens = {};
        for (const [k, v] of Object.entries(action.tokens)) {
            if (typeof v === 'string' || typeof v === 'number') {
                safeTokens[k] = String(v);
            }
        }
        action = { ...action, tokens: safeTokens };
    }

    return { valid: true, action, reason: 'ok' };
}

/**
 * Validate and normalize a component object.
 * Ensures: type exists, content is an object (not raw HTML string unless html type),
 * styles and tokens are plain objects.
 */
function normalizeComponent(cmp) {
    if (!cmp || typeof cmp !== 'object') {
        return { valid: false, component: null, reason: 'Component is not an object' };
    }

    let type = cmp.type;
    if (!type || !COMPONENT_TYPES.includes(type)) {
        // Try to recover: if type is missing but content looks like heading/text, infer
        if (cmp.content?.text && !cmp.content?.level) type = 'text';
        else if (cmp.content?.text && cmp.content?.level) type = 'heading';
        else if (cmp.content?.src && (String(cmp.content?.src).match(/\.(jpg|png|gif|webp|svg)/i))) type = 'image';
        else if (cmp.content?.label && cmp.content?.href) type = 'button';
        else {
            return { valid: false, component: null, reason: `Unknown component type: "${cmp.type}"` };
        }
    }

    let content = cmp.content;

    // CRITICAL: if content is a raw HTML string, wrap it as html type
    // but only if user explicitly wanted html — otherwise reject
    if (typeof content === 'string') {
        if (type === 'html') {
            content = { code: content };
        } else {
            // AI returned raw string where structured content was expected — try to rescue
            content = { text: content };
            if (type !== 'text' && type !== 'heading') {
                // Can't safely rescue — demote to text type
                type = 'text';
            }
        }
    }

    if (!content || typeof content !== 'object') {
        content = {};
    }

    // Ensure styles and tokens are plain objects, not strings/arrays
    const styles = (cmp.styles && typeof cmp.styles === 'object' && !Array.isArray(cmp.styles))
        ? cmp.styles : {};
    const tokens = (cmp.tokens && typeof cmp.tokens === 'object' && !Array.isArray(cmp.tokens))
        ? cmp.tokens : {};

    return {
        valid:     true,
        component: { type, content, styles, tokens },
        reason:    'ok',
    };
}

/**
 * Validate and normalize an array of builder actions.
 * Returns { actions: validActions[], rejected: rejectedItems[], normalized_count: number }
 * If all actions are invalid, returns empty actions array — caller must retry.
 */
function validateAndNormalizeActions(actions) {
    if (!Array.isArray(actions)) {
        return { actions: [], rejected: [{ reason: 'actions is not an array', action: actions }], normalized_count: 0 };
    }

    const valid_actions  = [];
    const rejected       = [];
    let   normalized_count = 0;

    for (const action of actions) {
        const result = validateBuilderAction(action);
        if (result.valid) {
            // Check if it was changed during normalization
            if (JSON.stringify(result.action) !== JSON.stringify(action)) normalized_count++;
            valid_actions.push(result.action);
        } else {
            console.warn(`[builder-ai] Rejected action: ${result.reason}`, JSON.stringify(action).slice(0, 200));
            rejected.push({ reason: result.reason, action });
        }
    }

    return { actions: valid_actions, rejected, normalized_count };
}

// ══════════════════════════════════════════════════════════════════════════
// HANDLER REGISTRATION — called from index.js
// ══════════════════════════════════════════════════════════════════════════
function registerBuilderRoutes(app) {
    app.post('/internal/builder/ai-action',   handleBuilderAiAction);
    app.post('/internal/builder/generate-layout', handleGenerateLayout);

    // Generic AI completion — used by WP builder AI (Arthur + AI panel)
    app.post('/internal/ai/complete', async (req, res) => {
        try {
            const { messages, max_tokens, temperature } = req.body;
            if (!messages || !Array.isArray(messages)) {
                return res.status(400).json({ error: 'messages array required' });
            }
            const result = await callLLM({
                messages,
                max_tokens: max_tokens || 4000,
                temperature: temperature ?? 0.7,
            });
            // callLLM returns { content, tool_calls, finish_reason, usage }
            const text = result.content || '';
            res.json({ text, content: text });
        } catch (err) {
            console.error('[ai/complete]', err.message);
            res.status(500).json({ error: err.message });
        }
    });
}

// ══════════════════════════════════════════════════════════════════════════
// HANDLER 1 — AI Action (modify existing page)
// ══════════════════════════════════════════════════════════════════════════
async function handleBuilderAiAction(req, res) {
    try {
        const { command, page_title, sections, context, theme } = req.body || {};

        if (!command) return res.status(400).json({ error: 'command required' });

        const systemPrompt = buildActionSystemPrompt();
        const userPrompt   = buildActionUserPrompt({ command, page_title, sections, context, theme });

        const raw = await callLLM({ messages: [
            { role: 'system',  content: systemPrompt },
            { role: 'user',    content: userPrompt },
        ], max_tokens: 2000, temperature: 0.3 });

        const parsed = parseBuilderResponse(raw);
        // Retry once with stricter prompt if all actions were rejected
        if ((!parsed.actions || parsed.actions.length === 0) && parsed.rejected_count > 0) {
            console.warn('[builder-ai] All actions rejected — retrying with strict schema prompt');
            const strictRaw = await callLLM({ messages: [
                { role: 'system',  content: buildActionSystemPrompt() },
                { role: 'user',    content: buildActionUserPrompt({ command, page_title, sections, context, theme }) },
                { role: 'assistant', content: '{"explanation":"","actions":[]}' },
                { role: 'user',    content: 'Your previous response contained invalid action structures. Return ONLY valid JSON actions with proper component schemas. Every component must have type, content (object), styles (object), and tokens (object). No raw HTML strings.' },
            ], max_tokens: 2000, temperature: 0.1 });
            const reparsed = parseBuilderResponse(strictRaw);
            parsed.actions     = reparsed.actions;
            parsed.explanation = reparsed.explanation || parsed.explanation;
        }
        return res.json({
            success:     true,
            actions:     parsed.actions || [],
            explanation: parsed.explanation || '',
            raw_intent:  command,
        });

    } catch (err) {
        console.error('[builder-ai] ai-action error:', err.message);
        return res.status(500).json({ error: 'AI action failed', detail: err.message });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// HANDLER 2 — Generate Layout (new page from prompt)
// ══════════════════════════════════════════════════════════════════════════
async function handleGenerateLayout(req, res) {
    try {
        const { prompt, industry = '', style = 'dark', sections: numSections = 5 } = req.body || {};

        if (!prompt) return res.status(400).json({ error: 'prompt required' });

        const systemPrompt = buildLayoutSystemPrompt();
        const userPrompt   = buildLayoutUserPrompt({ prompt, industry, style, numSections });

        const raw = await callLLM({ messages: [
            { role: 'system',  content: systemPrompt },
            { role: 'user',    content: userPrompt },
        ], max_tokens: 4000, temperature: 0.5 });

        const layout = parseLayoutResponse(raw);
        return res.json({
            success: true,
            layout,
            prompt,
        });

    } catch (err) {
        console.error('[builder-ai] generate-layout error:', err.message);
        return res.status(500).json({ error: 'Layout generation failed', detail: err.message });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// PROMPT BUILDERS
// ══════════════════════════════════════════════════════════════════════════

function buildActionSystemPrompt() {
    return `You are the LevelUp Builder AI assistant. You modify website builder pages through structured JSON actions.

COMPONENT TYPES: ${COMPONENT_TYPES.join(', ')}
SPACING VALUES: ${SPACING.join(', ')}
COLUMN OPTIONS: 1, 2, 3, 4
BG TYPES: none, color, token, gradient, image
BUTTON VARIANTS: primary, secondary, outline, ghost

AVAILABLE ACTIONS:
- add_section: { type: "add_section", position: "start|end|after_index", columns: 1-4, label: "", layout: {}, components_per_container: [{ container_index: 0, components: [] }] }
- update_section: { type: "update_section", section_index: 0, layout: {}, styles: {} }
- delete_section: { type: "delete_section", section_index: 0 }
- reorder_sections: { type: "reorder_sections", new_order: [0, 2, 1] }
- add_component: { type: "add_component", section_index: 0, container_index: 0, component: { type: "", content: {}, styles: {}, tokens: {} } }
- update_component: { type: "update_component", section_index: 0, container_index: 0, component_index: 0, changes: { content: {}, styles: {}, tokens: {} } }
- delete_component: { type: "delete_component", section_index: 0, container_index: 0, component_index: 0 }
- update_theme: { type: "update_theme", tokens: { primary: "#...", font_heading: "..." } }

COMPONENT CONTENT SCHEMAS:
- heading: { text, level: 1-6 }
- text: { text }
- image: { src, alt, link }
- button: { label, href, variant, target }
- cta: { heading, subtext, buttons: [{ label, href, variant }] }
- testimonial: { quote, author, role, avatar }
- pricing: { name, price, period, features: [], cta: { label, href } }
- faq: { items: [{ question, answer }] }
- form: { fields: [{ id, type, label, placeholder, required }], submit_label, action }
- card: { image, heading, text, cta: { label, href } }
- list: { items: [{ text }], style: "ul|ol" }
- divider: { style: "solid|dashed|dotted", thickness, color }
- spacer: { height }
- video: { src, poster, autoplay, loop, muted }
- html: { code }

STYLE PROPERTIES: color, bg, font_size, font_weight, text_align, padding, margin, border_radius, border, shadow
TOKEN REFERENCES: Use "@primary", "@accent", "@s1", "@s2", "@t1", "@t2", "@border", "@radius_md" etc.

RULES:
1. Return ONLY valid JSON — no markdown, no explanation outside JSON
2. Always return an array of actions even for single changes
3. content values must match the schema for that component type
4. Prefer theme tokens (@primary) over hardcoded colours
5. Keep copy professional and on-brand

RESPONSE FORMAT:
{
  "explanation": "Brief plain English explanation of what you changed",
  "actions": [ ... array of action objects ... ]
}`;
}

function buildActionUserPrompt({ command, page_title, sections, context, theme }) {
    return `Page: "${page_title}"
Sections: ${sections}
Theme tokens: ${JSON.stringify(theme || {}, null, 2)}
${context && Object.keys(context).length ? 'Context: ' + JSON.stringify(context, null, 2) : ''}

Command: ${command}

Return the JSON actions to fulfill this command.`;
}

function buildLayoutSystemPrompt() {
    return `You are the LevelUp Builder AI. You generate complete page layouts as structured JSON.

COMPONENT TYPES: ${COMPONENT_TYPES.join(', ')}
COLUMN OPTIONS: 1, 2, 3, 4
BG TYPES: none, color, token, gradient
TOKEN REFERENCES: @primary, @accent, @s1, @s2, @t1, @t2, @border, @radius_md, @radius_lg

Generate professional, modern page layouts. Each section must have containers and components.

SECTION FORMAT:
{
  "label": "Section name",
  "layout": { "columns": 1-4, "gap": "md", "padding_y": "xl", "padding_x": "md", "full_width": false, "bg_type": "none|token|color", "bg_value": "" },
  "containers": [
    {
      "span": 1,
      "components": [ { "type": "...", "content": { ... }, "styles": { "text_align": "center" }, "tokens": {} } ]
    }
  ]
}

RULES:
1. Return ONLY valid JSON, no markdown
2. Generate professional placeholder content (no lorem ipsum)
3. First section is always a hero with headline, subtext, and CTA buttons
4. Include varied section types: features, testimonials, CTA, pricing or FAQ
5. Use theme tokens for colours instead of hardcoded values
6. Keep copy specific to the industry/purpose described

RESPONSE FORMAT:
{
  "title": "Page title",
  "meta_description": "SEO description",
  "sections": [ ... array of section objects ... ]
}`;
}

function buildLayoutUserPrompt({ prompt, industry, style, numSections }) {
    return `Generate a ${numSections}-section landing page for the following:

${prompt}
${industry ? 'Industry: ' + industry : ''}
Style: ${style}

Return the complete page layout JSON.`;
}

// ══════════════════════════════════════════════════════════════════════════
// RESPONSE PARSERS
// ══════════════════════════════════════════════════════════════════════════

function parseBuilderResponse(raw) {
    const text = typeof raw === 'string' ? raw : (typeof raw?.content === 'string' ? raw.content : JSON.stringify(raw));
    const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    try {
        const parsed = JSON.parse(clean);
        // Validate structure
        if (!parsed.actions || !Array.isArray(parsed.actions)) {
            return { actions: [], explanation: 'Could not parse builder actions.' };
        }
        // ── Schema lock: validate and normalize all actions ──
        const { actions: valid_actions, rejected, normalized_count } = validateAndNormalizeActions(parsed.actions);
        if (rejected.length > 0) {
            console.warn(`[builder-ai] Rejected ${rejected.length} invalid action(s):`, rejected.map(r => r.reason).join(', '));
        }
        if (normalized_count > 0) {
            console.log(`[builder-ai] Normalized ${normalized_count} action(s) to preserve editability`);
        }
        return {
            actions:        valid_actions,
            explanation:    parsed.explanation || '',
            rejected_count: rejected.length,
        };
    } catch (e) {
        console.error('[builder-ai] parse error:', e.message, '\nRaw:', clean.slice(0, 500));
        return { actions: [], explanation: 'Failed to parse AI response.' };
    }
}

function parseLayoutResponse(raw) {
    const text = typeof raw === 'string' ? raw : (typeof raw?.content === 'string' ? raw.content : JSON.stringify(raw));
    const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    try {
        const parsed = JSON.parse(clean);
        if (!parsed.sections || !Array.isArray(parsed.sections)) {
            throw new Error('sections array missing');
        }
        // Ensure every section has minimum required fields
        parsed.sections = parsed.sections.map((sec, i) => ({
            label:      sec.label || `Section ${i + 1}`,
            layout:     sec.layout || { columns: 1, gap: 'md', padding_y: 'xl', padding_x: 'md', full_width: false, bg_type: 'none', bg_value: '' },
            containers: (sec.containers || [{ span: 1, components: [] }]).map(con => ({
                span:       con.span || 1,
                components: (con.components || []).map(cmp => ({
                    type:    cmp.type || 'text',
                    content: cmp.content || {},
                    styles:  cmp.styles || {},
                    tokens:  cmp.tokens || {},
                })),
            })),
        }));
        return parsed;
    } catch (e) {
        console.error('[builder-ai] layout parse error:', e.message);
        return {
            title:    'Generated Page',
            sections: [{
                label: 'Hero',
                layout: { columns: 1, gap: 'md', padding_y: 'xl', padding_x: 'md', full_width: false, bg_type: 'none', bg_value: '' },
                containers: [{ span: 1, components: [{ type: 'cta', content: { heading: 'Welcome', subtext: 'Generated content coming soon.', buttons: [{ label: 'Get Started', href: '#', variant: 'primary' }] }, styles: { text_align: 'center' }, tokens: {} }] }],
            }],
        };
    }
}

module.exports = { registerBuilderRoutes, BUILDER_ACTIONS, COMPONENT_TYPES };
