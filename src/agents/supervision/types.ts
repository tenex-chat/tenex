import type { ModelMessage, ToolSet } from "ai";

/**
 * When heuristic checks run relative to agent execution
 */
export type HeuristicTiming = "pre-tool-execution" | "post-completion";

/**
 * Result of a heuristic detection check
 */
export interface HeuristicDetection {
    /** Whether the heuristic condition was triggered */
    triggered: boolean;
    /** Human-readable reason for the detection */
    reason?: string;
    /** Additional evidence that led to the detection */
    evidence?: unknown;
}

/**
 * Result of LLM verification of a heuristic detection
 */
export interface VerificationResult {
    /** Whether the detection was confirmed as a real violation */
    verdict: "ok" | "violation";
    /** Explanation of the verdict */
    explanation: string;
    /** Optional message to inject for correction */
    correctionMessage?: string;
}

/**
 * Action to take when a violation is confirmed
 */
export interface CorrectionAction {
    /** Type of correction to apply */
    type: "inject-message" | "block-tool" | "suppress-publish";
    /** Message to inject (for inject-message type) */
    message?: string;
    /** Whether to re-engage the agent after correction */
    reEngage: boolean;
}

/**
 * Context provided to the supervisor LLM for verification
 */
export interface SupervisionContext {
    /** Agent identifier slug */
    agentSlug: string;
    /** Agent's Nostr public key */
    agentPubkey: string;
    /** The agent's system prompt */
    systemPrompt: string;
    /** Full conversation history */
    conversationHistory: ModelMessage[];
    /** Tools available to the agent */
    availableTools: ToolSet;
    /** ID of the heuristic that triggered */
    triggeringHeuristic: string;
    /** Detection result from the heuristic */
    detection: HeuristicDetection;
}

/**
 * State tracking for supervision of an execution
 */
export interface SupervisionState {
    /** Number of retry attempts made */
    retryCount: number;
    /** Maximum allowed retries */
    maxRetries: number;
    /** ID of the last triggered heuristic */
    lastHeuristicTriggered?: string;
}

/**
 * Context for post-completion heuristic checks
 */
export interface PostCompletionContext {
    /** Agent identifier slug */
    agentSlug: string;
    /** Agent's Nostr public key */
    agentPubkey: string;
    /** Whether the agent execution has phases */
    hasPhases: boolean;
    /** The final message content from the agent */
    messageContent: string;
    /** Names of tools that were called during execution */
    toolCallsMade: string[];
    /** The agent's system prompt */
    systemPrompt: string;
    /** Full conversation history */
    conversationHistory: ModelMessage[];
    /** Tools available to the agent */
    availableTools: ToolSet;
}

/**
 * Context for pre-tool execution heuristic checks
 */
export interface PreToolContext {
    /** Agent identifier slug */
    agentSlug: string;
    /** Agent's Nostr public key */
    agentPubkey: string;
    /** Whether the agent execution has phases */
    hasPhases: boolean;
    /** Name of the tool about to be executed */
    toolName: string;
    /** Arguments passed to the tool */
    toolArgs: unknown;
    /** Whether the agent has an active todo list */
    hasTodoList: boolean;
    /** The agent's system prompt */
    systemPrompt: string;
    /** Full conversation history */
    conversationHistory: ModelMessage[];
    /** Tools available to the agent */
    availableTools: ToolSet;
}

/**
 * Base interface for all heuristics
 */
export interface Heuristic<TContext> {
    /** Unique identifier for the heuristic */
    id: string;
    /** Human-readable name */
    name: string;
    /** When this heuristic runs */
    timing: HeuristicTiming;
    /** Optional filter to only run for specific tools (pre-tool-execution only) */
    toolFilter?: string[];
    /**
     * Detect if the heuristic condition is met
     * @param context - The context to check
     * @returns Detection result indicating if triggered
     */
    detect(context: TContext): Promise<HeuristicDetection>;
    /**
     * Build the prompt for the supervisor LLM to verify the detection
     * @param context - The context that triggered detection
     * @param detection - The detection result
     * @returns Prompt string for the LLM
     */
    buildVerificationPrompt(context: TContext, detection: HeuristicDetection): string;
    /**
     * Build the correction message to inject back to the agent
     * @param context - The original context
     * @param verification - The LLM verification result
     * @returns Message to inject
     */
    buildCorrectionMessage(context: TContext, verification: VerificationResult): string;
    /**
     * Get the correction action to take
     * @param verification - The LLM verification result
     * @returns The correction action
     */
    getCorrectionAction(verification: VerificationResult): CorrectionAction;
}

/**
 * Maximum number of supervision retries before giving up
 */
export const MAX_SUPERVISION_RETRIES = 3;
