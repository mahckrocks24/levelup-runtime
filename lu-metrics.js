'use strict';

/**
 * LevelUp — Metrics + Monitoring (v2.25.0)
 *
 * PATCH 8: Centralized structured logging, performance metrics, queue monitoring.
 *
 * LOG FORMAT: NDJSON (newline-delimited JSON)
 *   - Parseable by Railway log drain, Datadog, Logtail, Papertrail
 *   - Each line is a complete JSON object
 *   - Searchable by type, level, task_id, agent_id, etc.
 *
 * ALERT TRIGGERS (configured in monitoring tool):
 *   - error_rate > 5% over 5min        → PagerDuty / Slack
 *   - queue.waiting > 100 for 2min     → auto-scale trigger
 *   - stream.error count > 10/min      → alert
 *   - scanner.timeout count > 5/min    → alert (upstream CDN issue?)
 *   - p99 latency > 5000ms             → alert
 *   - Redis connection errors > 0      → critical alert
 *
 * METRICS ENDPOINT: GET /internal/metrics  (secret-protected)
 *   Returns current snapshot suitable for scraping by Prometheus or Datadog agent.
 */

const { getAllQueueCounts }   = require('./lu-queues');
const { getWorkerStats, getScaleRecommendation } = require('./lu-worker-manager');

// ── In-process metrics counters ───────────────────────────────────────
// These reset on restart. Persistent metrics live in Redis or external system.
const counters = {
    requests_total:     0,
    requests_error:     0,
    streams_started:    0,
    streams_done:       0,
    streams_error:      0,
    scans_started:      0,
    scans_done:         0,
    scans_error:        0,
    jobs_enqueued:      0,
    jobs_completed:     0,
    jobs_failed:        0,
    redis_errors:       0,
};

const histograms = {
    request_latency_ms:  [],
    stream_duration_ms:  [],
    scan_duration_ms:    [],
};

const MAX_HISTOGRAM_SIZE = 1000;  // Rolling window — drop oldest beyond this

// ── Counter helpers ───────────────────────────────────────────────────
function inc(key, by = 1) {
    if (key in counters) counters[key] += by;
}

function recordLatency(key, ms) {
    if (!(key in histograms)) return;
    histograms[key].push(ms);
    if (histograms[key].length > MAX_HISTOGRAM_SIZE) {
        histograms[key].shift();
    }
}

function percentile(arr, p) {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx    = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
}

// ── Structured log emitter ────────────────────────────────────────────
function log(level, type, data = {}) {
    const entry = {
        ts:    new Date().toISOString(),
        level,
        type,
        pid:   process.pid,
        ...data,
    };
    // NDJSON — one JSON object per line
    process.stdout.write(JSON.stringify(entry) + '\n');
}

// Convenience wrappers
const logger = {
    info:  (type, data) => log('INFO',  type, data),
    warn:  (type, data) => log('WARN',  type, data),
    error: (type, data) => log('ERROR', type, data),
    debug: (type, data) => {
        if (process.env.LOG_LEVEL === 'debug') log('DEBUG', type, data);
    },
};

// ── Metrics snapshot builder ──────────────────────────────────────────
async function buildMetricsSnapshot() {
    const [queueCounts, workerStats, scaleRecs] = await Promise.all([
        getAllQueueCounts().catch(() => ({})),
        getWorkerStats().catch(() => ({})),
        getScaleRecommendation().catch(() => ({})),
    ]);

    const uptime_s = Math.floor(process.uptime());
    const mem      = process.memoryUsage();

    return {
        ts:          new Date().toISOString(),
        version:     process.env.npm_package_version || '2.25.0',
        uptime_s,
        process: {
            pid:      process.pid,
            memory_mb: {
                rss:         Math.round(mem.rss         / 1_048_576),
                heap_used:   Math.round(mem.heapUsed    / 1_048_576),
                heap_total:  Math.round(mem.heapTotal   / 1_048_576),
                external:    Math.round(mem.external     / 1_048_576),
            },
        },
        counters: { ...counters },
        latency: {
            request: {
                p50:  percentile(histograms.request_latency_ms, 50),
                p95:  percentile(histograms.request_latency_ms, 95),
                p99:  percentile(histograms.request_latency_ms, 99),
                samples: histograms.request_latency_ms.length,
            },
            stream: {
                p50:  percentile(histograms.stream_duration_ms, 50),
                p95:  percentile(histograms.stream_duration_ms, 95),
                p99:  percentile(histograms.stream_duration_ms, 99),
                samples: histograms.stream_duration_ms.length,
            },
            scanner: {
                p50:  percentile(histograms.scan_duration_ms, 50),
                p95:  percentile(histograms.scan_duration_ms, 95),
                p99:  percentile(histograms.scan_duration_ms, 99),
                samples: histograms.scan_duration_ms.length,
            },
        },
        queues:         queueCounts,
        workers:        workerStats,
        scale_recs:     scaleRecs,
        error_rate_pct: counters.requests_total > 0
            ? ((counters.requests_error / counters.requests_total) * 100).toFixed(2)
            : '0.00',
        alerts: _buildAlerts(queueCounts, counters),
    };
}

function _buildAlerts(queueCounts, counters) {
    const alerts = [];

    // Queue backlog alerts
    for (const [domain, counts] of Object.entries(queueCounts)) {
        if ((counts.waiting || 0) > 100) {
            alerts.push({ severity: 'warning', type: 'queue_backlog', domain, backlog: counts.waiting });
        }
        if ((counts.failed || 0) > 20) {
            alerts.push({ severity: 'error', type: 'queue_failures', domain, failed: counts.failed });
        }
    }

    // Error rate alert
    const errRate = counters.requests_total > 0
        ? (counters.requests_error / counters.requests_total) * 100 : 0;
    if (errRate > 5) {
        alerts.push({ severity: 'warning', type: 'high_error_rate', rate_pct: errRate.toFixed(2) });
    }

    // Redis errors
    if (counters.redis_errors > 0) {
        alerts.push({ severity: 'critical', type: 'redis_errors', count: counters.redis_errors });
    }

    return alerts;
}

// ── Periodic queue monitor log ────────────────────────────────────────
// Logs queue depths every 60s — parseable by monitoring dashboards.
let _monitorInterval = null;

function startQueueMonitor(intervalMs = 60_000) {
    _monitorInterval = setInterval(async () => {
        try {
            const counts = await getAllQueueCounts();
            logger.info('queue_monitor', { queues: counts });
            // Emit alert if any queue is backing up
            for (const [domain, c] of Object.entries(counts)) {
                if ((c.waiting || 0) > 50) {
                    logger.warn('queue_backlog', { domain, waiting: c.waiting, active: c.active });
                }
            }
        } catch (e) {
            logger.error('queue_monitor_error', { error: e.message });
        }
    }, intervalMs);
}

function stopQueueMonitor() {
    if (_monitorInterval) { clearInterval(_monitorInterval); _monitorInterval = null; }
}

module.exports = {
    // Counters
    inc,
    recordLatency,

    // Logging
    logger,

    // Metrics
    buildMetricsSnapshot,

    // Monitor
    startQueueMonitor,
    stopQueueMonitor,
};
