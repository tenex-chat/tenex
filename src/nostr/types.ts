/**
 * Type definitions for agent Nostr events.
 * Centralized types for event encoding and publishing.
 */

import type { LanguageModelUsageWithCostUsd } from "@/llm/types";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

// ============================================================================
// Intent Types - Express what agents want to communicate
// ============================================================================

export interface CompletionIntent {
    content: string;
    usage?: LanguageModelUsageWithCostUsd;
    summary?: string;
    // Note: llmRuntime is now tracked via EventContext.llmRuntime for all events
}

export interface ConversationIntent {
    content: string;
    isReasoning?: boolean;
    usage?: LanguageModelUsageWithCostUsd;
}

export interface DelegationIntent {
    delegations: Array<{
        recipient: string;
        request: string;
        branch?: string;
    }>;
    type?: "delegation" | "delegation_followup" | "ask";
}

/**
 * A single-select question where user picks one option (or provides their own answer).
 */
export interface SingleSelectQuestion {
    type: "question";
    /** Short title for the question (displayed as header) */
    title: string;
    /** Full question text */
    question: string;
    /** Optional suggestions - if omitted, question is fully open-ended */
    suggestions?: string[];
}

/**
 * A multi-select question where user can pick multiple options (or provide their own answer).
 */
export interface MultiSelectQuestion {
    type: "multiselect";
    /** Short title for the question (displayed as header) */
    title: string;
    /** Full question text */
    question: string;
    /** Optional options - if omitted, question is fully open-ended */
    options?: string[];
}

/**
 * Union type for all question types.
 */
export type AskQuestion = SingleSelectQuestion | MultiSelectQuestion;

export interface AskIntent {
    title: string;
    context: string;
    questions: AskQuestion[];
}

export interface ErrorIntent {
    message: string;
    errorType?: string;
}

export interface LessonIntent {
    title: string;
    lesson: string;
    detailed?: string;
    category?: string;
    hashtags?: string[];
}

export interface StatusIntent {
    type: "status";
    agents: Array<{ pubkey: string; slug: string }>;
    models: Array<{ slug: string; agents: string[] }>;
    tools: Array<{ name: string; agents: string[] }>;
    worktrees?: string[]; // Array of branch names, first is default
}

export interface ToolUseIntent {
    toolName: string;
    content: string; // e.g., "Reading $path"
    args?: unknown; // Tool arguments to be serialized
    referencedEventIds?: string[]; // Event IDs to reference with q-tags (e.g., delegation event IDs)
    referencedAddressableEvents?: string[]; // Addressable event references with a-tags (e.g., "30023:pubkey:d-tag")
    usage?: LanguageModelUsageWithCostUsd; // Cumulative usage from previous steps
}

/**
 * Intent for intervention review requests.
 * Used when the InterventionService detects that a user hasn't responded
 * to an agent's completion and triggers a human-replica review.
 *
 * Names are pre-resolved by the caller (InterventionPublisher) to avoid
 * layer violations - AgentEventEncoder (layer 2) cannot import PubkeyService (layer 3).
 */
export interface InterventionReviewIntent {
    /** Pubkey of the intervention agent (human-replica) to notify */
    targetPubkey: string;
    /** The conversation ID being reviewed */
    conversationId: string;
    /** Human-readable name of the user who hasn't responded (pre-resolved) */
    userName: string;
    /** Human-readable name of the agent that completed work (pre-resolved) */
    agentName: string;
}

export type AgentIntent =
    | CompletionIntent
    | ConversationIntent
    | DelegationIntent
    | AskIntent
    | ErrorIntent
    | LessonIntent
    | StatusIntent
    | ToolUseIntent
    | InterventionReviewIntent;

// ============================================================================
// Event Context - Execution context provided by RAL
// ============================================================================

export interface EventContext {
    triggeringEvent: NDKEvent; // The event that triggered this execution (for reply threading)
    rootEvent: { id?: string }; // The conversation root event (only ID is used for tagging)
    conversationId: string; // Required for conversation lookup
    executionTime?: number;
    model?: string;
    cost?: number; // LLM cost in USD
    ralNumber: number; // RAL number for this execution - required for all conversational events
    /** Incremental LLM runtime in milliseconds since last event was published */
    llmRuntime?: number;
    /** Total accumulated LLM runtime for this RAL (used in completion events) */
    llmRuntimeTotal?: number;
    /**
     * Pre-resolved recipient pubkey for completion events.
     * When set, the encoder uses this pubkey for the completion p-tag instead of
     * triggeringEvent.pubkey. This supports delegation chain routing where completions
     * must route back to the immediate delegator, not the event that happened to
     * trigger the current execution (e.g., a user responding to an ask).
     *
     * Resolved by createEventContext() (layer 3, in services/event-context/) from the
     * ConversationStore's delegation chain. This avoids layer violations - neither
     * AgentPublisher nor AgentEventEncoder (layer 2) can import ConversationStore (layer 3).
     */
    completionRecipientPubkey?: string;
}

// ============================================================================
// Publisher Config Types
// ============================================================================

/**
 * Configuration for delegation events.
 */
export interface DelegateConfig {
    /** The pubkey of the agent to delegate to */
    recipient: string;
    /** The content/instructions for the delegation */
    content: string;
    /** Optional branch for worktree support */
    branch?: string;
}

/**
 * Configuration for ask events.
 * Uses the multi-question format (title + questions).
 */
export interface AskConfig {
    /** The pubkey of the recipient (usually project owner/human) */
    recipient: string;
    /** Full context explaining why these questions are being asked */
    context: string;
    /** Overall title encompassing all questions */
    title: string;
    /** Array of questions (single-select or multi-select) */
    questions: AskQuestion[];
}
