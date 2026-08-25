# PHASE 1A — Runtime Activation Patch
## Deployment Instructions

**Status:** Safe to deploy to staging

### What changed

| File | Change |
|---|---|
| `index.js` | Wired lu-bootstrap, lu-task-queue-routes, lu-intelligence-routes, lu-activity-routes. Fixed duplicate DM route. Updated startup log to v2.13.0 Phase 1A. |
| `lu-planner.js` | Fixed all 4 `sarah` → `dmm` agent ID mismatches in AGENT_ROSTER key, normalisePlan fallback, roster lookup, and scaffoldPlan default. |
| `package.json` | Version bumped from 0.1.0 to 2.13.0. Description updated from "Sprint A". |

### How to deploy

1. Open your GitHub repo: github.com/mahckrocks24/levelup-runtime2
2. Upload each file by clicking the file name → Edit (pencil icon) → paste content → Commit
3. OR: clone locally, replace these 3 files, push to main

After push, Railway will auto-deploy. Watch the deploy logs for:

```
[STARTUP] LevelUp Runtime v2.13.0 — Phase 1A
[STARTUP] WP_SECRET    : SET ✓
[STARTUP] LU_SECRET    : SET ✓
[STARTUP] DEEPSEEK_KEY : SET ✓
[bootstrap] Phase 8 activity visualization initialized
```

### Verify after deploy

Hit the health endpoint:
```
GET https://levelup-runtime2-production.up.railway.app/health
```

Response must include:
```json
{
  "version": "2.13.0",
  "phase": "1A",
  "modules": {
    "task_queue": true,
    "intelligence": true,
    "activity": true,
    "bootstrap": true
  }
}
```

### New endpoints now active

| Endpoint | Purpose |
|---|---|
| `POST /internal/task/enqueue` | Phase 6 — task queue (replaces legacy /internal/enqueue) |
| `GET /internal/task/status/:id` | Phase 6 — task status polling |
| `POST /internal/intelligence/plan` | Phase 7 — multi-agent task planning |
| `GET /internal/intelligence/memory/workspace` | Phase 7 — workspace memory read |
| `POST /internal/intelligence/memory/workspace` | Phase 7 — workspace memory write |
| `GET /internal/intelligence/trace/:id` | Phase 7 — reasoning trace |
| `GET /internal/activity/stream` | Phase 8 — SSE activity stream |
| `POST /internal/agent/plan` | Backward-compat alias for PHP lu_agent_plan_create |

