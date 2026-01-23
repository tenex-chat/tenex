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
 * OperationsStatusPublisher handles publishing of LLM operation status events to Nostr.
 *
 * Publishes one event per event being processed, with:
 * - One e-tag for the event being processed
 * - Uppercase P-tags for whitelisted human users from config.json
 * - Lowercase p-tags for all agents working on that event
 * - One a-tag for the project reference
 */
export class OperationsStatusService {
    private debounceTimer?: NodeJS.Timeout;
    private unsubscribe?: () => void;
    private publishedEvents = new Set<string>(); // Track which events we've published status for
    private lastPublishedState = new Map<string, Set<string>>(); // Track which agents were published per event
    private lastPublishedRALStates = new Map<string, Map<string, RALState>>(); // Track RAL states per event (eventId -> agentPubkey -> state)

    constructor(
        private registry: LLMOperationsRegistry,
        private debounceMs = 100
    ) {}

    start(): void {
        // Guard against multiple start() calls
        if (this.unsubscribe) {
            logger.warn("[OperationsStatusPublisher] Already started, ignoring duplicate start()");
            return;
        }

        // Subscribe to registry changes
        this.unsubscribe = this.registry.onChange(() => {
            this.schedulePublish();
        });

        // Publish initial state if any operations exist
        this.publishNow().catch((err) => {
            logger.error("[OperationsStatusPublisher] Failed to publish initial state", {
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
                logger.error("[OperationsStatusPublisher] Failed to publish status", {
                    error: formatAnyError(err),
                });
            });
        }, this.debounceMs);
    }

    private async publishNow(): Promise<void> {
        if (!isProjectContextInitialized()) {
            logger.debug(
                "[OperationsStatusPublisher] Project context not initialized, skipping publish"
            );
            return;
        }

        const projectCtx = getProjectContext();
        const operationsByEvent = this.registry.getOperationsByEvent();

        // Keep track of currently active events
        const currentEventIds = new Set(operationsByEvent.keys());

        // Track events we need to clean up
        const eventsToCleanup = new Set<string>();

        // Check which previously published events are no longer active
        for (const eventId of this.publishedEvents) {
            if (!currentEventIds.has(eventId)) {
                eventsToCleanup.add(eventId);
            }
        }

        // Log current state for debugging
        if (operationsByEvent.size > 0 || eventsToCleanup.size > 0) {
            logger.debug("[OperationsStatusPublisher] Current state", {
                activeEvents: (Array.from(currentEventIds) as string[]).map((id) => id.substring(0, 8)),
                previouslyPublished: (Array.from(this.publishedEvents) as string[]).map((id) =>
                    id.substring(0, 8)
                ),
                toCleanup: (Array.from(eventsToCleanup) as string[]).map((id) => id.substring(0, 8)),
            });
        }

        // Publish one TenexOperationsStatus event per event being processed
        for (const [eventId, operations] of operationsByEvent) {
            try {
                // Only publish if state changed or not previously published
                if (
                    !this.publishedEvents.has(eventId) ||
                    this.hasOperationsChanged(eventId, operations)
                ) {
                    await this.publishEventStatus(eventId, operations, projectCtx);
                    this.publishedEvents.add(eventId);
                    this.lastPublishedState.set(
                        eventId,
                        new Set(operations.map((op: LLMOperation) => op.agentPubkey))
                    );
                    // Track RAL states for change detection
                    const ralStates = new Map<string, RALState>();
                    for (const op of operations) {
                        ralStates.set(op.agentPubkey, op.ralState ?? 'IDLE');
                    }
                    this.lastPublishedRALStates.set(eventId, ralStates);
                }
            } catch (err) {
                logger.error("[OperationsStatusPublisher] Failed to publish event status", {
                    eventId: eventId.substring(0, 8),
                    error: formatAnyError(err),
                });
            }
        }

        // Publish cleanup events (empty p-tags) for completed events
        for (const eventId of eventsToCleanup) {
            try {
                logger.debug("[OperationsStatusPublisher] Publishing cleanup event", {
                    eventId: eventId.substring(0, 8),
                });
                await this.publishEventStatus(eventId, [], projectCtx);
                this.publishedEvents.delete(eventId);
                this.lastPublishedState.delete(eventId);
                this.lastPublishedRALStates.delete(eventId);
            } catch (err) {
                logger.error("[OperationsStatusPublisher] Failed to publish cleanup status", {
                    eventId: eventId.substring(0, 8),
                    error: formatAnyError(err),
                });
            }
        }

        logger.debug("[OperationsStatusPublisher] Published status", {
            activeEvents: operationsByEvent.size,
            cleanedEvents: eventsToCleanup.size,
            totalOperations: (Array.from(operationsByEvent.values()) as LLMOperation[][]).reduce(
                (sum, ops) => sum + ops.length,
                0
            ),
        });
    }

    private hasOperationsChanged(eventId: string, operations: LLMOperation[]): boolean {
        const lastAgents = this.lastPublishedState.get(eventId);
        if (!lastAgents) return true;

        const currentAgents = new Set(operations.map((op) => op.agentPubkey));
        if (lastAgents.size !== currentAgents.size) return true;

        for (const agent of currentAgents) {
            if (!lastAgents.has(agent)) return true;
        }

        // Check if RAL states have changed
        const lastRALStates = this.lastPublishedRALStates.get(eventId);
        if (!lastRALStates) return true;

        for (const op of operations) {
            const lastState = lastRALStates.get(op.agentPubkey);
            const currentState = op.ralState ?? 'IDLE';
            if (lastState !== currentState) return true;
        }

        return false;
    }

    private async publishEventStatus(
        eventId: string,
        operations: LLMOperation[],
        projectCtx: ProjectContext
    ): Promise<void> {
        const event = new NDKEvent(getNDK());
        event.kind = NDKKind.TenexOperationsStatus;

        // Build runtime payload with elapsed time and state for each agent
        // Note: runtime object is keyed by agentPubkey, so concurrent ops by same agent will overwrite
        const runtime: Record<string, { elapsed_ms: number; state: RALState }> = {};
        const now = Date.now();
        for (const op of operations) {
            const elapsedMs = now - op.registeredAt;
            runtime[op.agentPubkey] = {
                elapsed_ms: elapsedMs,  // Wall-clock time since operation registration
                state: op.ralState ?? 'IDLE',
            };
        }

        // Set content as JSON payload
        event.content = JSON.stringify({ runtime });

        // Single e-tag for the event being processed
        event.tag(["e", eventId]);

        // Uppercase P-tags for whitelisted human users from config
        const whitelistedPubkeys = config.getWhitelistedPubkeys(undefined, config.getConfig());
        for (const pubkey of whitelistedPubkeys) {
            event.tag(["P", pubkey]);
        }

        // Lowercase p-tags for all agents working on this event
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
        logger.debug("[OperationsStatusPublisher] Published event status", {
            eventId: eventId.substring(0, 8),
            whitelistedUsers: whitelistedPubkeys.map((p) => p.substring(0, 8)),
            agentCount: agentPubkeys.size,
            operationCount: operations.length,
            type: isCleanup ? "cleanup" : "active",
            pTags: Array.from(agentPubkeys).map((p) => p.substring(0, 8)),
            runtime,
        });
    }
}
