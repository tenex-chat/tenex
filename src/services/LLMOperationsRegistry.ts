import type { ExecutionContext } from "@/agents/execution/types";
import type { MessageInjector } from "@/llm/types";
import { logger } from "@/utils/logger";
import { trace } from "@opentelemetry/api";
import { EventEmitter } from "tseep";

/**
 * Constant used as the abort reason when aborting for mid-execution injection.
 * Allows AgentExecutor to distinguish injection aborts from user-initiated stops.
 */
export const INJECTION_ABORT_REASON = "INJECTION_ABORT";

/** RAL state representing the current phase of agent execution */
export type RALState = "IDLE" | "REASONING" | "ACTING" | "STREAMING" | "ERROR";

// Store essential operation metadata
export interface LLMOperation {
    id: string;
    abortController: AbortController;
    eventEmitter: EventEmitter; // For message injection into running executions
    eventId: string; // The event being processed
    agentPubkey: string; // Agent doing the work
    conversationId: string; // Root event ID for conversation
    registeredAt: number; // Timestamp
    /** MessageInjector for Claude Code streams (set via onStreamStart callback) */
    messageInjector?: MessageInjector;
    /** Current RAL state for this operation */
    ralState?: RALState;
}

export class LLMOperationsRegistry {
    private static instance: LLMOperationsRegistry;
    private operations = new Map<string, LLMOperation>();
    private byEvent = new Map<string, Set<string>>();
    private operationsByContext = new Map<string, string>(); // contextKey -> operationId
    private changeListeners = new Set<() => void>();

    // DIAGNOSTIC: Concurrent streaming metrics
    private peakConcurrentOperations = 0;
    private totalOperationsRegistered = 0;
    private concurrencyHistogram = new Map<number, number>(); // concurrency level -> count

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

        // DIAGNOSTIC: Track concurrent streaming metrics
        this.totalOperationsRegistered++;
        const currentConcurrency = this.operations.size;
        if (currentConcurrency > this.peakConcurrentOperations) {
            this.peakConcurrentOperations = currentConcurrency;
        }
        this.concurrencyHistogram.set(
            currentConcurrency,
            (this.concurrencyHistogram.get(currentConcurrency) || 0) + 1
        );

        // Emit OTL event for concurrent operation tracking
        const activeSpan = trace.getActiveSpan();
        activeSpan?.addEvent("llm_ops.operation_registered", {
            "concurrent.current_count": currentConcurrency,
            "concurrent.peak_count": this.peakConcurrentOperations,
            "concurrent.total_registered": this.totalOperationsRegistered,
            "operation.id": operationId.substring(0, 8),
            "operation.agent_name": context.agent.name,
            "operation.agent_pubkey": context.agent.pubkey.substring(0, 8),
            "process.memory_heap_used_mb": Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
            "process.memory_rss_mb": Math.round(process.memoryUsage().rss / 1024 / 1024),
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

        const operationDuration = Date.now() - operation.registeredAt;
        logger.debug("[LLMOpsRegistry] Completed operation", {
            operationId: operationId.substring(0, 8),
            eventId: operation.eventId.substring(0, 8),
            conversationId: operation.conversationId.substring(0, 8),
            duration: operationDuration,
        });

        // DIAGNOSTIC: Track operation completion with concurrency context
        const remainingConcurrency = this.operations.size;
        const activeSpan = trace.getActiveSpan();
        activeSpan?.addEvent("llm_ops.operation_completed", {
            "concurrent.remaining_count": remainingConcurrency,
            "concurrent.peak_count": this.peakConcurrentOperations,
            "operation.id": operationId.substring(0, 8),
            "operation.duration_ms": operationDuration,
            "operation.agent_pubkey": operation.agentPubkey.substring(0, 8),
            "process.memory_heap_used_mb": Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
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

    /**
     * Set the message injector for a streaming Claude Code operation.
     * Called from onStreamStart callback when the stream starts.
     *
     * @param agentPubkey - The agent's public key
     * @param conversationId - The conversation (root event) ID
     * @param injector - The MessageInjector instance
     * @returns Whether an operation was found and updated
     */
    setMessageInjector(agentPubkey: string, conversationId: string, injector: MessageInjector): boolean {
        for (const operation of this.operations.values()) {
            if (
                operation.agentPubkey === agentPubkey &&
                operation.conversationId === conversationId &&
                !operation.abortController.signal.aborted
            ) {
                operation.messageInjector = injector;
                logger.debug("[LLMOpsRegistry] Set message injector", {
                    operationId: operation.id.substring(0, 8),
                    agentPubkey: agentPubkey.substring(0, 8),
                    conversationId: conversationId.substring(0, 8),
                });
                return true;
            }
        }
        return false;
    }

    /**
     * Get the message injector for a streaming Claude Code operation.
     * Returns undefined if no active operation exists or no injector is set.
     *
     * @param agentPubkey - The agent's public key
     * @param conversationId - The conversation (root event) ID
     * @returns The MessageInjector or undefined
     */
    getMessageInjector(agentPubkey: string, conversationId: string): MessageInjector | undefined {
        for (const operation of this.operations.values()) {
            if (
                operation.agentPubkey === agentPubkey &&
                operation.conversationId === conversationId &&
                !operation.abortController.signal.aborted &&
                operation.messageInjector
            ) {
                return operation.messageInjector;
            }
        }
        return undefined;
    }

    /**
     * Update the RAL state for an operation identified by agent and conversation.
     * This is called by RALRegistry when state transitions occur (streaming, tool execution, etc.)
     *
     * @param agentPubkey - The agent's public key
     * @param conversationId - The conversation (root event) ID
     * @param state - The new RAL state
     * @returns Whether an operation was found and updated
     */
    updateRALState(agentPubkey: string, conversationId: string, state: RALState): boolean {
        for (const operation of this.operations.values()) {
            if (
                operation.agentPubkey === agentPubkey &&
                operation.conversationId === conversationId &&
                !operation.abortController.signal.aborted
            ) {
                // Only update and notify if state actually changed
                const previousState = operation.ralState;
                if (previousState === state) {
                    return true; // Found but no change needed
                }

                operation.ralState = state;
                logger.debug("[LLMOpsRegistry] Updated RAL state", {
                    operationId: operation.id.substring(0, 8),
                    agentPubkey: agentPubkey.substring(0, 8),
                    conversationId: conversationId.substring(0, 8),
                    previousState,
                    state,
                });
                // Notify listeners of state change
                this.notifyChange();
                return true;
            }
        }
        return false;
    }

    getActiveOperationsCount(): number {
        return this.operations.size;
    }

    /**
     * DIAGNOSTIC: Get concurrency statistics for bottleneck analysis
     */
    getConcurrencyStats(): {
        current: number;
        peak: number;
        total: number;
        histogram: Record<number, number>;
        activeAgents: string[];
    } {
        return {
            current: this.operations.size,
            peak: this.peakConcurrentOperations,
            total: this.totalOperationsRegistered,
            histogram: Object.fromEntries(this.concurrencyHistogram),
            activeAgents: Array.from(this.operations.values()).map(
                (op) => `${op.agentPubkey.substring(0, 8)}:${op.ralState || "unknown"}`
            ),
        };
    }

    /**
     * DIAGNOSTIC: Reset concurrency metrics (for testing)
     */
    resetConcurrencyMetrics(): void {
        this.peakConcurrentOperations = 0;
        this.totalOperationsRegistered = 0;
        this.concurrencyHistogram.clear();
    }

    /**
     * Get operations grouped by conversation ID (thread root) for publishing.
     * Operations are grouped by conversationId only, not by individual message eventId.
     * This ensures kind:24133 status events use the thread root in the e-tag,
     * allowing clients to look up working agents by conversation ID.
     */
    getOperationsByConversation(): Map<string, LLMOperation[]> {
        const byConversation = new Map<string, LLMOperation[]>();

        for (const operation of this.operations.values()) {
            this.addOperationToConversationMap(byConversation, operation.conversationId, operation);
        }

        return byConversation;
    }

    // NOTE: getOperationsByEvent() was removed - use getOperationsByConversation() instead.
    // If you need per-event grouping, iterate operations and group manually.

    /**
     * Helper to add an operation to the conversation map.
     * Creates the array if it doesn't exist, then appends the operation.
     */
    private addOperationToConversationMap(
        map: Map<string, LLMOperation[]>,
        conversationId: string,
        operation: LLMOperation
    ): void {
        let operations = map.get(conversationId);
        if (!operations) {
            operations = [];
            map.set(conversationId, operations);
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
