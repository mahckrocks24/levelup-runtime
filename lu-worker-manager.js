'use strict';
const dsModels = require('./deepseek-models'); // DeepSeek V4 registry

/**
 * LevelUp — Worker Manager (v2.25.0)
 *
 * PATCH 1+2: Per-domain workers with correct concurrency, timeout, and retry config.
 *
 * HORIZONTAL SCALING MODEL (Railway):
 *   Single Railway service → multiple replicas (scale slider or auto-scale rule).
 *   Each replica runs ALL workers. This is correct because:
 *     - Workers are isolated processes (BullMQ coordinates via Redis)
 *     - Adding replicas multiplies total throughput linearly
 *     - No shared state between workers (Redis is source of truth)
 *
 *   To scale a specific domain only, set env var ENABLED_WORKERS=scanner,write
 *   and deploy a dedicated worker replica. Other replicas run agent+creative only.
 *
 * SCALING TRIGGERS (Railway auto-scale):
 *   - CPU > 70% for 2 min   → add replica
 *   - CPU < 20% for 5 min   → remove replica (min 1)
 *   - Memory > 80%          → add replica
 *   - Queue waiting > 100   → add replica (via queue monitor cron, not Railway native)
 *
 * ENVIRONMENT VARIABLES:
 *   AGENT_CONCURRENCY=3       WRITE_CONCURRENCY=5
 *   CREATIVE_CONCURRENCY=2    SCANNER_CONCURRENCY=10
 *   SOCIAL_CONCURRENCY=5      MARKETING_CONCURRENCY=3
 *   ENABLED_WORKERS=all       (comma list or 'all')
 */

const { Worker }    = require('bullmq');
const { QUEUE_DEFS, connection, queues, deadQueue } = require('./lu-queues');
const { emit }      = require('./lu-event-bus');

// ── Which workers to start on this instance ──────────────────────────
const ENABLED_RAW = process.env.ENABLED_WORKERS || 'all';
const ENABLED = ENABLED_RAW === 'all'
    ? Object.keys(QUEUE_DEFS)
    : ENABLED_RAW.split(',').map(s => s.trim()).filter(Boolean);

// ── Domain processors ─────────────────────────────────────────────────
// Each domain processor is a function: (job) => Promise<result>
// Heavy domains (agent) delegate to their existing processor.
// New domains (write, creative, scanner, social, marketing) have inline processors.

const processors = {};

// ── Agent user/auto — delegate to existing lu-task-worker processor ─────
// Both queues use the same processor (lu-task-worker). Queue separation
// ensures user tasks always drain first (PRIORITY P1 vs P3).
processors.agent_user = (() => {
    try { return require('./lu-task-worker-fn').processJob; } catch (_) { return null; }
})();
processors.agent_auto = processors.agent_user; // same processor, different queue

// Startup invariant: user concurrency must not be less than auto concurrency
(function validateCapacityConfig() {
    const userC = parseInt(process.env.AGENT_USER_CONCURRENCY || '4');
    const autoC = parseInt(process.env.AGENT_AUTO_CONCURRENCY || '3');
    if (userC < autoC) {
        console.error('[GOVERNANCE] user concurrency < auto — applying safe defaults');
        process.env.AGENT_USER_CONCURRENCY = '4';
        process.env.AGENT_AUTO_CONCURRENCY = '2';
    }
})();

// ── Write — async write job processor ────────────────────────────────
processors.write = async function processWriteJob(job) {
    const { type, payload } = job.data;
    const t0 = Date.now();
    console.log(`[write-worker] START type=${type} job=${job.id}`);

    // Write jobs: generate_draft, improve_draft, rewrite_draft
    // These are dispatched when the streaming path is unavailable or for async use.
    const pathMap = {
        'write.draft':   'internal/write/draft',
        'write.improve': 'internal/write/improve',
        'write.rewrite': 'internal/write/rewrite',
    };
    const path = pathMap[type];
    if (!path) throw new Error(`Unknown write job type: ${type}`);

    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) throw new Error('DEEPSEEK_API_KEY not set');

    // Delegate to existing write endpoint logic
    const { buildWritePrompt } = require('./prompt-assembler');
    const { content_type, title, brief, tone, length, intent, seo_brief } = payload;
    const prompts = buildWritePrompt({ content_type, title, brief, tone, length, intent, seo_brief });

    const dsRes = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({
            model:       dsModels.DEFAULT_MODEL,
            messages:    [{ role: 'system', content: prompts.system }, { role: 'user', content: prompts.user }],
            max_tokens:  dsModels.withReasoningHeadroom(prompts.max_tokens),
            temperature: 0.72,
            stream:      false,  // async job = non-streaming response
        }),
        signal: AbortSignal.timeout(QUEUE_DEFS.write.timeout),
    });

    if (!dsRes.ok) {
        const err = await dsRes.text();
        throw new Error(`DeepSeek ${dsRes.status}: ${err.slice(0, 200)}`);
    }

    const data = await dsRes.json();
    const content = data.choices?.[0]?.message?.content || '';
    if (!content) throw new Error('DeepSeek returned empty content');

    const duration_ms = Date.now() - t0;
    console.log(`[write-worker] DONE type=${type} job=${job.id} ms=${duration_ms}`);

    return { success: true, content, tokens: data.usage?.total_tokens || 0, duration_ms };
};

// ── Scanner — async scanner job processor ────────────────────────────
processors.scanner = async function processScannerJob(job) {
    const { url, workspace_id = 1 } = job.data.payload || {};
    const t0 = Date.now();
    console.log(`[scanner-worker] START url=${url} job=${job.id}`);

    // Reuse scanner endpoint logic (shared with /internal/scanner route)
    const { runScan } = require('./lu-scanner');
    const result = await runScan(url, { workspace_id });
    const duration_ms = Date.now() - t0;

    console.log(`[scanner-worker] DONE url=${url} job=${job.id} ms=${duration_ms}`);
    emit({ type: 'scan_completed', data: { url, job_id: job.id, duration_ms } }).catch(() => {});
    return result;
};

// ── Creative — async creative job processor ───────────────────────────
processors.creative = async function processCreativeJob(job) {
    const { type, payload } = job.data;
    const t0 = Date.now();
    console.log(`[creative-worker] START type=${type} job=${job.id}`);

    // Creative jobs: image generation, video generation
    // These are the slow GPU-expensive operations.
    if (type === 'creative.image') {
        const { generateImage } = require('./lu-creative');
        const result = await generateImage(payload);
        console.log(`[creative-worker] DONE image job=${job.id} ms=${Date.now()-t0}`);
        return result;
    }
    if (type === 'creative.video') {
        const { generateVideo } = require('./lu-creative');
        const result = await generateVideo(payload);
        console.log(`[creative-worker] DONE video job=${job.id} ms=${Date.now()-t0}`);
        return result;
    }

    // ── Video Export — compose layers + timeline into video file ──────
    // Uses ffmpeg to composite layer images onto a canvas at their timeline positions.
    // If ffmpeg is not installed, returns a clear error (Railway needs Dockerfile with ffmpeg).
    if (type === 'video-export') {
        const { execSync } = require('child_process');
        const fs   = require('fs');
        const path = require('path');
        const redis = require('./redis').createRedisConnection();

        const eid = payload.export_id;
        const statusKey = `video-export:${eid}:status`;
        const resultKey = `video-export:${eid}:result`;
        const TTL = 3600; // 1 hour

        try {
            await redis.set(statusKey, 'processing', 'EX', TTL);

            // Check ffmpeg availability
            try { execSync('ffmpeg -version', { stdio: 'pipe' }); } catch(e) {
                const errMsg = 'ffmpeg not installed on this worker. Install ffmpeg in Railway Dockerfile.';
                await redis.set(statusKey, 'failed', 'EX', TTL);
                await redis.set(resultKey, JSON.stringify({ error: errMsg }), 'EX', TTL);
                console.error(`[video-export] ${errMsg}`);
                return { success: false, error: errMsg };
            }

            // Create temp directory for this export
            const tmpDir = path.join('/tmp', `lu-export-${eid}`);
            if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

            const w = payload.width  || 1080;
            const h = payload.height || 1080;
            const dur = payload.duration || 10;
            const fmt = payload.format || 'mp4';
            const outFile = path.join(tmpDir, `export.${fmt}`);

            // Generate a base video canvas (solid color) at project dimensions
            // Then overlay each layer image at its timeline position
            // For V1: create a blank canvas video, then overlay images via ffmpeg filter_complex
            const filterParts = [];
            const inputs = [];

            // Base canvas — black background
            inputs.push(`-f lavfi -i color=c=black:s=${w}x${h}:d=${dur}:r=30`);
            let streamIdx = 1;

            // For each image/video layer, download and overlay
            for (const layer of (payload.layers || [])) {
                if (!layer.content || !layer.visible) continue;
                if (layer.type === 'image' && layer.content.startsWith('http')) {
                    const layerFile = path.join(tmpDir, `layer_${layer.id}.png`);
                    try {
                        execSync(`curl -sL -o ${layerFile} "${layer.content}"`, { timeout: 15000 });
                        if (fs.existsSync(layerFile) && fs.statSync(layerFile).size > 0) {
                            inputs.push(`-i ${layerFile}`);
                            const x = Math.round(parseFloat(layer.position_x) || 0);
                            const y = Math.round(parseFloat(layer.position_y) || 0);
                            const lw = Math.round(parseFloat(layer.width) || 200);
                            const lh = Math.round(parseFloat(layer.height) || 200);
                            // Find timeline entry for this layer
                            const clip = (payload.timeline || []).find(t => String(t.layer_id) === String(layer.id));
                            const st = clip ? parseFloat(clip.start_time) || 0 : 0;
                            const et = clip ? parseFloat(clip.end_time) || dur : dur;
                            const prev = streamIdx === 1 ? '[0]' : `[v${streamIdx-1}]`;
                            filterParts.push(`[${streamIdx}]scale=${lw}:${lh}[s${streamIdx}];${prev}[s${streamIdx}]overlay=${x}:${y}:enable='between(t,${st},${et})'[v${streamIdx}]`);
                            streamIdx++;
                        }
                    } catch(e) { console.warn(`[video-export] Skipping layer ${layer.id}: ${e.message}`); }
                }
            }

            let cmd;
            if (filterParts.length > 0) {
                const filter = filterParts.join(';');
                cmd = `ffmpeg -y ${inputs.join(' ')} -filter_complex "${filter}" -map "[v${streamIdx-1}]" -c:v libx264 -pix_fmt yuv420p -t ${dur} ${outFile}`;
            } else {
                // No overlay layers — just output blank canvas
                cmd = `ffmpeg -y ${inputs[0]} -c:v libx264 -pix_fmt yuv420p -t ${dur} ${outFile}`;
            }

            console.log(`[video-export] Running: ${cmd.substring(0, 200)}...`);
            execSync(cmd, { timeout: 120000, stdio: 'pipe' });

            if (!fs.existsSync(outFile)) {
                throw new Error('ffmpeg produced no output file');
            }

            // Move to uploads directory for serving
            const uploadsDir = path.join(__dirname, 'uploads', 'exports');
            if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
            const finalPath = path.join(uploadsDir, `${eid}.${fmt}`);
            fs.copyFileSync(outFile, finalPath);

            const fileUrl = `/uploads/exports/${eid}.${fmt}`;
            const resultData = { success: true, file_url: fileUrl, duration: dur, format: fmt };

            await redis.set(statusKey, 'completed', 'EX', TTL);
            await redis.set(resultKey, JSON.stringify(resultData), 'EX', TTL);

            // Cleanup tmp
            try { fs.rmSync(tmpDir, { recursive: true }); } catch(e) {}

            console.log(`[video-export] DONE export=${eid} ms=${Date.now()-t0}`);
            return resultData;
        } catch (err) {
            await redis.set(statusKey, 'failed', 'EX', TTL).catch(() => {});
            await redis.set(resultKey, JSON.stringify({ error: err.message }), 'EX', TTL).catch(() => {});
            console.error(`[video-export] FAILED export=${eid}: ${err.message}`);
            throw err;
        } finally {
            redis.disconnect();
        }
    }

    throw new Error(`Unknown creative job type: ${type}`);
};

// ── Social — RETIRED (launch scope, v2.37.3) ──────────────────────────
// Standalone social publishing is not part of the product. The processor is
// kept registered so any job still sitting on the `social` queue from before
// the cutover fails fast and visibly, rather than silently reaching the WP
// social engine. Article sharing does NOT run through here: it is executed by
// the Laravel article-distribution service under the kernel's article-share
// context check.
processors.social = async function processSocialJob(job) {
    const { type } = job.data || {};
    console.warn(`[social-worker] REFUSED type=${type} job=${job.id} — social publishing is not available at launch`);
    throw new Error(`Social publishing is not available at launch (job type '${type}' refused by launch scope)`);
};

// ── Marketing — campaign / sequence job processor ─────────────────────
// LAUNCH SCOPE (v2.37.3): email campaigns and automation sequences are not
// part of the product. The processor stays registered so pre-cutover jobs
// still on the `marketing` queue fail fast and visibly instead of dispatching
// a real send; the original sequence-runner body below is unreachable and is
// retained only so the queue contract and job shape stay documented.
processors.marketing = async function processMarketingJob(job) {
    const { type, payload } = job.data;
    const t0 = Date.now();

    console.warn(`[marketing-worker] REFUSED type=${type} job=${job.id} — email campaigns and sequences are not available at launch`);
    throw new Error(`Email marketing is not available at launch (job type '${type}' refused by launch scope)`);

    /* eslint-disable no-unreachable */
    const { wp_url, wp_secret } = payload || {};
    if (!wp_url || !wp_secret) throw new Error('wp_url and wp_secret required');

    // ── TASK 5.3: Automation sequence runner ─────────────────────────
    if (type === 'automation.run_sequence') {
        const { sequence_id, triggered_by } = payload;

        // Record run start
        const runRes = await fetch(`${process.env.LARAVEL_BASE_URL || process.env.LARAVEL_URL || wp_url}/api/internal/automation/runs`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'X-LevelUp-Secret': wp_secret },
            body:    JSON.stringify({ sequence_id, triggered_by, status: 'running' }),
        }).then(r => r.json()).catch(() => ({}));
        const run_id = runRes.id || null;

        // v2.34.2 KNOWN GAP: Laravel exposes /api/internal/automation/sequences as a LIST
        // only — no single-sequence-with-steps route. Left on legacy path pending a
        // Laravel /api/internal/automation/sequences/{id} endpoint (404s either way today).
        // Fetch sequence steps
        const seqRes = await fetch(`${wp_url}/wp-json/lumkt/v1/sequences/${sequence_id}`, {
            headers: { 'X-LevelUp-Secret': wp_secret },
        }).then(r => r.json()).catch(() => ({}));
        const steps = Array.isArray(seqRes.steps) ? seqRes.steps : [];

        let done = 0;
        for (const step of steps) {
            if ((step.delay_days || 0) > 0) {
                // Schedule delayed step as a future job — don't block
                const { enqueue } = require('./lu-queues');
                await enqueue('marketing', 'automation.run_step', {
                    run_id, step, wp_url, wp_secret,
                }, { delay: (step.delay_days * 86_400_000), priority: 7 }).catch(() => {});
                break;
            }
            // Email step — call send endpoint
            if (step.step_type === 'email' && step.campaign_id) {
                await fetch(`${process.env.LARAVEL_BASE_URL || process.env.LARAVEL_URL || wp_url}/api/internal/campaign/send`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-LevelUp-Secret': wp_secret },
                    body: JSON.stringify({ campaign_id: step.campaign_id }),
                }).catch(() => {});
            }
            done++;
        }

        // Update run status
        if (run_id) {
            await fetch(`${process.env.LARAVEL_BASE_URL || process.env.LARAVEL_URL || wp_url}/api/internal/automation/runs/${run_id}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-LevelUp-Secret': wp_secret },
                body: JSON.stringify({ status: 'completed', steps_done: done }),
            }).catch(() => {});
        }

        console.log(`[marketing-worker] DONE automation.run_sequence seq=${sequence_id} steps=${done} ms=${Date.now()-t0}`);
        return { success: true, sequence_id, steps_done: done, run_id };
    }

    // ── Default: campaign send tool ───────────────────────────────────
    const { campaign_id } = payload;
    const { executeTool } = require('./lu-tool-executor');
    const result = await executeTool({
        tool_id:  'send_campaign',
        agent_id: 'system',
        task_id:  job.id,
        params:   { campaign_id, ...payload },
        wp_url,
        wp_secret,
    });

    console.log(`[marketing-worker] DONE type=${type} job=${job.id} ms=${Date.now()-t0}`);
    return result;
    /* eslint-enable no-unreachable */
};

// ── Worker instances ───────────────────────────────────────────────────
const workers = {};

function startWorkers() {
    for (const domain of ENABLED) {
        const def       = QUEUE_DEFS[domain];
        const processor = processors[domain];

        if (!def) {
            console.warn(`[worker-manager] Unknown domain: ${domain} — skipping`);
            continue;
        }
        if (!processor) {
            console.log(`[worker-manager] Domain ${domain} has no inline processor — managed externally`);
            continue;
        }

        const worker = new Worker(def.name, processor, {
            connection,
            prefix:          'lu',
            concurrency:     def.concurrency,
            lockDuration:    def.lockDuration,
            stalledInterval: Math.floor(def.lockDuration / 3),
            maxStalledCount: 2,
        });

        // Standard event handlers (PATCH 8 — logging)
        worker.on('active',    (job)      => console.log(`[${domain}-worker] active  job=${job.id}`));
        worker.on('completed', (job, res) => console.log(`[${domain}-worker] done    job=${job.id} ok=${res?.success}`));
        worker.on('failed',    async (job, err) => {
            const isExhausted = (job.attemptsMade >= (job.opts?.attempts || 1));
            console.error(`[${domain}-worker] failed  job=${job.id} attempt=${job.attemptsMade} exhausted=${isExhausted} err=${err.message}`);
            emit({ type: `${domain}_job_failed`, data: { job_id: job.id, domain, error: err.message, exhausted: isExhausted } }).catch(() => {});

            if (isExhausted) {
                // Move to DLQ for inspection
                try {
                    await deadQueue.add(`${domain}.dead`, {
                        original_queue:  def.name,
                        original_job_id: job.id,
                        data:            job.data,
                        error:           err.message,
                        attempts:        job.attemptsMade,
                        failed_at:       new Date().toISOString(),
                    });
                } catch (dlqErr) {
                    console.error(`[worker-manager] DLQ write failed:`, dlqErr.message);
                }
            }
        });
        worker.on('stalled',   (id)       => console.warn(`[${domain}-worker] stalled job=${id}`));
        worker.on('error',     (err)      => console.error(`[${domain}-worker] error  `, err.message));

        workers[domain] = worker;
        console.log(`[worker-manager] Started ${domain} worker (concurrency=${def.concurrency})`);
    }

    console.log(`[worker-manager] ${Object.keys(workers).length} domain workers active`);
}

async function stopWorkers() {
    console.log('[worker-manager] Shutting down all domain workers…');
    await Promise.all(Object.values(workers).map(w => w.close()));
    console.log('[worker-manager] All workers stopped');
}

// ── Queue health snapshot for monitoring ──────────────────────────────
async function getWorkerStats() {
    const stats = {};
    for (const [domain, worker] of Object.entries(workers)) {
        stats[domain] = {
            running:     worker.isRunning(),
            concurrency: QUEUE_DEFS[domain].concurrency,
        };
    }
    return stats;
}

// ── Scale recommendation (queue-length based) ─────────────────────────
// Returns suggested replica count based on queue depth.
// Caller (health monitor / Railway webhook) uses this to drive scaling.
async function getScaleRecommendation() {
    const { getAllQueueCounts } = require('./lu-queues');
    const counts = await getAllQueueCounts();
    const recs   = {};

    for (const [domain, c] of Object.entries(counts)) {
        const def     = QUEUE_DEFS[domain];
        const backlog = c.waiting + c.delayed;
        const drainTime = backlog / Math.max(def.concurrency, 1);   // jobs/sec rough estimate

        // Recommend additional replicas if backlog drain time > 60s
        recs[domain] = {
            backlog,
            current_concurrency: def.concurrency,
            recommended_replicas: backlog > 50  ? 3 :
                                  backlog > 20  ? 2 : 1,
            drain_time_estimate_s: Math.round(drainTime * (def.timeout / 1000)),
        };
    }
    return recs;
}

// ── Graceful shutdown ─────────────────────────────────────────────────
process.on('SIGTERM', async () => { await stopWorkers(); process.exit(0); });
process.on('SIGINT',  async () => { await stopWorkers(); process.exit(0); });

module.exports = { startWorkers, stopWorkers, getWorkerStats, getScaleRecommendation, workers };
