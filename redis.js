'use strict';

const Redis = require('ioredis');

/**
 * Creates a Redis connection for use with BullMQ and general caching.
 *
 * Railway injects REDIS_URL automatically when the Redis plugin is added.
 * Format: redis://default:password@host:port
 *
 * BullMQ requires maxRetriesPerRequest: null — do not remove this.
 */
function createRedisConnection() {
    const url = process.env.REDIS_URL || 'redis://localhost:6379';

    const client = new Redis(url, {
        maxRetriesPerRequest: null,   // BullMQ requires null — do NOT change
        enableReadyCheck:     false,
        connectTimeout:       5000,   // Fail fast if Redis unreachable at connect time
        commandTimeout:       5000,   // Individual command timeout — prevents indefinite hangs
        retryStrategy(times) {
            if (times > 5) return null;   // Stop after 5 retries (was 10)
            return Math.min(times * 300, 2000);
        },
        reconnectOnError(err) {
            // Reconnect on connection-level errors only
            return err.message.includes('ECONNREFUSED') || err.message.includes('ETIMEDOUT');
        },
    });

    client.on('connect', () => {
        console.log('[REDIS] Connected successfully.');
    });

    client.on('error', (err) => {
        console.error('[REDIS] Connection error:', err.message);
    });

    client.on('reconnecting', () => {
        console.warn('[REDIS] Reconnecting…');
    });

    return client;
}

/**
 * Creates a separate Redis connection for pub/sub.
 * BullMQ requires a dedicated connection for subscriptions.
 */
function createRedisPubSubConnection() {
    return createRedisConnection();
}

/**
 * Creates a Redis connection for assistant/memory use.
 * Stricter timeout: 3s command timeout so assistant route never hangs on Redis.
 */
function createAssistantRedisConnection() {
    const url = process.env.REDIS_URL || 'redis://localhost:6379';
    const client = new Redis(url, {
        maxRetriesPerRequest: 1,      // Give up after 1 retry for user-facing calls
        enableReadyCheck:     false,
        connectTimeout:       3000,
        commandTimeout:       3000,
        retryStrategy(times) {
            if (times > 2) return null;
            return 500;
        },
    });
    client.on('error', err => console.warn('[REDIS:assistant] Error:', err.message));
    return client;
}

module.exports = { createRedisConnection, createRedisPubSubConnection, createAssistantRedisConnection };
