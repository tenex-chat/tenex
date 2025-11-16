import type { AgentInstance } from "@/agents/types";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

export type EventFilter = (event: NDKEvent) => boolean;

export interface SessionData {
    sessionId?: string;
    lastSentEventId?: string;
}

/**
 * Manages session state for agent execution, including session resumption
 * and event filtering for providers that support it (like Claude Code)
 */
export class SessionManager {
    private sessionId?: string;
    private lastSentEventId?: string;

    constructor(
        private agent: AgentInstance,
        private conversationId: string
    ) {
        this.loadSession();
    }

    /**
     * Load session data from metadata store
     */
    private loadSession(): void {
        const metadataStore = this.agent.createMetadataStore(this.conversationId);
        this.sessionId = metadataStore.get<string>("sessionId");
        this.lastSentEventId = metadataStore.get<string>("lastSentEventId");

        if (this.sessionId) {
            logger.info("[SessionManager] ✅ Found existing session to resume", {
                sessionId: this.sessionId,
                agent: this.agent.name,
                conversationId: this.conversationId.substring(0, 8),
                lastSentEventId: this.lastSentEventId || "NONE",
            });
        }
    }

    /**
     * Get current session data
     */
    getSession(): SessionData {
        return {
            sessionId: this.sessionId,
            lastSentEventId: this.lastSentEventId,
        };
    }

    /**
     * Store session ID and last sent event ID
     */
    saveSession(sessionId: string, lastSentEventId: string): void {
        const metadataStore = this.agent.createMetadataStore(this.conversationId);
        metadataStore.set("sessionId", sessionId);
        metadataStore.set("lastSentEventId", lastSentEventId);

        // Update local state
        this.sessionId = sessionId;
        this.lastSentEventId = lastSentEventId;

        logger.info("[SessionManager] 💾 Stored session ID and last sent event", {
            sessionId,
            lastSentEventId: lastSentEventId.substring(0, 8),
            agent: this.agent.name,
            conversationId: this.conversationId.substring(0, 8),
        });
    }

    /**
     * Store only the last sent event ID (for new sessions without a session ID yet)
     */
    saveLastSentEventId(lastSentEventId: string): void {
        const metadataStore = this.agent.createMetadataStore(this.conversationId);
        metadataStore.set("lastSentEventId", lastSentEventId);

        this.lastSentEventId = lastSentEventId;

        logger.info("[SessionManager] 📝 Stored lastSentEventId", {
            lastSentEventId: lastSentEventId.substring(0, 8),
            agent: this.agent.name,
            conversationId: this.conversationId.substring(0, 8),
        });
    }

    /**
     * Create an event filter for session resumption
     * Filters out events before and including the last sent event
     */
    createEventFilter(): EventFilter | undefined {
        if (!this.sessionId || !this.lastSentEventId) {
            return undefined;
        }

        const lastSentEventId = this.lastSentEventId;

        logger.info("[SessionManager] 📋 Created event filter for resumed session", {
            lastSentEventId: lastSentEventId.substring(0, 8),
            willFilterEvents: true,
        });

        let foundLastSent = false;
        return (event: NDKEvent) => {
            // Skip events until we find the last sent one
            if (!foundLastSent) {
                if (event.id === lastSentEventId) {
                    foundLastSent = true;
                    logger.debug("[SessionManager] 🎯 Found last sent event, excluding it", {
                        eventId: event.id.substring(0, 8),
                        content: event.content?.substring(0, 50),
                    });
                    return false;
                }
                logger.debug("[SessionManager] ⏭️ Skipping event (before last sent)", {
                    eventId: event.id.substring(0, 8),
                    content: event.content?.substring(0, 50),
                    lookingFor: lastSentEventId.substring(0, 8),
                });
                return false;
            }
            logger.debug("[SessionManager] ✅ Including event (after last sent)", {
                eventId: event.id.substring(0, 8),
                content: event.content?.substring(0, 50),
            });
            return true;
        };
    }
}
