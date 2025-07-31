import { randomBytes } from "node:crypto";

/**
 * Minimal context for debugging execution flow through the TENEX system.
 */
export interface TracingContext {
    conversationId: string; // ID of the conversation (from Nostr event)
    executionId: string; // Unique ID for this specific execution/request
    currentAgent?: string; // Current agent name for debugging
    currentPhase?: string; // Current phase for debugging
    currentTool?: string; // Current tool being executed
}

/**
 * Generate a unique execution ID
 */
export function generateExecutionId(prefix = "exec"): string {
    const timestamp = Date.now().toString(36);
    const random = randomBytes(8).toString("hex");
    return `${prefix}_${timestamp}_${random}`;
}

/**
 * Create a new tracing context for a conversation
 */
export function createTracingContext(conversationId: string): TracingContext {
    return {
        conversationId,
        executionId: generateExecutionId(),
    };
}

/**
 * Create an agent execution context
 */
export function createAgentExecutionContext(
    parent: TracingContext,
    agentName: string
): TracingContext {
    return {
        ...parent,
        currentAgent: agentName,
    };
}

/**
 * Create a tool execution context
 */
export function createToolExecutionContext(
    parent: TracingContext,
    toolName: string
): TracingContext {
    return {
        ...parent,
        currentTool: toolName,
    };
}

/**
 * Create a phase execution context
 */
export function createPhaseExecutionContext(parent: TracingContext, phase: string): TracingContext {
    return {
        ...parent,
        currentPhase: phase,
    };
}

/**
 * Format tracing context for logging
 */
export function formatTracingContext(context: TracingContext): Record<string, unknown> {
    return {
        conversationId: context.conversationId,
        executionId: context.executionId,
        ...(context.currentAgent && { agent: context.currentAgent }),
        ...(context.currentPhase && { phase: context.currentPhase }),
        ...(context.currentTool && { tool: context.currentTool }),
    };
}
