/**
 * ExecutionCoordinator Types
 *
 * Types for managing agent execution routing, message injection,
 * and concurrent execution handling.
 */

import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { AgentInstance } from "@/agents/types";
import type { Conversation } from "@/conversations";

/**
 * Enhanced operation state with step timing and injection queue
 */
export interface EnhancedOperationState {
    /** Unique operation identifier */
    operationId: string;

    /** Agent pubkey running this operation */
    agentPubkey: string;

    /** Agent slug for logging */
    agentSlug: string;

    /** Conversation ID */
    conversationId: string;

    /** When operation was registered */
    registeredAt: number;

    /** Current step number in the AI SDK loop */
    stepCount: number;

    /** When the current step started (null = between steps) */
    currentStepStartedAt: number | null;

    /** When the last step completed */
    lastStepCompletedAt: number | null;

    /** Messages waiting to be injected */
    injectionQueue: InjectedMessage[];

    /** Currently executing tool (if any) */
    currentTool: {
        name: string;
        startedAt: number;
    } | null;

    /** Recent tool names for diagnostics */
    recentToolNames: string[];
}

/**
 * A message queued for injection into an active execution
 */
export interface InjectedMessage {
    /** The Nostr event containing the message */
    event: NDKEvent;

    /** When the message was queued */
    queuedAt: number;

    /** Priority level for routing decisions */
    priority: "normal" | "urgent";
}

/**
 * Policy configuration for routing decisions
 */
export interface RoutingPolicy {
    /** Max time a message can wait in injection queue before clawback (ms) */
    maxInjectionWaitMs: number;

    /** Max time a single step can run before considering concurrent mode (ms) */
    maxStepDurationMs: number;

    /** Whether to allow concurrent execution mode */
    allowConcurrentExecution: boolean;

    /** Tools that are safe to abort mid-execution */
    interruptibleTools: string[];

    /** Tools that should never be interrupted */
    uninterruptibleTools: string[];
}

/**
 * Default routing policy
 */
export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
    maxInjectionWaitMs: 30000, // 30 seconds
    maxStepDurationMs: 60000, // 60 seconds
    allowConcurrentExecution: true,
    interruptibleTools: [
        "read_file",
        "glob",
        "grep",
        "list_directory",
        "search",
    ],
    uninterruptibleTools: [
        "write_file",
        "edit_file",
        "bash",
        "delegate",
    ],
};

/**
 * Decision returned by the coordinator for how to handle a message
 */
export type RouteDecision =
    | {
          type: "inject";
          operationId: string;
          reason: string;
      }
    | {
          type: "start-new";
          reason: string;
      }
    | {
          type: "start-concurrent";
          backgroundOperation: EnhancedOperationState;
          reason: string;
      }
    | {
          type: "clawback";
          operationId: string;
          reason: string;
      };

/**
 * Context for routing decisions
 */
export interface RouteContext {
    agent: AgentInstance;
    event: NDKEvent;
    conversation: Conversation;
}

/**
 * Abort error thrown during clawback
 */
export class ClawbackAbortError extends Error {
    constructor(
        public readonly operationId: string,
        public readonly reason: string
    ) {
        super(`Clawback abort: ${reason}`);
        this.name = "ClawbackAbortError";
    }
}

