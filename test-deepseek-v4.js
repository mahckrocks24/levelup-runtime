#!/usr/bin/env node
'use strict';
/**
 * DeepSeek V4 contract + regression suite.
 * Zero-dependency (the runtime has no test framework installed).
 *
 *   node test-deepseek-v4.js          → deterministic unit/contract tests only
 *   node test-deepseek-v4.js --live   → additionally run controlled live API calls
 *
 * Live mode issues a small fixed number of minimal requests. It is NOT a
 * load test and must never be pointed at production volume.
 */
const assert = require('assert');
const ds = require('./deepseek-models');

const LIVE = process.argv.includes('--live');
let pass = 0, fail = 0;
const failures = [];

async function t(name, fn) {
    try { await fn(); pass++; console.log(`  PASS  ${name}`); }
    catch (e) { fail++; failures.push({ name, err: e.message }); console.log(`  FAIL  ${name}\n          ${e.message}`); }
}
function section(s) { console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 62 - s.length))}`); }

(async () => {

// ═══════════════════════════════════════════════════════════════════
section('1. MODEL ROUTING');

await t('default model resolves to deepseek-v4-flash', () => {
    assert.strictEqual(ds.DEFAULT_MODEL, 'deepseek-v4-flash');
});
await t('tier "flash" resolves to deepseek-v4-flash', () => {
    assert.strictEqual(ds.resolveModel('flash'), 'deepseek-v4-flash');
});
await t('tier "pro" resolves to deepseek-v4-pro', () => {
    assert.strictEqual(ds.resolveModel('pro'), 'deepseek-v4-pro');
});
await t('tier is case-insensitive', () => {
    assert.strictEqual(ds.resolveModel('PRO'), 'deepseek-v4-pro');
});
await t('unknown tier throws DEEPSEEK_INVALID_MODEL', () => {
    assert.throws(() => ds.resolveModel('turbo'), e => e.code === 'DEEPSEEK_INVALID_MODEL');
});
await t('retired deepseek-chat is REJECTED', () => {
    assert.throws(() => ds.assertModelSupported('deepseek-chat'), e => e.code === 'DEEPSEEK_INVALID_MODEL');
});
await t('retired deepseek-reasoner is REJECTED', () => {
    assert.throws(() => ds.assertModelSupported('deepseek-reasoner'), e => e.code === 'DEEPSEEK_INVALID_MODEL');
});
await t('retired-model error names the valid replacements', () => {
    try { ds.assertModelSupported('deepseek-chat'); assert.fail('should throw'); }
    catch (e) { assert.ok(/deepseek-v4-flash/.test(e.message) && /deepseek-v4-pro/.test(e.message)); }
});
await t('unknown model name is REJECTED', () => {
    assert.throws(() => ds.assertModelSupported('gpt-4o'), e => e.code === 'DEEPSEEK_INVALID_MODEL');
});
await t('resolveRequestedModel falls back to default when unset', () => {
    assert.strictEqual(ds.resolveRequestedModel(undefined), 'deepseek-v4-flash');
    assert.strictEqual(ds.resolveRequestedModel(''), 'deepseek-v4-flash');
});
await t('resolveRequestedModel honours a valid explicit model', () => {
    assert.strictEqual(ds.resolveRequestedModel('deepseek-v4-pro'), 'deepseek-v4-pro');
});

// ═══════════════════════════════════════════════════════════════════
section('2. NO RETIRED IDENTIFIER IN ANY ACTIVE PATH');

const fs = require('fs');
const ACTIVE = ['index.js', 'llm.js', 'lu-planner.js', 'lu-worker-manager.js', 'ai-complete-endpoint.js', 'deepseek-models.js'];

await t('no active file contains a retired model STRING LITERAL', () => {
    const offenders = [];
    for (const f of ACTIVE) {
        const src = fs.readFileSync(__dirname + '/' + f, 'utf8');
        src.split(/\r?\n/).forEach((line, i) => {
            const code = line.split('//')[0];               // ignore trailing comments
            if (/['"`]deepseek-(chat|reasoner)['"`]/.test(code)) {
                // the registry's RETIRED_MODELS set is the one legitimate mention
                if (f === 'deepseek-models.js' && /RETIRED_MODELS/.test(src.split(/\r?\n/)[i])) return;
                offenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 90)}`);
            }
        });
    }
    // deepseek-models.js declares the retired set intentionally
    const real = offenders.filter(o => !o.startsWith('deepseek-models.js'));
    assert.deepStrictEqual(real, [], 'retired literals still active:\n' + real.join('\n'));
});

await t('every outbound request site references the registry', () => {
    const checks = [
        ['index.js', /model:\s*dsModels\.DEFAULT_MODEL/],
        ['lu-planner.js', /model:\s*dsModels\.resolveModel/],
        ['lu-worker-manager.js', /model:\s*dsModels\.DEFAULT_MODEL/],
        // v2.37.6: llm.js is no longer an outbound request site — it delegates to
        // the ExecutionRouter, which is. The registry reference moved with the
        // call, so the router is checked here in llm.js's place.
        ['lu-execution-router.js', /defaultModel:\s*\(\)\s*=>\s*ds\.DEFAULT_MODEL/],
    ];
    for (const [f, re] of checks) {
        const src = fs.readFileSync(__dirname + '/' + f, 'utf8');
        assert.ok(re.test(src), `${f} does not reference the registry`);
    }
    // …and llm.js must no longer issue a request of its own at all.
    const llmSrc = fs.readFileSync(__dirname + '/llm.js', 'utf8');
    assert.ok(!/require\(['"]axios['"]\)/.test(llmSrc), 'llm.js must not make outbound calls');
});

// ═══════════════════════════════════════════════════════════════════
section('3. REASONING HEADROOM');

await t('headroom adds the configured allowance', () => {
    assert.strictEqual(ds.withReasoningHeadroom(1500), 1500 + ds.REASONING_HEADROOM);
});
await t('headroom covers the measured Pro worst case (1238 reasoning tokens)', () => {
    assert.ok(ds.REASONING_HEADROOM > 1238, `headroom ${ds.REASONING_HEADROOM} must exceed measured Pro max 1238`);
});
await t('headroom is BOUNDED by the cap (never unlimited)', () => {
    assert.strictEqual(ds.withReasoningHeadroom(999999), ds.MAX_TOKENS_CAP);
});
await t('headroom applies a sane fallback for missing/zero budgets', () => {
    assert.strictEqual(ds.withReasoningHeadroom(undefined, 1200), 1200 + ds.REASONING_HEADROOM);
    assert.strictEqual(ds.withReasoningHeadroom(0, 1200), 1200 + ds.REASONING_HEADROOM);
});

// ═══════════════════════════════════════════════════════════════════
section('4. EMPTY-CONTENT GUARD');

await t('empty string is rejected with DEEPSEEK_EMPTY_FINAL_CONTENT', () => {
    assert.throws(() => ds.assertUsableContent('', {}), e => e.code === 'DEEPSEEK_EMPTY_FINAL_CONTENT');
});
await t('whitespace-only content is rejected', () => {
    assert.throws(() => ds.assertUsableContent('   \n\t  ', {}), e => e.code === 'DEEPSEEK_EMPTY_FINAL_CONTENT');
});
await t('null/undefined content is rejected', () => {
    assert.throws(() => ds.assertUsableContent(null, {}), e => e.code === 'DEEPSEEK_EMPTY_FINAL_CONTENT');
    assert.throws(() => ds.assertUsableContent(undefined, {}), e => e.code === 'DEEPSEEK_EMPTY_FINAL_CONTENT');
});
await t('finish_reason=length produces the token-budget diagnostic', () => {
    try { ds.assertUsableContent('', { finish_reason: 'length' }); assert.fail('should throw'); }
    catch (e) { assert.ok(/reasoning consumed the token budget/i.test(e.message), e.message); }
});
await t('empty-content error carries diagnostic metadata', () => {
    try { ds.assertUsableContent('', { finish_reason: 'length', model: 'deepseek-v4-pro', reasoning_tokens: 1500, max_tokens: 1500 }); }
    catch (e) {
        assert.strictEqual(e.meta.model, 'deepseek-v4-pro');
        assert.strictEqual(e.meta.reasoning_tokens, 1500);
        assert.strictEqual(e.meta.finish_reason, 'length');
    }
});
await t('TOOL-CALL turn with empty content is NOT rejected', () => {
    assert.strictEqual(ds.assertUsableContent('', { hasToolCalls: true }), '');
});
await t('valid content passes through unchanged', () => {
    assert.strictEqual(ds.assertUsableContent('hello world', {}), 'hello world');
});
await t('extractFinalContent normalises null to empty string', () => {
    assert.strictEqual(ds.extractFinalContent({ content: null }), '');
    assert.strictEqual(ds.extractFinalContent({}), '');
    assert.strictEqual(ds.extractFinalContent(null), '');
    assert.strictEqual(ds.extractFinalContent({ content: 'x' }), 'x');
});

// ═══════════════════════════════════════════════════════════════════
section('5. STRUCTURED OUTPUT VALIDATION');

await t('valid JSON object parses', () => {
    assert.deepStrictEqual(ds.parseStructuredOutput('{"ok":true}'), { ok: true });
});
await t('empty content rejected with DEEPSEEK_INVALID_STRUCTURED_OUTPUT', () => {
    assert.throws(() => ds.parseStructuredOutput(''), e => e.code === 'DEEPSEEK_INVALID_STRUCTURED_OUTPUT' && e.meta.reason === 'empty');
});
await t('invalid JSON rejected', () => {
    assert.throws(() => ds.parseStructuredOutput('not json at all'),
        e => e.code === 'DEEPSEEK_INVALID_STRUCTURED_OUTPUT' && e.meta.reason === 'invalid_json');
});
await t('TRUNCATED JSON rejected and classified as truncated', () => {
    assert.throws(() => ds.parseStructuredOutput('{"tasks":[{"agent":"dmm","act', { meta: { finish_reason: 'length' } }),
        e => e.code === 'DEEPSEEK_INVALID_STRUCTURED_OUTPUT' && e.meta.reason === 'truncated');
});
await t('unexpected top-level type (array) rejected', () => {
    assert.throws(() => ds.parseStructuredOutput('[1,2,3]'),
        e => e.code === 'DEEPSEEK_INVALID_STRUCTURED_OUTPUT' && e.meta.reason === 'unexpected_type');
});
await t('missing required field rejected', () => {
    assert.throws(() => ds.parseStructuredOutput('{"foo":1}', { requiredFields: ['tasks'] }),
        e => e.code === 'DEEPSEEK_INVALID_STRUCTURED_OUTPUT' && e.meta.reason === 'missing_fields');
});
await t('present required field accepted', () => {
    assert.deepStrictEqual(ds.parseStructuredOutput('{"tasks":[]}', { requiredFields: ['tasks'] }), { tasks: [] });
});
await t('raw sample preserved for diagnosis', () => {
    try { ds.parseStructuredOutput('{"broken'); }
    catch (e) { assert.ok(e.meta.raw_sample.includes('broken')); assert.strictEqual(e.meta.raw_length, 8); }
});
await t('raw sample REDACTS credentials', () => {
    try { ds.parseStructuredOutput('{"k":"sk-abcdef1234567890xyz" broken'); }
    catch (e) {
        assert.ok(!/sk-abcdef1234567890/.test(e.meta.raw_sample), 'API key leaked into diagnostics');
        assert.ok(/REDACTED/.test(e.meta.raw_sample));
    }
});
await t('redactSample strips Bearer tokens', () => {
    assert.ok(!/abc123def456/.test(ds.redactSample('Authorization: Bearer abc123def456ghi')));
});

// ═══════════════════════════════════════════════════════════════════
section('6. USAGE SPLIT (never invented)');

await t('splits reasoning from final output tokens', () => {
    const u = ds.extractUsage({ prompt_tokens: 94, completion_tokens: 1324, total_tokens: 1418,
        completion_tokens_details: { reasoning_tokens: 324 } });
    assert.strictEqual(u.input_tokens, 94);
    assert.strictEqual(u.reasoning_tokens, 324);
    assert.strictEqual(u.final_output_tokens, 1000);
    assert.strictEqual(u.total_tokens, 1418);
});
await t('missing usage fields yield null, NOT fabricated numbers', () => {
    const u = ds.extractUsage({});
    assert.strictEqual(u.input_tokens, null);
    assert.strictEqual(u.reasoning_tokens, null);
    assert.strictEqual(u.final_output_tokens, null);
});
await t('final_output_tokens is null when reasoning is unreported', () => {
    assert.strictEqual(ds.extractUsage({ completion_tokens: 100 }).final_output_tokens, null);
});

// ═══════════════════════════════════════════════════════════════════
section('7. FALLBACK ATTRIBUTION (source contract)');

// v2.37.6 — these three assertions used to grep index.js, because index.js WAS
// the fallback implementation. Per the v2.37.6 ruling the routing was MOVED into
// lu-execution-router, so they are retargeted at the new owner. They are also
// strengthened: each now additionally proves the behaviour did NOT stay behind
// in index.js, which the original index.js-only form could not detect.
const _routerSrc = fs.readFileSync(__dirname + '/lu-execution-router.js', 'utf8');
const _indexSrc  = fs.readFileSync(__dirname + '/index.js', 'utf8');

await t('success attribution (requested/actual provider) is emitted by the router', () => {
    const router = require('./lu-execution-router');
    for (const f of ['requested_provider', 'actual_provider', 'requested_model',
                     'actual_model', 'fallback_used', 'fallback_reason']) {
        assert.ok(new RegExp(f + ':').test(_routerSrc), `router must emit ${f}`);
    }
    // metadata() is the single relay both endpoints use — prove its shape.
    const meta = router.metadata({
        requested_provider: 'deepseek', actual_provider: 'deepseek',
        requested_model: 'x', actual_model: 'x', fallback_used: false, fallback_reason: null,
    });
    assert.strictEqual(meta.actual_provider, 'deepseek');
    assert.strictEqual(meta.fallback_used, false);
});
await t('fallback still escalates deepseek → openai/gpt-4o-mini with a reason', () => {
    assert.ok(/gpt-4o-mini/.test(_routerSrc), 'fallback target was removed without approval');
    assert.ok(/'deepseek',\s*'openai'/.test(_routerSrc), 'deepseek→openai chain must remain');
    assert.ok(/fallback_reason:\s*isFallback/.test(_routerSrc), 'fallback must record why it fired');
    const router = require('./lu-execution-router');
    assert.strictEqual(router.fallbackPermitted('DEEPSEEK_EMPTY_FINAL_CONTENT'), true);
});
await t('fallback remains present for /ai/run — reached via the router, not a copy', () => {
    assert.ok(/router\.execute\(/.test(_indexSrc), '/ai/run must delegate to the router');
    assert.ok(!/gpt-4o-mini/.test(_indexSrc), 'fallback must NOT also remain inside index.js');
});
await t('NO fallback was added to the write/draft path', () => {
    const src = fs.readFileSync(__dirname + '/lu-worker-manager.js', 'utf8');
    assert.ok(!/gpt-4o-mini/.test(src), 'unapproved fallback introduced into write path');
});

// ═══════════════════════════════════════════════════════════════════
section('8. NO SECRET LEAKAGE');

await t('registry never logs the API key', () => {
    const src = fs.readFileSync(__dirname + '/deepseek-models.js', 'utf8');
    assert.ok(!/console\.log\([^)]*apiKey/i.test(src));
    assert.ok(!/DEEPSEEK_API_KEY/.test(src), 'registry should not touch the key at all');
});

// ═══════════════════════════════════════════════════════════════════
if (LIVE) {
    section('9. LIVE CONTRACT TESTS (controlled, minimal volume)');
    const axios = require('axios');
    const KEY = process.env.DEEPSEEK_API_KEY;
    const API = 'https://api.deepseek.com/v1/chat/completions';
    const call = (body) => axios.post(API, body, {
        timeout: 120000, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
    });

    if (!KEY) {
        console.log('  SKIP  live tests — DEEPSEEK_API_KEY not set');
    } else {
        await t('LIVE flash non-streaming returns non-empty content', async () => {
            const r = await call({ model: ds.DEFAULT_MODEL,
                messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
                max_tokens: ds.withReasoningHeadroom(100) });
            const c = ds.extractFinalContent(r.data.choices[0].message);
            ds.assertUsableContent(c, { finish_reason: r.data.choices[0].finish_reason });
            assert.strictEqual(r.data.model, 'deepseek-v4-flash');
        });

        await t('LIVE pro non-streaming returns non-empty content', async () => {
            const r = await call({ model: ds.PRO_MODEL,
                messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
                max_tokens: ds.withReasoningHeadroom(100) });
            const c = ds.extractFinalContent(r.data.choices[0].message);
            ds.assertUsableContent(c, { finish_reason: r.data.choices[0].finish_reason });
            assert.strictEqual(r.data.model, 'deepseek-v4-pro');
        });

        await t('LIVE structured JSON parses under the strict validator', async () => {
            const r = await call({ model: ds.DEFAULT_MODEL,
                messages: [{ role: 'user', content: 'Return JSON only, shaped {"tasks":[{"title":"x"}]}' }],
                response_format: { type: 'json_object' }, max_tokens: ds.withReasoningHeadroom(400) });
            const c = ds.extractFinalContent(r.data.choices[0].message);
            const parsed = ds.parseStructuredOutput(c, { requiredFields: ['tasks'] });
            assert.ok(Array.isArray(parsed.tasks));
        });

        await t('LIVE tool calling works and is not treated as empty output', async () => {
            const r = await call({ model: ds.DEFAULT_MODEL,
                messages: [{ role: 'user', content: 'What is the weather in Dubai?' }],
                tools: [{ type: 'function', function: { name: 'get_weather', description: 'Get weather',
                    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }],
                tool_choice: 'auto', max_tokens: ds.withReasoningHeadroom(300) });
            const msg = r.data.choices[0].message;
            assert.ok(msg.tool_calls && msg.tool_calls.length > 0, 'no tool_calls returned');
            // must NOT throw despite empty content
            ds.assertUsableContent(ds.extractFinalContent(msg), { hasToolCalls: true });
        });

        await t('LIVE constrained budget produces empty content AND is DETECTED', async () => {
            const r = await call({ model: ds.DEFAULT_MODEL,
                messages: [{ role: 'user', content: 'Write a detailed 500 word essay about coffee.' }],
                max_tokens: 40 });   // deliberately starved — no headroom
            const c = ds.extractFinalContent(r.data.choices[0].message);
            const fr = r.data.choices[0].finish_reason;
            if (c.trim() === '') {
                assert.throws(() => ds.assertUsableContent(c, { finish_reason: fr }),
                    e => e.code === 'DEEPSEEK_EMPTY_FINAL_CONTENT');
            } else {
                console.log('          (note: model returned content even at 40 tokens; guard untriggered)');
            }
        });

        await t('LIVE streaming accumulates non-empty content', async () => {
            const resp = await fetch(API, {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: ds.DEFAULT_MODEL,
                    messages: [{ role: 'user', content: 'Count from 1 to 5.' }],
                    stream: true, max_tokens: ds.withReasoningHeadroom(200) }),
                signal: AbortSignal.timeout(120000),
            });
            assert.ok(resp.ok, 'stream HTTP ' + resp.status);
            const reader = resp.body.getReader(); const dec = new TextDecoder('utf-8');
            let buf = '', acc = '', reasoningSeen = false;
            while (true) {
                const { done, value } = await reader.read(); if (done) break;
                buf += dec.decode(value, { stream: true });
                const lines = buf.split('\n'); buf = lines.pop() || '';
                for (const l of lines) {
                    const s = l.trim(); if (!s.startsWith('data:')) continue;
                    const j = s.slice(5).trim(); if (j === '[DONE]') continue;
                    try {
                        const p = JSON.parse(j); const d = p.choices?.[0]?.delta || {};
                        if (d.reasoning_content) reasoningSeen = true;
                        if (d.content) acc += d.content;
                    } catch (_) {}
                }
            }
            assert.ok(acc.trim().length > 0, 'streamed content was empty');
            console.log(`          (streamed ${acc.length} chars; reasoning deltas seen: ${reasoningSeen})`);
        });

        await t('LIVE retired model is rejected by the API (regression sentinel)', async () => {
            try {
                await call({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 });
                assert.fail('deepseek-chat unexpectedly succeeded');
            } catch (e) {
                assert.strictEqual(e.response?.status, 400);
            }
        });
    }
}

// ═══════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(66)}`);
console.log(`RESULT: ${pass} passed, ${fail} failed${LIVE ? '  (live mode)' : '  (offline mode)'}`);
if (fail) { console.log('\nFAILURES:'); failures.forEach(f => console.log(`  - ${f.name}: ${f.err}`)); }
process.exit(fail ? 1 : 0);

})().catch(e => { console.error('SUITE CRASH:', e); process.exit(1); });
