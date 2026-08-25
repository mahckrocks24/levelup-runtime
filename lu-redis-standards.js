'use strict';

/**
 * LevelUp — Redis Standards (Patch 5)
 *
 * Single source of truth for:
 *   - Key naming conventions
 *   - TTL strategy per key type
 *   - Memory limits + eviction policy
 *
 * EVICTION POLICY (set on Railway Redis):
 *   maxmemory-policy = allkeys-lru
 *   maxmemory        = 450mb   (leave headroom on 512mb plan)
 *
 * To apply:
 *   redis-cli CONFIG SET maxmemory-policy allkeys-lru
 *   redis-cli CONFIG SET maxmemory 450mb
 *
 * KEY NAMING CONVENTION
 * ─────────────────────────────────────────────────────────────────
 * Pattern:  lu:{domain}:{entity}:{id}[:{field}]
 *
 * Domains:
 *   stream    — streaming session state
 *   task      — agent task lifecycle
 *   rl        — rate limiting windows
 *   cache     — short-lived computed values
 *   ws        — workspace context
 *   session   — user auth sessions
 *   bull      — BullMQ internal (managed by BullMQ, do NOT touch)
 *
 * TTL STRATEGY
 * ─────────────────────────────────────────────────────────────────
 * Rule: everything has a TTL. No persistent data in Redis.
 * Persistent data → MySQL (lu_write_items, lucreative_blueprints, etc.)
 */

// ── Stream keys ──────────────────────────────────────────────────────
const STREAM = {
  // lu:stream:{jti}         → Hash: status, complete, error, cancelled
  STATE_KEY:   (jti) => `lu:stream:${jti}`,
  // lu:stream:{jti}:chunks  → List: RPUSH text chunks, LRANGE for poll
  CHUNKS_KEY:  (jti) => `lu:stream:${jti}:chunks`,
  TTL: 300,   // 5 minutes — covers longest possible generation
};

// ── Task lifecycle keys ───────────────────────────────────────────────
const TASK = {
  STATE_KEY:   (id) => `lu:task:${id}:state`,
  META_KEY:    (id) => `lu:task:${id}:meta`,
  LOG_KEY:     (id) => `lu:task:${id}:log`,
  TOOL_KEY:    (id) => `lu:task:${id}:tools`,
  TTL: 86_400 * 90,   // 90 days — matches WP lu_tasks table retention
};

// ── Rate limiting keys ────────────────────────────────────────────────
const RATE_LIMIT = {
  KEY: (scope, id, windowBucket) => `lu:rl:${scope}:${id}:${windowBucket}`,
  // TTL set dynamically = window_seconds + 5 buffer
  // allkeys-lru ensures these evict before task/stream keys
};

// ── Cache keys ────────────────────────────────────────────────────────
const CACHE = {
  WORKSPACE_CONTEXT: (wsId) => `lu:cache:ws:${wsId}:context`,
  WS_CONTEXT_TTL: 300,            // 5 min — workspace data changes infrequently

  TOOL_REGISTRY:   ()     => `lu:cache:tool:registry`,
  TOOL_REGISTRY_TTL: 3_600,       // 1 hour

  SEO_BRIEF:       (postId) => `lu:cache:seo:brief:${postId}`,
  SEO_BRIEF_TTL:  1_800,          // 30 min

  SCAN_RESULT:     (urlHash) => `lu:cache:scan:${urlHash}`,
  SCAN_RESULT_TTL: 3_600,         // 1 hour — re-scan threshold
};

// ── Session / auth keys ───────────────────────────────────────────────
const SESSION = {
  TOKEN_KEY: (tokenHash) => `lu:session:${tokenHash}`,
  TTL: 86_400 * 30,   // 30 days — matches WP token store TTL
};

// ── BullMQ managed keys (READ ONLY — never write these manually) ──────
const BULL = {
  // bull:{queue-name}:*   — managed entirely by BullMQ
  // Do NOT use redis.del, redis.set on any bull:* key directly.
  PREFIX: 'bull',
  QUEUE_PREFIX: (name) => `bull:${name}`,
};

// ── Memory budget (approximate at 50k users) ─────────────────────────
//
// Streams (active sessions):
//   Assume 500 concurrent streams × 50KB avg = 25MB
//
// Tasks (active + recent):
//   Assume 5,000 active tasks × 2KB state = 10MB
//
// Rate limits:
//   ~20,000 active users × 10 keys × 50 bytes = 10MB
//
// BullMQ (job data in Redis):
//   ~1,000 queued jobs × 2KB = 2MB
//
// Cache:
//   ~5MB reserve
//
// TOTAL: ~52MB active data. Well within 450MB limit.
// LRU eviction handles spikes safely.
//
const MEMORY = {
  MAX_MB:          450,
  POLICY:          'allkeys-lru',
  CONFIG_COMMANDS: [
    'CONFIG SET maxmemory 450mb',
    'CONFIG SET maxmemory-policy allkeys-lru',
    'CONFIG SET hz 20',           // More frequent background expiry
    'CONFIG SET lazyfree-lazy-eviction yes',  // Non-blocking eviction
  ],
};

// ── TTL helper ────────────────────────────────────────────────────────
/**
 * Set a key with value and TTL in a single SETEX / pipeline.
 * Prefer this over separate SET + EXPIRE to avoid TTL race conditions.
 */
async function setWithTtl(redis, key, value, ttlSecs) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  await redis.setex(key, ttlSecs, serialized);
}

/**
 * Get + parse a JSON-encoded cache key. Returns null on miss.
 */
async function getJson(redis, key) {
  const raw = await redis.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

module.exports = {
  STREAM,
  TASK,
  RATE_LIMIT,
  CACHE,
  SESSION,
  BULL,
  MEMORY,
  setWithTtl,
  getJson,
};
