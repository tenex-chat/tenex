/**
 * Utility functions for managing conversation execution time
 * Works directly with Conversation objects, following DRY principle
 */

import type { Conversation } from "./types";

/**
 * Start tracking execution time for a conversation
 */
export function startExecutionTime(conversation: Conversation): void {
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
export function stopExecutionTime(conversation: Conversation): number {
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
 * Ensure conversation has execution time initialized (for loaded conversations)
 */
export function ensureExecutionTimeInitialized(conversation: Conversation): void {
    if (!conversation.executionTime) {
        conversation.executionTime = {
            totalSeconds: 0,
            currentSessionStart: undefined,
            isActive: false,
            lastUpdated: Date.now(),
        };
        return;
    }

    // Crash recovery: if execution was active but daemon restarted,
    // reset the active state as the session was lost
    if (conversation.executionTime.isActive) {
        const timeSinceLastUpdate = Date.now() - conversation.executionTime.lastUpdated;
        const maxSessionTime = 30 * 60 * 1000; // 30 minutes max reasonable session

        if (timeSinceLastUpdate > maxSessionTime) {
            // Consider the session lost and reset state
            conversation.executionTime.isActive = false;
            conversation.executionTime.currentSessionStart = undefined;
            conversation.executionTime.lastUpdated = Date.now();
        }
    }
}
