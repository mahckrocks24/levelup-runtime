# Wave 88 — Governance Intelligence Upload

## Files
- `tool-governance-intelligence.js` — NEW file, drop into runtime root
- `index.js.patch` — 2-line addition to index.js (require + mountRoutes call)
- `test-parity.js` — local parity test (`node test-parity.js`)

## Upload steps

1. Copy `tool-governance-intelligence.js` into runtime root.
2. Apply `index.js.patch` (manually or via patch util):
   - After Wave 82 require block, add:
     ```js
     const govIntelligence = require('./tool-governance-intelligence');
     ```
   - Just before the Wave 82 mountRoutes call (before `seoIntelligence.mountRoutes(...)`), add:
     ```js
     govIntelligence.mountRoutes(app, requireSecret);
     ```
3. Railway redeploys.
4. Verify: `curl -X POST -H "X-LevelUp-Secret: $WP_SECRET" -d '{"engine":"seo","action":"deep_audit","payload":{},"workspace_id":1,"workspace_history_count":0}' $RUNTIME_URL/internal/governance/confidence-score`
   Expected: `{"score":0.95,"reason":"read-only","approval_mode":"auto"}`

## What it does
Replaces `ConfidenceScorer::score_local()` PHP algorithm. The proprietary
scoring rules (READ_ONLY/EXTERNAL_WRITES lists, history bonuses, bulk
penalties, threshold tiers) now live in runtime.

## Verification after upload
Laravel already has `INTELLIGENCE_VIA_RUNTIME=true` (from Wave 83) — so as soon as
the runtime endpoint is live, all calls to `ConfidenceScorer::score()` route
through it. No Laravel redeploy needed.
