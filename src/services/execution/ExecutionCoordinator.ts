/**
 * ExecutionCoordinator
 *
 * Central service for managing agent execution routing, message injection,
 * step timing, and concurrent execution handling.
 *
 * This service sits between the event handler and agent executor to make
 * intelligent decisions about whether to:
 * - Inject messages into an existing agent loop
 * - Start a new execution
 * - Trigger clawback and restart
 * - Start concurrent execution with special tools
 */

import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { EventEmitter } from "tseep";
import { logger } from "@/utils/logger";
import { llmOpsRegistry } from "@/services/LLMOperationsRegistry";
import {
    type EnhancedOperationState,
    type InjectedMessage,
    type RouteContext,
    type RouteDecision,
    type RoutingPolicy,
    DEFAULT_ROUTING_POLICY,
    ClawbackAbortError,
} from "./types";

export class ExecutionCoordinator extends EventEmitter {
    private static instance: ExecutionCoordinator;

    /** Enhanced state for each operation (keyed by operationId) */
    private operationStates = new Map<string, EnhancedOperationState>();

    /** Map from agent pubkey to operation ID for quick lookup */
    private operationsByAgent = new Map<string, string>();

    /** Routing policy */
    private policy: RoutingPolicy;

    /** Clawback check intervals */
    private clawbackTimers = new Map<string, NodeJS.Timeout>();

    private constructor(policy?: Partial<RoutingPolicy>) {
        super();
        this.policy = { ...DEFAULT_ROUTING_POLICY, ...policy };
    }

    static getInstance(policy?: Partial<RoutingPolicy>): ExecutionCoordinator {
        if (!ExecutionCoordinator.instance) {
            ExecutionCoordinator.instance = new ExecutionCoordinator(policy);
        }
        return ExecutionCoordinator.instance;
    }

    /**
     * Reset the singleton instance (for testing)
     */
    static resetInstance(): void {
        if (ExecutionCoordinator.instance) {
            ExecutionCoordinator.instance.cleanup();
        }
        ExecutionCoordinator.instance = undefined as unknown as ExecutionCoordinator;
    }

    /**
     * Main entry point: Route a message for an agent
     *
     * Decides whether to inject into existing execution, start new, or handle specially.
     */
    async routeMessage(context: RouteContext): Promise<RouteDecision> {
        const { agent, event, conversation } = context;

        logger.debug("[ExecutionCoordinator] Routing message", {
            agent: agent.slug,
            eventId: event.id?.substring(0, 8),
            conversationId: conversation.id.substring(0, 8),
        });

        // Find active operation for this agent in this conversation
        const activeOp = this.findActiveOperation(agent.pubkey, conversation.id);

        if (!activeOp) {
            // No active operation - start new execution
            return {
                type: "start-new",
                reason: "No active operation for agent",
            };
        }

        // Check if oldest queued message has waited too long (clawback condition)
        const oldestWaitTime = this.getOldestInjectionWaitTime(activeOp.operationId);
        if (oldestWaitTime > this.policy.maxInjectionWaitMs) {
            logger.info("[ExecutionCoordinator] Triggering clawback", {
                agent: agent.slug,
                operationId: activeOp.operationId.substring(0, 8),
                waitedMs: oldestWaitTime,
                threshold: this.policy.maxInjectionWaitMs,
            });

            this.emit("clawback-triggered", {
                operationId: activeOp.operationId,
                reason: "Injection wait timeout exceeded",
                waitedMs: oldestWaitTime,
            });

            return {
                type: "clawback",
                operationId: activeOp.operationId,
                reason: `Message waited ${Math.round(oldestWaitTime / 1000)}s (threshold: ${this.policy.maxInjectionWaitMs / 1000}s)`,
            };
        }

        // Check if current step has been running too long
        const stepDuration = this.getCurrentStepDuration(activeOp.operationId);
        if (stepDuration !== null && stepDuration > this.policy.maxStepDurationMs) {
            // Step running too long - check if we can interrupt
            if (this.canInterruptCurrentTool(activeOp)) {
                return {
                    type: "clawback",
                    operationId: activeOp.operationId,
                    reason: `Step running for ${Math.round(stepDuration / 1000)}s with interruptible tool`,
                };
            }

            // Cannot interrupt - consider concurrent execution
            if (this.policy.allowConcurrentExecution) {
                logger.info("[ExecutionCoordinator] Starting concurrent execution", {
                    agent: agent.slug,
                    backgroundOp: activeOp.operationId.substring(0, 8),
                    currentTool: activeOp.currentTool?.name,
                });

                return {
                    type: "start-concurrent",
                    backgroundOperation: activeOp,
                    reason: `Step running for ${Math.round(stepDuration / 1000)}s with uninterruptible tool: ${activeOp.currentTool?.name}`,
                };
            }
        }

        // Default: inject into existing operation
        this.queueMessageForInjection(activeOp.operationId, event);

        return {
            type: "inject",
            operationId: activeOp.operationId,
            reason: "Active operation available for injection",
        };
    }

    /**
     * Register a new operation with the coordinator
     */
    registerOperation(
        operationId: string,
        agentPubkey: string,
        agentSlug: string,
        conversationId: string
    ): void {
        const state: EnhancedOperationState = {
            operationId,
            agentPubkey,
            agentSlug,
            conversationId,
            registeredAt: Date.now(),
            stepCount: 0,
            currentStepStartedAt: null,
            lastStepCompletedAt: null,
            injectionQueue: [],
            currentTool: null,
            recentToolNames: [],
        };

        this.operationStates.set(operationId, state);
        this.operationsByAgent.set(agentPubkey, operationId);

        logger.debug("[ExecutionCoordinator] Registered operation", {
            operationId: operationId.substring(0, 8),
            agent: agentSlug,
        });
    }

    /**
     * Unregister an operation (on completion or abort)
     */
    unregisterOperation(operationId: string): void {
        const state = this.operationStates.get(operationId);
        if (state) {
            this.operationsByAgent.delete(state.agentPubkey);
            this.operationStates.delete(operationId);

            // Clear clawback timer
            const timer = this.clawbackTimers.get(operationId);
            if (timer) {
                clearTimeout(timer);
                this.clawbackTimers.delete(operationId);
            }

            logger.debug("[ExecutionCoordinator] Unregistered operation", {
                operationId: operationId.substring(0, 8),
                agent: state.agentSlug,
            });
        }
    }

    /**
     * Called when a step starts (from prepareStep callback)
     */
    onStepStart(operationId: string, stepNumber: number): void {
        const state = this.operationStates.get(operationId);
        if (!state) return;

        state.stepCount = stepNumber;
        state.currentStepStartedAt = Date.now();

        this.emit("step-started", { operationId, stepNumber });

        logger.debug("[ExecutionCoordinator] Step started", {
            operationId: operationId.substring(0, 8),
            stepNumber,
        });
    }

    /**
     * Called when a step completes (from stopWhen or onStepFinish callback)
     */
    onStepComplete(operationId: string, stepNumber: number): void {
        const state = this.operationStates.get(operationId);
        if (!state) return;

        const durationMs = state.currentStepStartedAt
            ? Date.now() - state.currentStepStartedAt
            : 0;

        state.lastStepCompletedAt = Date.now();
        state.currentStepStartedAt = null;
        state.currentTool = null; // Tool completes when step completes

        this.emit("step-completed", { operationId, stepNumber, durationMs });

        logger.debug("[ExecutionCoordinator] Step completed", {
            operationId: operationId.substring(0, 8),
            stepNumber,
            durationMs,
        });

        // Check clawback condition after step completes
        this.checkClawbackCondition(operationId);
    }

    /**
     * Called when a tool starts executing
     */
    onToolStart(operationId: string, toolName: string): void {
        const state = this.operationStates.get(operationId);
        if (!state) return;

        state.currentTool = {
            name: toolName,
            startedAt: Date.now(),
        };

        // Track recent tools (keep last 10)
        state.recentToolNames.push(toolName);
        if (state.recentToolNames.length > 10) {
            state.recentToolNames.shift();
        }

        logger.debug("[ExecutionCoordinator] Tool started", {
            operationId: operationId.substring(0, 8),
            toolName,
        });
    }

    /**
     * Called when a tool completes
     */
    onToolComplete(operationId: string, toolName: string): void {
        const state = this.operationStates.get(operationId);
        if (!state) return;

        if (state.currentTool?.name === toolName) {
            state.currentTool = null;
        }

        logger.debug("[ExecutionCoordinator] Tool completed", {
            operationId: operationId.substring(0, 8),
            toolName,
        });
    }

    /**
     * Queue a message for injection into an active operation
     */
    queueMessageForInjection(
        operationId: string,
        event: NDKEvent,
        priority: "normal" | "urgent" = "normal"
    ): void {
        const state = this.operationStates.get(operationId);
        if (!state) {
            logger.warn("[ExecutionCoordinator] Cannot queue message - operation not found", {
                operationId: operationId.substring(0, 8),
            });
            return;
        }

        const message: InjectedMessage = {
            event,
            queuedAt: Date.now(),
            priority,
        };

        state.injectionQueue.push(message);

        this.emit("message-queued", {
            operationId,
            eventId: event.id || "",
            queuePosition: state.injectionQueue.length,
        });

        logger.info("[ExecutionCoordinator] Message queued for injection", {
            operationId: operationId.substring(0, 8),
            eventId: event.id?.substring(0, 8),
            queueSize: state.injectionQueue.length,
        });

        // Start or reset clawback timer
        this.startClawbackTimer(operationId);
    }

    /**
     * Get and clear pending injected messages for an operation
     */
    drainInjectionQueue(operationId: string): InjectedMessage[] {
        const state = this.operationStates.get(operationId);
        if (!state) return [];

        const messages = [...state.injectionQueue];
        state.injectionQueue = [];

        // Clear clawback timer since queue is drained
        const timer = this.clawbackTimers.get(operationId);
        if (timer) {
            clearTimeout(timer);
            this.clawbackTimers.delete(operationId);
        }

        return messages;
    }

    /**
     * Get the state for an operation
     */
    getOperationState(operationId: string): EnhancedOperationState | undefined {
        return this.operationStates.get(operationId);
    }

    /**
     * Get the current routing policy
     */
    getPolicy(): RoutingPolicy {
        return this.policy;
    }

    /**
     * Find active operation for an agent in a conversation
     */
    findActiveOperation(
        agentPubkey: string,
        conversationId: string
    ): EnhancedOperationState | undefined {
        // First check our enhanced state
        const operationId = this.operationsByAgent.get(agentPubkey);
        if (operationId) {
            const state = this.operationStates.get(operationId);
            if (state && state.conversationId === conversationId) {
                return state;
            }
        }

        // Fall back to LLMOperationsRegistry
        const operationsByEvent = llmOpsRegistry.getOperationsByEvent();
        const activeOps = operationsByEvent.get(conversationId) || [];
        const matchingOp = activeOps.find((op) => op.agentPubkey === agentPubkey);

        if (matchingOp) {
            // Sync state if we don't have it
            let state = this.operationStates.get(matchingOp.id);
            if (!state) {
                // Create state from registry info
                state = {
                    operationId: matchingOp.id,
                    agentPubkey: matchingOp.agentPubkey,
                    agentSlug: "unknown", // We don't have this from registry
                    conversationId: matchingOp.conversationId,
                    registeredAt: matchingOp.registeredAt,
                    stepCount: 0,
                    currentStepStartedAt: null,
                    lastStepCompletedAt: null,
                    injectionQueue: [],
                    currentTool: null,
                    recentToolNames: [],
                };
                this.operationStates.set(matchingOp.id, state);
                this.operationsByAgent.set(agentPubkey, matchingOp.id);
            }
            return state;
        }

        return undefined;
    }

    /**
     * Execute clawback: abort operation and signal restart
     */
    async executeClawback(operationId: string, reason: string): Promise<void> {
        const state = this.operationStates.get(operationId);
        if (!state) return;

        logger.info("[ExecutionCoordinator] Executing clawback", {
            operationId: operationId.substring(0, 8),
            agent: state.agentSlug,
            reason,
        });

        // Abort via LLMOperationsRegistry
        llmOpsRegistry.stopByEventId(state.conversationId);

        // Clean up our state
        this.unregisterOperation(operationId);

        // Throw to signal the abort in the stream
        throw new ClawbackAbortError(operationId, reason);
    }

    /**
     * Check if current tool can be interrupted
     */
    private canInterruptCurrentTool(state: EnhancedOperationState): boolean {
        if (!state.currentTool) {
            return true; // No tool running, can interrupt
        }

        const toolName = state.currentTool.name;

        // Check if explicitly uninterruptible
        if (this.policy.uninterruptibleTools.includes(toolName)) {
            return false;
        }

        // Check if explicitly interruptible
        if (this.policy.interruptibleTools.includes(toolName)) {
            return true;
        }

        // Default: consider uninterruptible for safety
        return false;
    }

    /**
     * Get the oldest injection wait time for an operation
     */
    private getOldestInjectionWaitTime(operationId: string): number {
        const state = this.operationStates.get(operationId);
        if (!state || state.injectionQueue.length === 0) {
            return 0;
        }

        const oldestMessage = state.injectionQueue[0];
        return Date.now() - oldestMessage.queuedAt;
    }

    /**
     * Get how long the current step has been running
     */
    private getCurrentStepDuration(operationId: string): number | null {
        const state = this.operationStates.get(operationId);
        if (!state || state.currentStepStartedAt === null) {
            return null;
        }
        return Date.now() - state.currentStepStartedAt;
    }

    /**
     * Start clawback timer for an operation
     */
    private startClawbackTimer(operationId: string): void {
        // Clear existing timer
        const existing = this.clawbackTimers.get(operationId);
        if (existing) {
            clearTimeout(existing);
        }

        // Set new timer
        const timer = setTimeout(() => {
            this.checkClawbackCondition(operationId);
        }, this.policy.maxInjectionWaitMs);

        this.clawbackTimers.set(operationId, timer);
    }

    /**
     * Check if clawback condition is met
     */
    private checkClawbackCondition(operationId: string): void {
        const oldestWaitTime = this.getOldestInjectionWaitTime(operationId);
        if (oldestWaitTime > this.policy.maxInjectionWaitMs) {
            const state = this.operationStates.get(operationId);
            if (state) {
                this.emit("clawback-triggered", {
                    operationId,
                    reason: "Injection wait timeout exceeded (timer)",
                    waitedMs: oldestWaitTime,
                });

                // Note: The actual abort will happen in prepareStep when it checks
                // the clawback condition. We emit the event for observability.
                logger.warn("[ExecutionCoordinator] Clawback condition met", {
                    operationId: operationId.substring(0, 8),
                    agent: state.agentSlug,
                    waitedMs: oldestWaitTime,
                });
            }
        }
    }

    /**
     * Cleanup all timers and state
     */
    private cleanup(): void {
        for (const timer of this.clawbackTimers.values()) {
            clearTimeout(timer);
        }
        this.clawbackTimers.clear();
        this.operationStates.clear();
        this.operationsByAgent.clear();
    }
}

export const executionCoordinator = ExecutionCoordinator.getInstance();
