# Runtime v2.34.0 — laravel-repoint

**What:** re-point the runtime→Laravel callback half from the dead `/wp-json/lu/v1/*`
(and `lumkt`/`lucrm`) WordPress facade to Laravel's live `/api/internal/*` routes.

**Why:** forensic alignment audit (2026-06-29) proved the facade is dead — there is NO
`/wp-json → /api/internal` nginx rewrite on staging, so every runtime callback 404s
(`/api/internal/ping`=200 vs `/wp-json/lu/v1/ping`=404). Laravel's `/api/internal/*`
endpoints already exist and return 200; only the runtime needed re-pointing.
Full report: `boss888-audit/daily-progress/2026-06-29.md` + RUNTIME-LARAVEL-REPOINTING-RUNBOOK-2026-06-29.md.

**Base resolution used everywhere:** `process.env.LARAVEL_BASE_URL || process.env.LARAVEL_URL || <old WP_URL var>`
(matches the existing index.js / behavior-analysis / campaign-learning idiom).

## REQUIRED on deploy (Railway env)
Set: `LARAVEL_BASE_URL=https://staging.levelupgrowth.io`
(or `LARAVEL_URL` — either works). Without it, calls fall back to the old WP_URL host
on the NEW `/api/internal/*` path (works only if WP_URL already points at the Laravel host).

## Secret alignment (one shared value)
Laravel `RuntimeSecretMiddleware` compares the inbound secret against `RUNTIME_SECRET`.
Callbacks send `X-LU-Secret` or `X-LevelUp-Secret` (both accepted). Ensure on Railway:
`WP_SECRET == LU_SECRET == Laravel RUNTIME_SECRET` (single value). WP_SECRET-signed calls
already pass; LU_SECRET-signed ones (lu-planner, lu-intelligence-routes) need LU_SECRET to
equal that same value.

## Converted (16 call sites, 12 files) — clean 1:1
- registry.js, tool-executor.js, tool-health-check.js, tool-test-runner.js, lu-tool-executor.js → `/api/internal/tools/execute`
- lu-governor.js → `/api/internal/governance/flag` (guard now uses resolved base)
- lu-task-worker.js → `/api/internal/notifications`
- lu-worker-manager.js → `/api/internal/automation/runs`, `/campaign/send`, `/automation/runs/{id}`
- lu-event-bus.js → `/api/internal/automation/sequences`
- growth-insights.js → `/api/internal/site/pages`, `/campaigns`, `/crm/leads`
- agents.js → `/api/internal/agents` (+ corrected the stale "nginx rewrites" comment)
- lu-planner.js → `/api/internal/tools/status`

## NOT converted — left intentionally (semantic mismatch / needs decision)
- **lu-context.js:81** `workspace/context` — Laravel route is `/api/internal/workspace/{id}/context`;
  the runtime call carries no workspace id (assumed single-tenant WP). Needs a ws-id-aware
  refactor OR a Laravel adapter route. **Left on old path (still 404s) — flagged.**
- **lu-worker-manager.js:320** `/wp-json/lumkt/v1/sequences/{id}` — no clean 1:1 Laravel route
  (Laravel has `/automation/sequences` list). Needs param-shape decision.
- **index.js:2500, 2864-2866** write-stream callbacks — driven by caller-supplied `callback_url`;
  risk of breaking streaming if blind-mapped. Review separately.
- **lu-creative.js:37** generic `/wp-json${path}` passthrough — depends on caller path.

## Verification status
Syntax-checked: all 12 changed files pass `node --check` (node v20). **NOT runtime-tested**
(cannot run/deploy from the build host). Deploy to Railway + the env var, then confirm
runtime callbacks land 200 on `/api/internal/*` in the Laravel access log.
