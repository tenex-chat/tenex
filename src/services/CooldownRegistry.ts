/**
 * CooldownRegistry - Tracks aborted conversation:agent tuples to prevent immediate re-routing
 *
 * After an agent is aborted in a conversation, this registry enforces a 15-second cooldown
 * period to prevent the dispatch service from routing new messages to that agent in that
 * conversation. This prevents race conditions where an abort signal crosses with new messages.
 *
 * Key design:
 * - Tuple-based: Cooldown is specific to (conversationId, agentPubkey) pair
 * - Time-based expiry: Tuples expire after COOLDOWN_DURATION_MS
 * - Automatic cleanup: Expired entries are periodically removed
 * - OTL traces: Emits trace events when routing is blocked
 */

import { logger } from "@/utils/logger";
import { shortenConversationId } from "@/utils/conversation-id";
import { trace } from "@opentelemetry/api";

/** Cooldown duration in milliseconds (15 seconds) */
const COOLDOWN_DURATION_MS = 15000;

/** Cleanup interval for expired entries (30 seconds) */
const CLEANUP_INTERVAL_MS = 30000;

interface CooldownEntry {
    projectId: string;
    conversationId: string;
    agentPubkey: string;
    abortedAt: number;
    reason?: string;
}

export class CooldownRegistry {
    private static instance: CooldownRegistry;

    /** Map from "projectId:conversationId:agentPubkey" to cooldown entry */
    private cooldowns: Map<string, CooldownEntry> = new Map();

    /** Cleanup interval handle */
    private cleanupInterval: ReturnType<typeof setInterval> | null = null;

    private constructor() {
        this.startCleanupInterval();
    }

    static getInstance(): CooldownRegistry {
        if (!CooldownRegistry.instance) {
            CooldownRegistry.instance = new CooldownRegistry();
        }
        return CooldownRegistry.instance;
    }

    /**
     * Start periodic cleanup of expired cooldown entries
     */
    private startCleanupInterval(): void {
        this.cleanupInterval = setInterval(() => {
            this.cleanupExpiredEntries();
        }, CLEANUP_INTERVAL_MS);
        this.cleanupInterval.unref();
    }

    /**
     * Remove expired cooldown entries
     */
    private cleanupExpiredEntries(): void {
        const now = Date.now();
        let cleanedCount = 0;

        for (const [key, entry] of this.cooldowns.entries()) {
            if (now - entry.abortedAt > COOLDOWN_DURATION_MS) {
                this.cooldowns.delete(key);
                cleanedCount++;
            }
        }

        if (cleanedCount > 0) {
            trace.getActiveSpan()?.addEvent("cooldown.cleanup_expired", {
                "cooldown.cleaned_count": cleanedCount,
                "cooldown.remaining_count": this.cooldowns.size,
            });
        }
    }

    /**
     * Make a unique key for a project:conversation:agent tuple
     */
    private makeKey(projectId: string, conversationId: string, agentPubkey: string): string {
        return `${projectId}:${conversationId}:${agentPubkey}`;
    }

    /**
     * Add a project:conversation:agent tuple to the cooldown registry
     *
     * @param projectId - The project ID
     * @param conversationId - The conversation ID
     * @param agentPubkey - The agent's pubkey
     * @param reason - Optional reason for the abort (for debugging)
     */
    add(projectId: string, conversationId: string, agentPubkey: string, reason?: string): void {
        const key = this.makeKey(projectId, conversationId, agentPubkey);
        const entry: CooldownEntry = {
            projectId,
            conversationId,
            agentPubkey,
            abortedAt: Date.now(),
            reason,
        };

        this.cooldowns.set(key, entry);

        trace.getActiveSpan()?.addEvent("cooldown.added", {
            "cooldown.project_id": projectId.substring(0, 12),
            "cooldown.conversation_id": shortenConversationId(conversationId),
            "cooldown.agent_pubkey": agentPubkey.substring(0, 12),
            "cooldown.reason": reason ?? "unknown",
            "cooldown.total_count": this.cooldowns.size,
        });

        logger.debug("[CooldownRegistry] Added cooldown entry", {
            projectId: projectId.substring(0, 12),
            conversationId: shortenConversationId(conversationId),
            agentPubkey: agentPubkey.substring(0, 12),
            reason,
        });
    }

    /**
     * Check if a project:conversation:agent tuple is in cooldown
     *
     * @param projectId - The project ID
     * @param conversationId - The conversation ID
     * @param agentPubkey - The agent's pubkey
     * @returns true if the tuple is currently in cooldown, false otherwise
     */
    isInCooldown(projectId: string, conversationId: string, agentPubkey: string): boolean {
        const key = this.makeKey(projectId, conversationId, agentPubkey);
        const entry = this.cooldowns.get(key);

        if (!entry) {
            return false;
        }

        const now = Date.now();
        const elapsed = now - entry.abortedAt;

        // Check if cooldown has expired
        if (elapsed > COOLDOWN_DURATION_MS) {
            // Expired - remove and return false
            this.cooldowns.delete(key);
            return false;
        }

        // Still in cooldown
        trace.getActiveSpan()?.addEvent("cooldown.check_blocked", {
            "cooldown.project_id": projectId.substring(0, 12),
            "cooldown.conversation_id": shortenConversationId(conversationId),
            "cooldown.agent_pubkey": agentPubkey.substring(0, 12),
            "cooldown.elapsed_ms": elapsed,
            "cooldown.remaining_ms": COOLDOWN_DURATION_MS - elapsed,
            "cooldown.reason": entry.reason ?? "unknown",
        });

        return true;
    }

    /**
     * Get all active cooldown entries (for debugging)
     */
    getActiveCooldowns(): CooldownEntry[] {
        const now = Date.now();
        const active: CooldownEntry[] = [];

        for (const entry of this.cooldowns.values()) {
            if (now - entry.abortedAt <= COOLDOWN_DURATION_MS) {
                active.push(entry);
            }
        }

        return active;
    }

    /**
     * Clear all cooldown entries (for testing)
     */
    clearAll(): void {
        this.cooldowns.clear();
    }

    /**
     * Stop the cleanup interval (for testing/shutdown)
     */
    destroy(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    }
}
