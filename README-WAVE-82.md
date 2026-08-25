# Wave 82 — Runtime SEO Intelligence Upload Package

## What's in this package

| File | Purpose | Action |
|---|---|---|
| `tool-seo-intelligence.js` | NEW file with 6 ported SEO algorithms + Express route handlers | **Drop into runtime root** (same folder as `index.js`) |
| `index.js` | Modified copy of runtime `index.js` with the require + mount call added | **Replace existing `index.js`** OR apply `index.js.patch` manually |
| `index.js.patch` | Unified diff showing the 2 added lines | For manual review/application |
| `test-parity.js` | Standalone Node test that verifies the 6 algorithms work | Run on Railway after deploy: `node test-parity.js` |
| `README-WAVE-82.md` | This file | Reference |

## What was ported

6 algorithms moved from Laravel `_local()` PHP methods to Node.js runtime:

| JS function | Replaces PHP method | Route exposed |
|---|---|---|
| `extractAnchor` | `SeoService::extractNaturalAnchor_local` | `POST /internal/seo/extract-anchor` |
| `scoreCtr` | `SeoService::scoreCtrPotential_local` | `POST /internal/seo/score-ctr` |
| `computeSerpScore` | `SeoService::computeSerpScore_local` | `POST /internal/seo/compute-serp-score` |
| `aeoComputeScore` | `AeoAuditService::computeScore_local` | `POST /internal/seo/aeo-score` |
| `detectCorrection` | `SeoAssistantService::detectCorrection_local` | `POST /internal/seo/detect-correction` |
| `classifyIntent` | `SeoAssistantService::detectIntent_local` | `POST /internal/seo/classify-intent` |

## Parity guarantee

`test-parity.js` runs **20 unit checks** covering all 6 algorithms with the same fixture inputs that the Laravel-side Wave 81 QA used. Locally on my Windows machine: **20/20 PASS**. After Railway deploy, run `node test-parity.js` and expect the same.

## Upload steps

1. Copy `tool-seo-intelligence.js` into the runtime's root folder (alongside `index.js`).
2. Replace `index.js` with the modified copy in this package **OR** apply the 2 lines from `index.js.patch`:
   - Line 13 area — add `const seoIntelligence = require('./tool-seo-intelligence');`
   - Just before `// ── 404 ──` block — add `seoIntelligence.mountRoutes(app, requireSecret);`
3. Push to Railway / let auto-deploy run.
4. Verify deployment: `curl -H "X-LevelUp-Secret: $WP_SECRET" https://<runtime>/internal/health` (should still respond).
5. Run parity test: `node test-parity.js` (on Railway shell or locally).

## Activating the routes from Laravel

After Railway has deployed the new endpoints, flip the Laravel feature flag:

```bash
ssh root@134.209.93.41
cd /var/www/levelup-staging
echo "INTELLIGENCE_VIA_RUNTIME=true" >> .env   # (or edit existing line)
php artisan config:clear
systemctl reload php8.3-fpm
```

Then verify on staging:
```bash
# Should still produce the same anchors, scores, etc. as before — just now via runtime.
# Wave 81 left _local() methods in place as fallback, so any runtime hiccup is silent-safe.
```

## Smoke test after activation

From the staging server:
```bash
curl -sk -L --resolve chefredraymundo.com:443:127.0.0.1 \
  "https://chefredraymundo.com/blog/what-does-a-private-chef-cost-in-nj-ny-ct-xk4E" \
  | grep -oE "<a [^>]*href=\"[^\"]*chefredraymundo[^\"]*\">[^<]+</a>" | head -3
```

Expected output (same as today): 3 natural-prose anchors like `"private chef cost New Jersey"`, `"private chef for a dinner"`.

## Rollback

```bash
# Laravel side — instant rollback to local algorithms
echo "INTELLIGENCE_VIA_RUNTIME=false" >> .env
php artisan config:clear
```

No Railway revert needed — Laravel will skip the runtime call.

## What happens next (Wave 84)

Once you've confirmed runtime endpoints are stable for 24-48 hours, run Wave 84 cleanup:
- Delete all `_local()` methods from `SeoService.php`, `AeoAuditService.php`, `SeoAssistantService.php`
- Remove the router pattern — Laravel just calls `RuntimeClient::xxx()` directly
- No Laravel-side fallback (intelligence is canonical in runtime by design)
- Result: Laravel proprietary IP exposure → ZERO

## Files unchanged in this package

These existing runtime files are NOT modified by Wave 82:
- `tool-seo-audit.js` (different feature — URL fetcher)
- `tool-keyword-research.js` (different feature)
- `tool-discovery.js`, `tool-registry.js` (different infrastructure)
- `intelligence-validation.js`, `lu-intelligence-routes.js` (different paths)
- All other 75 runtime files

Wave 82 is **additive** — new file + 2 lines in `index.js`.

## Auth & secret

Routes use the same `X-LevelUp-Secret` header pattern as every other `/internal/*` endpoint. The `requireSecret` middleware is reused, not re-implemented. Same secret as Laravel's `RUNTIME_SECRET` env var.

---

Generated 2026-05-22 by Wave 82 build.
