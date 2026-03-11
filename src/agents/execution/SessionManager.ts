import type { AgentInstance } from "@/agents/types";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

export type EventFilter = (event: NDKEvent) => boolean;

export interface SessionData {
    sessionId?: string;
    lastSentEventId?: string;
    lastSentMessageIndex?: number;
    priorContextTokens?: number;
}

/**
 * Manages session state for agent execution, including session resumption
 * and event filtering for providers that support it.
 */
export class SessionManager {
    private sessionId?: string;
    private lastSentEventId?: string;
    private lastSentMessageIndex?: number;
    private priorContextTokens?: number;
    private storedWorkingDirectory?: string;

    constructor(
        private agent: AgentInstance,
        private conversationId: string,
        private workingDirectory: string
    ) {
        this.loadSession();
    }

    /**
     * Load session data from metadata store.
     * Only loads sessionId if the stored workingDirectory matches current one.
     * This prevents resuming sessions created in a different worktree/branch.
     */
    private loadSession(): void {
        const metadataStore = this.agent.createMetadataStore(this.conversationId);
        const storedSessionId = metadataStore.get<string>("sessionId");
        this.storedWorkingDirectory = metadataStore.get<string>("workingDirectory");
        this.lastSentEventId = metadataStore.get<string>("lastSentEventId");
        this.lastSentMessageIndex = metadataStore.get<number>("lastSentMessageIndex");
        this.priorContextTokens = metadataStore.get<number>("priorContextTokens");

        // Only resume session if workingDirectory matches
        if (storedSessionId && this.storedWorkingDirectory === this.workingDirectory) {
            this.sessionId = storedSessionId;
            logger.info("[SessionManager] ✅ Found existing session to resume", {
                sessionId: this.sessionId,
                agent: this.agent.name,
                conversationId: this.conversationId.substring(0, 8),
                lastSentEventId: this.lastSentEventId || "NONE",
                lastSentMessageIndex: this.lastSentMessageIndex ?? "NONE",
                priorContextTokens: this.priorContextTokens ?? "NONE",
                workingDirectory: this.workingDirectory,
            });
        } else if (storedSessionId) {
            // Session exists but workingDirectory changed - don't resume
            logger.info("[SessionManager] ⚠️ Session exists but workingDirectory changed, starting fresh", {
                storedSessionId,
                storedWorkingDirectory: this.storedWorkingDirectory,
                currentWorkingDirectory: this.workingDirectory,
                agent: this.agent.name,
                conversationId: this.conversationId.substring(0, 8),
            });
            this.lastSentMessageIndex = undefined;
            this.priorContextTokens = undefined;
            metadataStore.set("lastSentMessageIndex", undefined);
            metadataStore.set("priorContextTokens", undefined);
        }
    }

    /**
     * Get current session data
     */
    getSession(): SessionData {
        return {
            sessionId: this.sessionId,
            lastSentEventId: this.lastSentEventId,
            lastSentMessageIndex: this.lastSentMessageIndex,
            priorContextTokens: this.priorContextTokens,
        };
    }

    /**
     * Store session ID, last sent event ID, and working directory
     */
    saveSession(sessionId: string, lastSentEventId: string, lastSentMessageIndex?: number): void {
        const metadataStore = this.agent.createMetadataStore(this.conversationId);
        metadataStore.set("sessionId", sessionId);
        metadataStore.set("lastSentEventId", lastSentEventId);
        if (lastSentMessageIndex !== undefined) {
            metadataStore.set("lastSentMessageIndex", lastSentMessageIndex);
        }
        metadataStore.set("workingDirectory", this.workingDirectory);
        if (this.priorContextTokens !== undefined) {
            metadataStore.set("priorContextTokens", this.priorContextTokens);
        }

        // Update local state
        this.sessionId = sessionId;
        this.lastSentEventId = lastSentEventId;
        if (lastSentMessageIndex !== undefined) {
            this.lastSentMessageIndex = lastSentMessageIndex;
        }

        logger.info("[SessionManager] 💾 Stored session ID and last sent event", {
            sessionId,
            lastSentEventId: lastSentEventId.substring(0, 8),
            lastSentMessageIndex: lastSentMessageIndex ?? "NONE",
            priorContextTokens: this.priorContextTokens ?? "NONE",
            agent: this.agent.name,
            conversationId: this.conversationId.substring(0, 8),
            workingDirectory: this.workingDirectory,
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
     * Store the last sent conversation message index
     */
    saveLastSentMessageIndex(lastSentMessageIndex: number): void {
        const metadataStore = this.agent.createMetadataStore(this.conversationId);
        metadataStore.set("lastSentMessageIndex", lastSentMessageIndex);

        this.lastSentMessageIndex = lastSentMessageIndex;

        logger.info("[SessionManager] 📝 Stored lastSentMessageIndex", {
            lastSentMessageIndex,
            agent: this.agent.name,
            conversationId: this.conversationId.substring(0, 8),
        });
    }

    savePriorContextTokens(priorContextTokens: number | undefined): void {
        const metadataStore = this.agent.createMetadataStore(this.conversationId);
        metadataStore.set("priorContextTokens", priorContextTokens);

        this.priorContextTokens = priorContextTokens;

        logger.info("[SessionManager] 📝 Stored priorContextTokens", {
            priorContextTokens: priorContextTokens ?? "NONE",
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
