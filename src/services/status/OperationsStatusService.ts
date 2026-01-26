import { NDKKind } from "@/nostr/kinds";
import { getNDK } from "@/nostr/ndkClient";
import {
    getProjectContext,
    isProjectContextInitialized,
    type ProjectContext,
} from "@/services/projects";
import { formatAnyError } from "@/lib/error-formatter";
import { logger } from "@/utils/logger";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import type { LLMOperation, LLMOperationsRegistry, RALState } from "@/services/LLMOperationsRegistry";
import { config } from "@/services/ConfigService";

/**
 * OperationsStatusService handles publishing of LLM operation status events to Nostr.
 *
 * Publishes one event per conversation (thread root), with:
 * - One e-tag for the conversation ID (thread root event)
 * - Uppercase P-tags for whitelisted human users from config.json
 * - Lowercase p-tags for all agents working on that conversation
 * - One a-tag for the project reference
 *
 * Note: The e-tag points to the conversation/thread root ID (not individual message IDs),
 * allowing clients to look up working agents by conversation ID.
 */
export class OperationsStatusService {
    private debounceTimer?: NodeJS.Timeout;
    private unsubscribe?: () => void;
    private publishedConversations = new Set<string>(); // Track which conversations we've published status for
    private lastPublishedConversationAgents = new Map<string, Set<string>>(); // Track which agents were published per conversation
    private lastPublishedRALStates = new Map<string, Map<string, RALState>>(); // Track RAL states per conversation (conversationId -> agentPubkey -> state)

    constructor(
        private registry: LLMOperationsRegistry,
        private debounceMs = 100
    ) {}

    start(): void {
        // Guard against multiple start() calls
        if (this.unsubscribe) {
            logger.warn("[OperationsStatusService] Already started, ignoring duplicate start()");
            return;
        }

        // Subscribe to registry changes
        this.unsubscribe = this.registry.onChange(() => {
            this.schedulePublish();
        });

        // Publish initial state if any operations exist
        this.publishNow().catch((err) => {
            logger.error("[OperationsStatusService] Failed to publish initial state", {
                error: formatAnyError(err),
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

    private async publishNow(): Promise<void> {
        if (!isProjectContextInitialized()) {
            logger.debug(
                "[OperationsStatusService] Project context not initialized, skipping publish"
            );
            return;
        }

        const projectCtx = getProjectContext();
        const operationsByConversation = this.registry.getOperationsByConversation();

        // Keep track of currently active conversations (thread roots)
        const currentConversationIds = new Set(operationsByConversation.keys());

        // Track conversations we need to clean up
        const conversationsToCleanup = new Set<string>();

        // Check which previously published conversations are no longer active
        for (const conversationId of this.publishedConversations) {
            if (!currentConversationIds.has(conversationId)) {
                conversationsToCleanup.add(conversationId);
            }
        }

        // Log current state for debugging
        if (operationsByConversation.size > 0 || conversationsToCleanup.size > 0) {
            logger.debug("[OperationsStatusService] Current state", {
                activeConversations: (Array.from(currentConversationIds) as string[]).map((id) => id.substring(0, 8)),
                previouslyPublished: (Array.from(this.publishedConversations) as string[]).map((id) =>
                    id.substring(0, 8)
                ),
                toCleanup: (Array.from(conversationsToCleanup) as string[]).map((id) => id.substring(0, 8)),
            });
        }

        // Publish one TenexOperationsStatus event per conversation (thread root)
        for (const [conversationId, operations] of operationsByConversation) {
            try {
                // Only publish if state changed or not previously published
                if (
                    !this.publishedConversations.has(conversationId) ||
                    this.hasOperationsChanged(conversationId, operations)
                ) {
                    await this.publishConversationStatus(conversationId, operations, projectCtx);
                    this.publishedConversations.add(conversationId);
                    this.lastPublishedConversationAgents.set(
                        conversationId,
                        new Set(operations.map((op: LLMOperation) => op.agentPubkey))
                    );
                    // Track RAL states for change detection
                    const ralStates = new Map<string, RALState>();
                    for (const op of operations) {
                        ralStates.set(op.agentPubkey, op.ralState ?? "IDLE");
                    }
                    this.lastPublishedRALStates.set(conversationId, ralStates);
                }
            } catch (err) {
                logger.error("[OperationsStatusService] Failed to publish conversation status", {
                    conversationId: conversationId.substring(0, 8),
                    error: formatAnyError(err),
                });
            }
        }

        // Publish cleanup events (empty p-tags) for completed conversations
        for (const conversationId of conversationsToCleanup) {
            try {
                logger.debug("[OperationsStatusService] Publishing cleanup event", {
                    conversationId: conversationId.substring(0, 8),
                });
                await this.publishConversationStatus(conversationId, [], projectCtx);
                this.publishedConversations.delete(conversationId);
                this.lastPublishedConversationAgents.delete(conversationId);
                this.lastPublishedRALStates.delete(conversationId);
            } catch (err) {
                logger.error("[OperationsStatusService] Failed to publish cleanup status", {
                    conversationId: conversationId.substring(0, 8),
                    error: formatAnyError(err),
                });
            }
        }

        logger.debug("[OperationsStatusService] Published status", {
            activeConversations: operationsByConversation.size,
            cleanedConversations: conversationsToCleanup.size,
            totalOperations: (Array.from(operationsByConversation.values()) as LLMOperation[][]).reduce(
                (sum, ops) => sum + ops.length,
                0
            ),
        });
    }

    private hasOperationsChanged(conversationId: string, operations: LLMOperation[]): boolean {
        const lastAgents = this.lastPublishedConversationAgents.get(conversationId);
        if (!lastAgents) return true;

        const currentAgents = new Set(operations.map((op) => op.agentPubkey));
        if (lastAgents.size !== currentAgents.size) return true;

        for (const agent of currentAgents) {
            if (!lastAgents.has(agent)) return true;
        }

        // Check if RAL states have changed
        const lastRALStates = this.lastPublishedRALStates.get(conversationId);
        if (!lastRALStates) return true;

        for (const op of operations) {
            const lastState = lastRALStates.get(op.agentPubkey);
            const currentState = op.ralState ?? "IDLE";
            if (lastState !== currentState) return true;
        }

        return false;
    }

    private async publishConversationStatus(
        conversationId: string,
        operations: LLMOperation[],
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

        // Lowercase p-tags for all agents working on this conversation
        const agentPubkeys = new Set(operations.map((op) => op.agentPubkey));
        for (const pubkey of agentPubkeys) {
            event.tag(["p", pubkey]);
        }

        // A-tag for the project
        event.tag(projectCtx.project.tagReference());

        // Sign with backend signer and publish
        const backendSigner = await config.getBackendSigner();
        await event.sign(backendSigner, { pTags: false });
        await event.publish();

        const isCleanup = operations.length === 0;
        logger.debug("[OperationsStatusService] Published conversation status", {
            conversationId: conversationId.substring(0, 8),
            whitelistedUsers: whitelistedPubkeys.map((p) => p.substring(0, 8)),
            agentCount: agentPubkeys.size,
            operationCount: operations.length,
            type: isCleanup ? "cleanup" : "active",
            pTags: Array.from(agentPubkeys).map((p) => p.substring(0, 8)),
        });
    }
}
