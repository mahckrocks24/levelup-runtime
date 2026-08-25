# Sarah Synthesis Routes — Runtime Deploy Notes

**Build date:** 2026-05-24
**Target Railway version:** 2.28.0
**Backwards-compat:** YES — Laravel orchestrators already attempt these endpoints first and fall back to `aiRun()` if they 404, so this can ship anytime without coordinated Laravel deploy.

## What changed

| File | Change |
|---|---|
| `lu-sarah-synthesis-routes.js` | **NEW** — three POST handlers (`/internal/sarah/synthesize-daily|weekly|monthly`) that own the synthesis prompts + system messages + output schemas. Each calls `callLLM()`, parses JSON, returns `{ brief_markdown | 30_day_plan_markdown, proposed_actions }` |
| `index.js` | Require `lu-sarah-synthesis-routes` + call `sarahSynthesisRoutes.mountRoutes(app, requireSecret)` after the existing `/internal/synthesize` mount. Three `/internal/sarah/synthesize-*` routes added to `/health`'s `internal_routes` list. |
| `index.js` (version labels) | Startup log + `[SERVER]` listen log bumped from `v2.25.0` → `v2.28.0` to match `/health` |
| `package.json` | `version` 2.25.0 → 2.28.0; description updated |
| `.bak` files | 10 stale backups removed (`agents.js.bak`, 8 × `*.bak-memory-20260425-101228`, `index.js.bak2`) |

## Why this matters (architecture)

**Hands-vs-brain rule:** Laravel = state/governance/persistence. Runtime = generation/synthesis/intelligence.

Until now, the Sarah orchestrators built the synthesis prompt **in Laravel** and called `runtime->aiRun('seo_content_generation', $prompt, ...)` as a thin LLM passthrough. That's intelligence in the wrong layer. The new endpoints move the prompts + system messages + JSON parsing INTO the runtime where they belong.

Laravel can now just send `{ workspace_id, state }` and get back `{ brief_markdown, proposed_actions }` — no prompt assembly, no fold-the-system-prompt workaround.

## API contract

All three endpoints accept:
```
POST /internal/sarah/synthesize-{daily|weekly|monthly}
Headers: X-LevelUp-Secret: <LU_SECRET>
Body:    { "workspace_id": <int>, "state": <gathered state object> }
```

**Daily response:**
```json
{
  "brief_markdown": "...",
  "proposed_actions": [
    { "action": "write_article", "title": "...", "reason": "...",
      "credit_cost": 3, "priority": "high", "rule": "opportunity_zone",
      "agent": "sarah" }
  ],
  "workspace_id": 2,
  "elapsed_ms": 1532
}
```

**Weekly response:** same shape as daily.

**Monthly response:** swaps `brief_markdown` for `30_day_plan_markdown`.

Error responses:
- `400` — missing/invalid workspace_id or state
- `502 { error: "llm_error" }` — DeepSeek call threw
- `502 { error: "llm_empty" }` — DeepSeek returned no text
- `502 { error: "parse_failed", preview: "..." }` — JSON parse failed (preview helps diagnose)
- `502 { error: "missing_field:brief_markdown" }` — LLM returned JSON but missing required field

## Smoke test after deploy

```bash
# From Laravel droplet (has the secret):
SECRET=$(grep RUNTIME_SECRET /var/www/levelup-staging/.env | cut -d= -f2)
curl -sS -X POST https://levelup-runtime2-production.up.railway.app/internal/sarah/synthesize-daily \
  -H "X-LevelUp-Secret: $SECRET" \
  -H "Content-Type: application/json" \
  -d '{"workspace_id":2,"state":{"goals":[],"_rule_candidates":[]}}' | jq -r '.brief_markdown' | head -10
```

Also hit `/health` and verify the `internal_routes` array now includes the three new entries.

## Laravel-side: no change required

The orchestrators already have `tryDedicatedEndpoint()` first, fallback second. Once Railway has this deploy live, the fallback path stops being exercised. No Laravel code change is required for activation — the orchestrators will start hitting the new endpoint automatically.

## Rollback

If something goes wrong, revert `index.js` to remove the `sarahSynthesisRoutes.mountRoutes(...)` line + the require. Laravel orchestrators will resume using the `aiRun()` fallback path with no user-visible regression.
