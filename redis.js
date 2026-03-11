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
        maxRetriesPerRequest: null, // Required by BullMQ
        enableReadyCheck:     false,
        retryStrategy(times) {
            // Retry up to 10 times with exponential backoff
            if (times > 10) return null;
            return Math.min(times * 500, 5000);
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

module.exports = { createRedisConnection, createRedisPubSubConnection };
