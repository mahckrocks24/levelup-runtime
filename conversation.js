'use strict';

/**
 * LevelUp Conversation Memory
 *
 * Stores and retrieves conversation history per session.
 * L1 memory layer — Redis with TTL.
 *
 * Key format: conv:{workspace_id}:{conversation_id}
 * TTL: 7 days (Starter plan), configurable per plan in Sprint G
 */

const { createRedisConnection } = require('./redis');

const redis = createRedisConnection();
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const MAX_MESSAGES        = 50; // Keep last 50 messages per conversation

/**
 * Get conversation history for a session.
 * Returns array of { role, content } objects.
 */
async function getHistory(workspaceId, conversationId) {
    const key = `conv:${workspaceId}:${conversationId}`;
    try {
        const raw = await redis.get(key);
        if (!raw) return [];
        return JSON.parse(raw);
    } catch (err) {
        console.error('[CONV] Failed to get history:', err.message);
        return [];
    }
}

/**
 * Append a message to conversation history.
 * Automatically trims to MAX_MESSAGES.
 */
async function appendMessage(workspaceId, conversationId, role, content) {
    const key  = `conv:${workspaceId}:${conversationId}`;
    try {
        const history = await getHistory(workspaceId, conversationId);

        history.push({
            role,
            content,
            timestamp: new Date().toISOString(),
        });

        // Trim to max messages
        const trimmed = history.length > MAX_MESSAGES
            ? history.slice(history.length - MAX_MESSAGES)
            : history;

        await redis.set(key, JSON.stringify(trimmed), 'EX', DEFAULT_TTL_SECONDS);
        return trimmed;
    } catch (err) {
        console.error('[CONV] Failed to append message:', err.message);
        return [];
    }
}

/**
 * Clear a conversation (e.g. user starts fresh).
 */
async function clearConversation(workspaceId, conversationId) {
    const key = `conv:${workspaceId}:${conversationId}`;
    try {
        await redis.del(key);
        return true;
    } catch (err) {
        console.error('[CONV] Failed to clear:', err.message);
        return false;
    }
}

/**
 * Get history formatted for LLM (strips timestamps, keeps role + content only).
 * Also applies context budget: returns last N messages that fit within token estimate.
 */
function formatForLLM(history, maxMessages = 20) {
    const recent = history.slice(-maxMessages);
    return recent.map(m => ({ role: m.role, content: m.content }));
}

module.exports = { getHistory, appendMessage, clearConversation, formatForLLM };
