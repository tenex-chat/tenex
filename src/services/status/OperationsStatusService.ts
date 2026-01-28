import { NDKKind } from "@/nostr/kinds";
import { getNDK } from "@/nostr/ndkClient";
import {
    type ProjectContext,
    projectContextStore,
} from "@/services/projects";
import { formatAnyError } from "@/lib/error-formatter";
import { logger } from "@/utils/logger";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { RALRegistry } from "@/services/ral";
import type { RALRegistryEntry } from "@/services/ral";
import { config } from "@/services/ConfigService";

/**
 * OperationsStatusService handles publishing of LLM operation status events to Nostr.
 *
 * Publishes one event per conversation (thread root), with:
 * - One e-tag for the conversation ID (thread root event)
 * - Uppercase P-tags for whitelisted human users from config.json
 * - Lowercase p-tags for agents actively streaming (isStreaming: true OR activeTools.size > 0)
 * - One a-tag for the project reference
 *
 * Note: The e-tag points to the conversation/thread root ID (not individual message IDs),
 * allowing clients to look up working agents by conversation ID.
 *
 * SEMANTICS CHANGE: p-tags now only include agents that are actively streaming or running tools.
 * Agents waiting on delegations no longer appear in p-tags.
 *
 * MULTI-PROJECT ISOLATION: Each OperationsStatusService instance is scoped to a specific project.
 * It filters RALRegistry events by projectId and wraps publishes in AsyncLocalStorage context.
 */
export class OperationsStatusService {
    private debounceTimer?: NodeJS.Timeout;
    private unsubscribe?: () => void;
    private publishedConversations = new Set<string>(); // Track which conversations we've published status for
    private lastPublishedAgents = new Map<string, Set<string>>(); // Track which agents were published per conversation
    private isPublishing = false; // Guard against concurrent publishNow() calls

    constructor(
        private registry: RALRegistry,
        private projectId: string,
        private projectContext: ProjectContext,
        private debounceMs = 1000
    ) {}

    start(): void {
        // Guard against multiple start() calls
        if (this.unsubscribe) {
            logger.warn("[OperationsStatusService] Already started, ignoring duplicate start()");
            return;
        }

        // Subscribe to registry 'updated' events - filter by projectId for multi-project isolation
        const handler = (eventProjectId: string, conversationId: string) => {
            // CRITICAL: Only process events for THIS project
            if (eventProjectId !== this.projectId) {
                return;
            }
            // Track the conversation so it's included in the next publish cycle
            this.publishedConversations.add(conversationId);
            this.schedulePublish();
        };
        this.registry.on("updated", handler);
        this.unsubscribe = () => {
            this.registry.off("updated", handler);
        };

        // Publish initial state (wrapped in project context)
        this.publishNow().catch((err) => {
            logger.error("[OperationsStatusService] Failed to publish initial state", {
                error: formatAnyError(err),
                projectId: this.projectId.substring(0, 20),
            });
        });
    }

    stop(): void {
        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = undefined;
        }
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = undefined;
        }
        // Clear state to prevent stale data on restart
        this.publishedConversations.clear();
        this.lastPublishedAgents.clear();
        this.isPublishing = false;
    }

    private schedulePublish(): void {
        // Clear existing timer
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }

        // Schedule new publish
        this.debounceTimer = setTimeout(() => {
            this.publishNow().catch((err) => {
                logger.error("[OperationsStatusService] Failed to publish status", {
                    error: formatAnyError(err),
                });
            });
        }, this.debounceMs);
    }

    /**
     * Determine if an agent is "active" for status publishing purposes.
     * Active means: isStreaming === true OR activeTools.size > 0
     */
    private isAgentActive(entry: RALRegistryEntry): boolean {
        return entry.isStreaming || entry.activeTools.size > 0;
    }

    private async publishNow(): Promise<void> {
        // Guard against concurrent publishes (can cause race conditions)
        if (this.isPublishing) {
            logger.debug("[OperationsStatusService] Publish already in progress, skipping");
            return;
        }

        this.isPublishing = true;
        try {
            // Wrap the entire publish operation in project context for proper ALS context
            await projectContextStore.run(this.projectContext, () => this.doPublish());
        } finally {
            this.isPublishing = false;
        }
    }

    /**
     * Actual publish logic - must be called within projectContextStore.run()
     */
    private async doPublish(): Promise<void> {
        const projectCtx = this.projectContext;

        // Get all conversations we need to check (currently tracked)
        const conversationsToCheck = new Set(this.publishedConversations);

        // Process each conversation
        const conversationsToCleanup = new Set<string>();
        const activeConversations = new Map<string, Set<string>>(); // conversationId -> set of active agent pubkeys

        for (const conversationId of conversationsToCheck) {
            const entries = this.registry.getConversationEntries(conversationId);
            const activeAgentPubkeys = new Set<string>();

            for (const entry of entries) {
                // CRITICAL: Only include entries for THIS project (multi-project isolation)
                if (entry.projectId !== this.projectId) {
                    continue;
                }
                if (this.isAgentActive(entry)) {
                    activeAgentPubkeys.add(entry.agentPubkey);
                }
            }

            if (activeAgentPubkeys.size > 0) {
                activeConversations.set(conversationId, activeAgentPubkeys);
            } else {
                // No active agents - mark for cleanup
                conversationsToCleanup.add(conversationId);
            }
        }

        // Log current state for debugging
        if (activeConversations.size > 0 || conversationsToCleanup.size > 0) {
            logger.debug("[OperationsStatusService] Current state", {
                activeConversations: Array.from(activeConversations.keys()).map((id) => id.substring(0, 8)),
                previouslyPublished: Array.from(this.publishedConversations).map((id) => id.substring(0, 8)),
                toCleanup: Array.from(conversationsToCleanup).map((id) => id.substring(0, 8)),
            });
        }

        // Publish status for active conversations
        for (const [conversationId, agentPubkeys] of activeConversations) {
            try {
                // Only publish if agents changed
                if (this.hasAgentsChanged(conversationId, agentPubkeys)) {
                    await this.publishConversationStatus(conversationId, agentPubkeys, projectCtx);
                    this.publishedConversations.add(conversationId);
                    this.lastPublishedAgents.set(conversationId, new Set(agentPubkeys));
                }
            } catch (err) {
                logger.error("[OperationsStatusService] Failed to publish conversation status", {
                    conversationId: conversationId.substring(0, 8),
                    error: formatAnyError(err),
                });
            }
        }

        // Publish cleanup events (empty p-tags) for idle conversations
        for (const conversationId of conversationsToCleanup) {
            try {
                logger.debug("[OperationsStatusService] Publishing cleanup event", {
                    conversationId: conversationId.substring(0, 8),
                });
                await this.publishConversationStatus(conversationId, new Set(), projectCtx);
                this.publishedConversations.delete(conversationId);
                this.lastPublishedAgents.delete(conversationId);
            } catch (err) {
                logger.error("[OperationsStatusService] Failed to publish cleanup status", {
                    conversationId: conversationId.substring(0, 8),
                    error: formatAnyError(err),
                });
            }
        }

        const totalActiveAgents = Array.from(activeConversations.values())
            .reduce((sum, agents) => sum + agents.size, 0);

        logger.debug("[OperationsStatusService] Published status", {
            activeConversations: activeConversations.size,
            cleanedConversations: conversationsToCleanup.size,
            totalActiveAgents,
        });
    }

    private hasAgentsChanged(conversationId: string, currentAgents: Set<string>): boolean {
        const lastAgents = this.lastPublishedAgents.get(conversationId);
        if (!lastAgents) return true;

        if (lastAgents.size !== currentAgents.size) return true;

        for (const agent of currentAgents) {
            if (!lastAgents.has(agent)) return true;
        }

        return false;
    }

    private async publishConversationStatus(
        conversationId: string,
        agentPubkeys: Set<string>,
        projectCtx: ProjectContext
    ): Promise<void> {
        const event = new NDKEvent(getNDK());
        event.kind = NDKKind.TenexOperationsStatus;

        // Content is empty - runtime is now tracked in agent publisher events
        event.content = "";

        // Single e-tag for the conversation (thread root)
        event.tag(["e", conversationId]);

        // Uppercase P-tags for whitelisted human users from config
        const whitelistedPubkeys = config.getWhitelistedPubkeys(undefined, config.getConfig());
        for (const pubkey of whitelistedPubkeys) {
            event.tag(["P", pubkey]);
        }

        // Lowercase p-tags for actively streaming agents only
        for (const pubkey of agentPubkeys) {
            event.tag(["p", pubkey]);
        }

        // A-tag for the project
        event.tag(projectCtx.project.tagReference());

        // Sign with backend signer and publish
        const backendSigner = await config.getBackendSigner();
        await event.sign(backendSigner, { pTags: false });
        await event.publish();

        const isCleanup = agentPubkeys.size === 0;
        logger.debug("[OperationsStatusService] Published conversation status", {
            conversationId: conversationId.substring(0, 8),
            whitelistedUsers: whitelistedPubkeys.map((p) => p.substring(0, 8)),
            agentCount: agentPubkeys.size,
            type: isCleanup ? "cleanup" : "active",
            pTags: Array.from(agentPubkeys).map((p) => p.substring(0, 8)),
        });
    }

}
