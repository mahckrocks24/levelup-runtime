# Runtime v2.34.2 — repoint-complete

**Base:** v2.34.1-wp-base-inherit (which itself = v2.34.0-laravel-repoint + WP_URL→Laravel
inherit shim + site-context.js repoint). This release **finishes** the runtime→Laravel
callback repoint and cleans up the build.

**Why:** the 2.34.0/2.34.1 repoint left a handful of active call sites still hitting the
dead `/wp-json/*` WordPress facade. Verified 2026-06-30 against staging
(`php artisan route:list`): every `/api/internal/*` target below EXISTS in Laravel, so the
remaining sites could be converted safely.

## Converted in 2.34.2 (active call sites)
- **lu-context.js** — `GET /wp-json/lu/v1/workspace/context` → `GET /api/internal/workspace/{ws_id}/context`.
  `ws_id` was already threaded through `getWorkspaceContext(...)` (defaults to 1); now passed
  to `fetchWPContext`. Base resolves via `LARAVEL_BASE_URL || LARAVEL_URL || wp_url`.
- **index.js (write streaming)** — abort-poll now derives the base from EITHER namespace
  (`/wp-json/lu/v1/write/stream-chunk` OR `/api/internal/write/stream-chunk`) and polls
  Laravel's live `GET /api/internal/write/stream-poll`. The chunk push still posts to the
  caller-supplied `callback_url` verbatim (caller contract — Laravel controls it).

## Cleaned up / hardened
- **tool-executor.js** — removed the dead `https://staging1.shukranuae.com/wp-json/...`
  fallback default for `WP_BASE`; now defaults to `LARAVEL_BASE_URL || LARAVEL_URL || ''`.
  (The actual `/api/internal/tools/execute` dispatch already preferred LARAVEL_BASE_URL.)
- **campaign-learning.js / behavior-analysis.js** — base resolution harmonized from
  `LARAVEL_URL || wp_url` to `LARAVEL_BASE_URL || LARAVEL_URL || wp_url` (consistency with
  the rest of the runtime). Their `/api/internal/*` calls were already converted.
- **lu-tool-executor.js** — stale JSDoc updated (WP REST → Laravel internal). No code change.
- Version bumped to **2.34.2** in `package.json` + `/health` response.
- `.railway-trigger` nudged.

## NOT converted — one genuine gap (needs a Laravel route, not a runtime fix)
- **lu-worker-manager.js:320** — `GET /wp-json/lumkt/v1/sequences/{id}` (fetch a single
  automation sequence WITH its steps). Laravel only exposes
  `/api/internal/automation/sequences` as a **LIST** — no `/{id}` variant. Converting blindly
  would 404 just like the legacy path. Marked in-code as a KNOWN GAP. **Action required:**
  add `GET /api/internal/automation/sequences/{id}` (returning `{steps:[...]}`) on the Laravel
  side, then point this call at it. No regression vs 2.33/2.34.x (it 404s either way today).

## Left intentionally (correct as-is)
- **agents.js:93** — the `/wp-json/...` string is a last-resort base-derivation from the
  legacy `WP_CALLBACK_URL` env var; the active call already uses `/api/internal/agents`.

## Verification (2026-06-30)
- `node --check` on all 74 `.js` — PASS (local node v24 AND droplet node v20.20.2, == Railway).
- All 15 distinct `/api/internal/*` endpoints called by the runtime confirmed to exist in
  Laravel staging `route:list` (incl. workspace/{id}/context, write/stream-poll, task-result).
- **NOT runtime-tested end-to-end** (cannot run/deploy Railway from the build host).

## REQUIRED on deploy (Railway env) — unchanged from 2.34.1
- `LARAVEL_BASE_URL=https://staging.levelupgrowth.io` (or `LARAVEL_URL`).
- Secret alignment: `WP_SECRET == LU_SECRET == Laravel RUNTIME_SECRET` (already aligned —
  live ping shows wp_secret=✓ lu_secret=✓).
