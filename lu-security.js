'use strict';

/**
 * LevelUp — Security Hardening (Patch 9)
 *
 * Middleware stack applied globally to the Express runtime.
 * These MUST be applied before any route handlers.
 *
 * STACK (apply in this order in index.js):
 *   1. securityHeaders()   — HTTP security headers
 *   2. bodySizeGuard()     — reject oversized bodies before JSON parse
 *   3. requireSecret       — existing WP_SECRET auth (already in place)
 *   4. rateLimitMiddleware — sliding window (lu-rate-limiter.js)
 *   5. inputValidationGuard — malicious payload scan
 *   6. globalSsrfGuard()  — applied to any route that accepts a URL param
 */

const crypto = require('crypto');

// ── HTTP security headers ────────────────────────────────────────────
/**
 * Adds security headers to all responses.
 * Lightweight replacement for helmet — no additional dependency.
 */
function securityHeaders() {
  return function luSecurityHeaders(req, res, next) {
    // Prevent MIME sniffing
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Prevent clickjacking
    res.setHeader('X-Frame-Options', 'DENY');
    // Referrer policy
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    // Remove server fingerprint
    res.removeHeader('X-Powered-By');
    // HSTS (30 days) — Railway uses HTTPS only
    res.setHeader('Strict-Transport-Security', 'max-age=2592000; includeSubDomains');
    // CSP — runtime only serves JSON, no HTML/scripts to users
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    next();
  };
}

// ── Secret validation — ALL /internal/* routes ───────────────────────
/**
 * Validates WP_SECRET on all /internal/* routes.
 * Uses timing-safe comparison to prevent timing attacks.
 * Already exists as requireSecret in index.js — this version is
 * the hardened drop-in that can replace it.
 */
function requireSecretMiddleware() {
  return function luRequireSecret(req, res, next) {
    const secret = process.env.WP_SECRET || process.env.LU_SECRET;
    if (!secret) {
      console.error('[security] WP_SECRET not set — all /internal/* requests blocked');
      return res.status(503).json({ error: 'runtime_misconfigured' });
    }

    const provided = (
      req.headers['x-levelup-secret'] ||
      req.headers['x-lu-secret']      ||
      ''
    );

    if (!provided) {
      return res.status(401).json({ error: 'missing_secret' });
    }

    // Timing-safe comparison
    const secretBuf   = Buffer.from(secret,   'utf8');
    const providedBuf = Buffer.from(provided, 'utf8');

    // Pad to same length for timingSafeEqual
    const maxLen = Math.max(secretBuf.length, providedBuf.length);
    const a = Buffer.alloc(maxLen, 0); secretBuf.copy(a);
    const b = Buffer.alloc(maxLen, 0); providedBuf.copy(b);

    if (!crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'invalid_secret' });
    }

    next();
  };
}

// ── Global SSRF protection ────────────────────────────────────────────
/**
 * Extract any URL-like fields from request body and validate them.
 * Applies to ALL routes — not just /internal/scanner.
 * Prevents SSRF attacks through any endpoint that proxies URLs.
 *
 * Checked fields: url, image_url, source_url, target_url, callback_url
 *   (callback_url is restricted to known WP base URLs)
 */
const PRIVATE_IP_PATTERNS = [
  /^https?:\/\/localhost/i,
  /^https?:\/\/127\./,
  /^https?:\/\/0\.0\.0\.0/,
  /^https?:\/\/10\./,
  /^https?:\/\/192\.168\./,
  /^https?:\/\/172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^https?:\/\/169\.254\./,
  /^https?:\/\/\[::1\]/,
  /^https?:\/\/\[fc[0-9a-f]{2}:/i,   // IPv6 private
];

function isPrivateUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return PRIVATE_IP_PATTERNS.some(p => p.test(url));
}

const URL_FIELDS = ['url', 'image_url', 'source_url', 'target_url', 'webhook_url'];

function globalSsrfGuard() {
  return function luSsrfGuard(req, res, next) {
    const body = req.body || {};
    for (const field of URL_FIELDS) {
      if (body[field] && isPrivateUrl(body[field])) {
        return res.status(400).json({
          error:   'ssrf_blocked',
          message: `URL in field '${field}' points to a private address. Only public URLs allowed.`,
          field,
        });
      }
    }
    // callback_url special case: must match known WP_URL base
    if (body.callback_url) {
      const wpBase = process.env.WP_URL || '';
      if (wpBase && !body.callback_url.startsWith(wpBase)) {
        return res.status(400).json({
          error:   'callback_url_invalid',
          message: 'callback_url must be within the configured WordPress site.',
        });
      }
    }
    next();
  };
}

// ── Request ID injection ──────────────────────────────────────────────
/**
 * Inject a unique request ID header for distributed tracing.
 * Logged by requestLogger in lu-monitor.js.
 */
function requestId() {
  return function luRequestId(req, res, next) {
    const id = req.headers['x-request-id'] || crypto.randomUUID();
    req.requestId = id;
    res.setHeader('X-Request-Id', id);
    next();
  };
}

// ── JSON parse error handler ──────────────────────────────────────────
/**
 * Catch malformed JSON bodies from express.json() and return clean 400.
 * Must be registered AFTER express.json().
 */
function jsonParseErrorHandler() {
  return function luJsonParseError(err, req, res, next) {
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'invalid_json', message: 'Request body is not valid JSON.' });
    }
    next(err);
  };
}

module.exports = {
  securityHeaders,
  requireSecretMiddleware,
  globalSsrfGuard,
  requestId,
  jsonParseErrorHandler,
  isPrivateUrl,
};
