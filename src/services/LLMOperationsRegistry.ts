import type { ExecutionContext } from "@/agents/execution/types";
import { logger } from "@/utils/logger";
import { EventEmitter } from "tseep";

/**
 * Constant used as the abort reason when aborting for mid-execution injection.
 * Allows AgentExecutor to distinguish injection aborts from user-initiated stops.
 */
export const INJECTION_ABORT_REASON = "INJECTION_ABORT";

// Store essential operation metadata
export interface LLMOperation {
    id: string;
    abortController: AbortController;
    eventEmitter: EventEmitter; // For message injection into running executions
    eventId: string; // The event being processed
    agentPubkey: string; // Agent doing the work
    conversationId: string; // Root event ID for conversation
    registeredAt: number; // Timestamp
}

export class LLMOperationsRegistry {
    private static instance: LLMOperationsRegistry;
    private operations = new Map<string, LLMOperation>();
    private byEvent = new Map<string, Set<string>>();
    private operationsByContext = new Map<string, string>(); // contextKey -> operationId
    private changeListeners = new Set<() => void>();

    static getInstance(): LLMOperationsRegistry {
        if (!LLMOperationsRegistry.instance) {
            LLMOperationsRegistry.instance = new LLMOperationsRegistry();
        }
        return LLMOperationsRegistry.instance;
    }

    registerOperation(context: ExecutionContext): AbortSignal {
        const operationId = crypto.randomUUID();
        const conversation = context.getConversation();
        const rootEventId = conversation?.getRootEventId() || context.triggeringEvent.id;

        // Create operation with metadata
        const operation: LLMOperation = {
            id: operationId,
            abortController: new AbortController(),
            eventEmitter: new EventEmitter(),
            eventId: context.triggeringEvent.id,
            agentPubkey: context.agent.pubkey,
            conversationId: rootEventId,
            registeredAt: Date.now(),
        };

        // Store the operation
        this.operations.set(operationId, operation);

        // Index by both root event and triggering event
        this.indexOperation(operationId, rootEventId);
        if (context.triggeringEvent.id !== rootEventId) {
            this.indexOperation(operationId, context.triggeringEvent.id);
        }

        // Also index by context for easy lookup on completion
        this.operationsByContext.set(this.getContextKey(context), operationId);

        // Auto-cleanup on abort (for cancellation cases)
        operation.abortController.signal.addEventListener("abort", () => {
            this.cleanupOperation(operationId);
        });

        logger.debug("[LLMOpsRegistry] Registered operation", {
            operationId: operationId.substring(0, 8),
            rootEvent: rootEventId.substring(0, 8),
            triggeringEvent: context.triggeringEvent.id.substring(0, 8),
            agent: context.agent.name,
            agentPubkey: context.agent.pubkey.substring(0, 8),
        });

        // Notify listeners of new operation
        this.notifyChange();

        return operation.abortController.signal;
    }

    completeOperation(context: ExecutionContext): void {
        const contextKey = this.getContextKey(context);
        const operationId = this.operationsByContext.get(contextKey);

        if (!operationId) {
            // Operation was never registered or already completed
            return;
        }

        // Remove context mapping
        this.operationsByContext.delete(contextKey);

        // Do the actual cleanup
        this.cleanupOperation(operationId);
    }

    private cleanupOperation(operationId: string): void {
        const operation = this.operations.get(operationId);
        if (!operation) {
            // Already cleaned up
            return;
        }

        // Remove from main map
        this.operations.delete(operationId);

        // Remove from all indices
        this.unindexOperation(operationId, operation.conversationId);
        if (operation.eventId !== operation.conversationId) {
            this.unindexOperation(operationId, operation.eventId);
        }

        logger.debug("[LLMOpsRegistry] Completed operation", {
            operationId: operationId.substring(0, 8),
            eventId: operation.eventId.substring(0, 8),
            conversationId: operation.conversationId.substring(0, 8),
            duration: Date.now() - operation.registeredAt,
        });

        // Notify listeners of change
        this.notifyChange();
    }

    private getContextKey(context: ExecutionContext): string {
        // Create a unique key from the context that identifies this specific operation
        return `${context.triggeringEvent.id}:${context.agent.pubkey}`;
    }

    stopByEventId(eventId: string): number {
        const operationIds = this.byEvent.get(eventId) || new Set();
        let stopped = 0;

        for (const opId of operationIds) {
            const operation = this.operations.get(opId);
            if (operation && !operation.abortController.signal.aborted) {
                operation.abortController.abort();
                stopped++;
            }
        }

        if (stopped > 0) {
            logger.info("[LLMOpsRegistry] Stopped operations", {
                eventId: eventId.substring(0, 8),
                count: stopped,
            });
        }

        return stopped;
    }

    /**
     * Stop operations for a specific agent in a conversation.
     * Used to abort streaming execution when mid-stream injection arrives.
     *
     * @param agentPubkey - The agent's public key
     * @param conversationId - The conversation (root event) ID
     * @param reason - Reason for the abort (passed to AbortController)
     * @returns Whether an operation was aborted
     */
    stopByAgentAndConversation(agentPubkey: string, conversationId: string, reason?: string): boolean {
        for (const operation of this.operations.values()) {
            if (
                operation.agentPubkey === agentPubkey &&
                operation.conversationId === conversationId &&
                !operation.abortController.signal.aborted
            ) {
                operation.abortController.abort(reason);
                logger.info("[LLMOpsRegistry] Stopped operation for injection", {
                    operationId: operation.id.substring(0, 8),
                    agentPubkey: agentPubkey.substring(0, 8),
                    conversationId: conversationId.substring(0, 8),
                    reason,
                });
                return true;
            }
        }
        return false;
    }

    getActiveOperationsCount(): number {
        return this.operations.size;
    }

    /**
     * Get operations grouped by event ID for publishing.
     * Each operation appears under both its triggering event ID and conversation root ID.
     */
    getOperationsByEvent(): Map<string, LLMOperation[]> {
        const byEvent = new Map<string, LLMOperation[]>();

        for (const operation of this.operations.values()) {
            this.addOperationToEventMap(byEvent, operation.eventId, operation);

            if (operation.conversationId !== operation.eventId) {
                this.addOperationToEventMap(byEvent, operation.conversationId, operation);
            }
        }

        return byEvent;
    }

    /**
     * Helper to add an operation to the event map.
     * Creates the array if it doesn't exist, then appends the operation.
     */
    private addOperationToEventMap(
        map: Map<string, LLMOperation[]>,
        eventId: string,
        operation: LLMOperation
    ): void {
        let operations = map.get(eventId);
        if (!operations) {
            operations = [];
            map.set(eventId, operations);
        }
        operations.push(operation);
    }

    // Subscribe to changes
    onChange(listener: () => void): () => void {
        this.changeListeners.add(listener);
        return () => this.changeListeners.delete(listener);
    }

    private notifyChange(): void {
        for (const listener of this.changeListeners) {
            listener();
        }
    }

    /**
     * Index an operation by event ID for fast lookup.
     * Creates the Set if it doesn't exist, then adds the operation ID.
     */
    private indexOperation(operationId: string, eventId: string): void {
        let eventOperations = this.byEvent.get(eventId);
        if (!eventOperations) {
            eventOperations = new Set();
            this.byEvent.set(eventId, eventOperations);
        }
        eventOperations.add(operationId);
    }

    private unindexOperation(operationId: string, eventId: string): void {
        this.byEvent.get(eventId)?.delete(operationId);
        if (this.byEvent.get(eventId)?.size === 0) {
            this.byEvent.delete(eventId);
        }
    }
}

export const llmOpsRegistry = LLMOperationsRegistry.getInstance();
