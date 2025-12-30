/**
 * Utility functions for managing conversation execution time
 * Works directly with ConversationStore objects, following DRY principle
 */

import type { ConversationStore } from "./ConversationStore";

/**
 * Start tracking execution time for a conversation
 */
export function startExecutionTime(conversation: ConversationStore): void {
    if (conversation.executionTime.isActive) {
        // Already active - don't restart
        return;
    }

    conversation.executionTime.currentSessionStart = Date.now();
    conversation.executionTime.isActive = true;
    conversation.executionTime.lastUpdated = Date.now();
}

/**
 * Stop tracking execution time and add duration to total
 * @returns Duration of this session in milliseconds
 */
export function stopExecutionTime(conversation: ConversationStore): number {
    if (!conversation.executionTime.isActive || !conversation.executionTime.currentSessionStart) {
        return 0;
    }

    const sessionDuration = Date.now() - conversation.executionTime.currentSessionStart;
    const sessionSeconds = Math.round(sessionDuration / 1000);

    conversation.executionTime.totalSeconds += sessionSeconds;
    conversation.executionTime.currentSessionStart = undefined;
    conversation.executionTime.isActive = false;
    conversation.executionTime.lastUpdated = Date.now();

    return sessionDuration;
}

/**
 * Get total execution time in seconds including any active session
 */
export function getTotalExecutionTimeSeconds(conversation: ConversationStore): number {
    let total = conversation.executionTime.totalSeconds;

    // Add current active session time if any
    if (conversation.executionTime.isActive && conversation.executionTime.currentSessionStart) {
        const activeSeconds = Math.round((Date.now() - conversation.executionTime.currentSessionStart) / 1000);
        total += activeSeconds;
    }

    return total;
}

/**
 * Check if execution is currently active
 */
export function isExecutionActive(conversation: ConversationStore): boolean {
    return conversation.executionTime?.isActive ?? false;
}
