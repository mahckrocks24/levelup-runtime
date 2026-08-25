'use strict';

/**
 * LevelUp — Monitor + Logging (Patch 8)
 *
 * Structured JSON logger with:
 *   - Consistent log format across all runtime modules
 *   - Performance metric tracking
 *   - Alert trigger thresholds
 *   - Queue depth monitoring
 *
 * LOG FORMAT
 * ─────────────────────────────────────────────────────────────────
 * Every log line is a single JSON object:
 * {
 *   ts:         ISO timestamp
 *   level:      'info' | 'warn' | 'error' | 'metric'
 *   event:      machine-readable event name (snake_case)
 *   service:    'runtime' | 'worker-lu:write' | etc.
 *   pid:        process PID
 *   ...fields   event-specific fields
 * }
 *
 * On Railway: JSON stdout is ingested by Railway logs.
 * For production: pipe to Datadog / Logtail / Axiom via Railway log drain.
 *
 * ALERT TRIGGERS (configure in your log aggregator)
 * ─────────────────────────────────────────────────────────────────
 * event=job_exhausted AND count > 5 in 5min  → PagerDuty: queue DLQ spike
 * event=worker_crash                          → PagerDuty: immediate
 * event=queue_depth AND waiting > 50          → Slack: queue backup
 * event=redis_error                           → Slack: Redis connectivity
 * level=error AND count > 20 in 1min          → Slack: error rate spike
 * p95_ms > 5000 on any endpoint               → Slack: latency spike
 */

const SERVICE = process.env.QUEUE
  ? `worker-${process.env.QUEUE}`
  : 'runtime';

// ── Core logger ──────────────────────────────────────────────────────
function log(level, event, fields = {}) {
  const entry = {
    ts:      new Date().toISOString(),
    level,
    event,
    service: SERVICE,
    pid:     process.pid,
    ...fields,
  };
  // JSON on one line — Railway + Datadog can parse this
  process.stdout.write(JSON.stringify(entry) + '\n');

  // Alert triggers — check thresholds and emit additional signals
  if (level === 'error') _checkAlertThresholds(event, fields);
}

function info(event, fields)   { log('info',   event, fields); }
function warn(event, fields)   { log('warn',   event, fields); }
function error(event, fields)  { log('error',  event, fields); }
function metric(event, fields) { log('metric', event, fields); }

// ── Request timing middleware ─────────────────────────────────────────
/**
 * Express middleware: log every request with method, path, status, ms.
 * Skips /health (noisy) and stream poll (very noisy).
 */
function requestLogger() {
  return function luRequestLogger(req, res, next) {
    if (req.path === '/health' || req.path.startsWith('/stream/poll')) {
      return next();   // Skip noisy endpoints
    }
    const t0 = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - t0;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      log(level, 'http_request', {
        method:  req.method,
        path:    req.path,
        status:  res.statusCode,
        ms,
        ip:      (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(),
        user_id: req.headers['x-lu-user-id'] || null,
      });
      // Patch 8: latency alert
      if (ms > 5_000) {
        warn('slow_request', { path: req.path, ms, threshold_ms: 5_000 });
      }
    });
    next();
  };
}

// ── Queue depth monitor ───────────────────────────────────────────────
/**
 * Poll queue depths every 30s. Emits metric events and triggers
 * alerts when depths exceed thresholds.
 *
 * Call startQueueMonitor(queues) once after queues are initialized.
 */
const DEPTH_THRESHOLDS = {
  'lu:write':     { warn: 10, critical: 50 },
  'lu:creative':  { warn: 5,  critical: 20 },
  'lu:scanner':   { warn: 50, critical: 200 },
  'lu:social':    { warn: 10, critical: 50 },
  'lu:marketing': { warn: 10, critical: 50 },
  'lu:agent':     { warn: 8,  critical: 30 },
};

let _monitorInterval = null;

function startQueueMonitor(queues) {
  if (_monitorInterval) clearInterval(_monitorInterval);
  _monitorInterval = setInterval(async () => {
    for (const [name, q] of Object.entries(queues)) {
      try {
        const waiting = await q.getWaitingCount();
        const active  = await q.getActiveCount();
        const failed  = await q.getFailedCount();
        metric('queue_depth', { queue: name, waiting, active, failed });

        const thresholds = DEPTH_THRESHOLDS[name];
        if (thresholds) {
          if (waiting >= thresholds.critical) {
            error('queue_critical', { queue: name, waiting, threshold: thresholds.critical });
          } else if (waiting >= thresholds.warn) {
            warn('queue_depth_warn', { queue: name, waiting, threshold: thresholds.warn });
          }
        }
      } catch (e) {
        error('queue_monitor_error', { queue: name, error: e.message });
      }
    }
  }, 30_000);
}

function stopQueueMonitor() {
  if (_monitorInterval) { clearInterval(_monitorInterval); _monitorInterval = null; }
}

// ── Alert threshold tracking ─────────────────────────────────────────
const _errorBuckets = new Map();
const ALERT_WINDOW_MS = 60_000;
const ALERT_ERROR_THRESHOLD = 20;

function _checkAlertThresholds(event, fields) {
  const now = Date.now();
  const key = `${SERVICE}:${event}`;
  const bucket = _errorBuckets.get(key) || { count: 0, window_start: now };

  if (now - bucket.window_start > ALERT_WINDOW_MS) {
    // Reset window
    _errorBuckets.set(key, { count: 1, window_start: now });
    return;
  }

  bucket.count++;
  _errorBuckets.set(key, bucket);

  if (bucket.count === ALERT_ERROR_THRESHOLD) {
    // Emit a distinct alert event — log aggregator routes this to PagerDuty/Slack
    log('warn', 'alert_error_rate', {
      event,
      count:       bucket.count,
      window_ms:   ALERT_WINDOW_MS,
      threshold:   ALERT_ERROR_THRESHOLD,
      alert_target: 'slack',
    });
  }
}

// ── Performance tracker ───────────────────────────────────────────────
/**
 * Wrap an async function and log its duration.
 * Use this around AI calls, scanner fetches, etc.
 *
 * @example
 * const result = await timed('deepseek_call', { jti }, () => fetch(...));
 */
async function timed(label, fields, fn) {
  const t0 = Date.now();
  try {
    const result = await fn();
    const ms = Date.now() - t0;
    metric(label + '_duration', { ...fields, ms, success: true });
    return result;
  } catch (err) {
    const ms = Date.now() - t0;
    metric(label + '_duration', { ...fields, ms, success: false, error: err.message });
    throw err;
  }
}

// ── /internal/health/detailed endpoint data ────────────────────────────
async function getHealthDetail(queues) {
  const health = { service: SERVICE, pid: process.pid, ts: new Date().toISOString(), queues: {} };
  for (const [name, q] of Object.entries(queues)) {
    try {
      health.queues[name] = {
        waiting:   await q.getWaitingCount(),
        active:    await q.getActiveCount(),
        failed:    await q.getFailedCount(),
        completed: await q.getCompletedCount(),
      };
    } catch { health.queues[name] = { error: 'unavailable' }; }
  }
  return health;
}

module.exports = {
  info, warn, error, metric,
  requestLogger,
  startQueueMonitor,
  stopQueueMonitor,
  timed,
  getHealthDetail,
};
