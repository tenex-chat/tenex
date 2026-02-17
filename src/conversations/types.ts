import type { ToolCallPart, ToolResultPart } from "ai";
import type { TodoItem } from "@/services/ral/types";

export type MessageType = "text" | "tool-call" | "tool-result" | "delegation-marker";

/**
 * Marker stored in conversation history to track delegation lifecycle.
 * Markers are created immediately when a delegation is initiated (status: "pending"),
 * and updated when the delegation completes or is aborted.
 * Instead of embedding the full transcript inline, we store a reference
 * and lazily expand it when building messages.
 */
export interface DelegationMarker {
    /** The delegation conversation ID (used to retrieve transcript) */
    delegationConversationId: string;
    /** The agent pubkey that received the delegation */
    recipientPubkey: string;
    /** The conversation ID of the parent (delegator) - for direct-child validation */
    parentConversationId: string;
    /** When the delegation was initiated (Unix timestamp in seconds) */
    initiatedAt?: number;
    /** When the delegation completed (Unix timestamp in seconds) - only set when completed/aborted */
    completedAt?: number;
    /** Delegation status: pending (in progress), completed (successful), or aborted */
    status: "pending" | "completed" | "aborted";
    /** If aborted, the reason for the abort */
    abortReason?: string;
}

export interface ConversationEntry {
    pubkey: string;
    ral?: number; // Only for agent messages
    content: string; // Text content (for text messages) or empty for tool messages
    messageType: MessageType;
    toolData?: ToolCallPart[] | ToolResultPart[]; // Only for tool-call and tool-result
    eventId?: string; // If published to Nostr
    timestamp?: number; // Unix timestamp (seconds) - from NDKEvent.created_at or Date.now()/1000
    targetedPubkeys?: string[]; // Agent pubkeys this message is directed to (from p-tags)
    /** Original sender pubkey for injected messages (for attribution when sender differs from expected) */
    senderPubkey?: string;
    /**
     * Explicit role override for synthetic entries (e.g., compressed summaries).
     * When present, this role is used instead of deriving from pubkey.
     * Used to ensure compressed summaries are rendered as "system" role, not "user".
     */
    role?: "user" | "assistant" | "tool" | "system";
    /**
     * For delegation-marker messageType: contains the marker data.
     * This allows lazy expansion of delegation transcripts when building messages.
     */
    delegationMarker?: DelegationMarker;
}

export interface Injection {
    targetRal: { pubkey: string; ral: number };
    role: "user" | "system";
    content: string;
    queuedAt: number;
}

/**
 * Deferred injection - a message to be injected on the agent's NEXT turn.
 *
 * Unlike Injection which targets a specific RAL, DeferredInjection is consumed
 * at the START of any future RAL for the target agent. This is used for
 * supervision messages that should NOT block the current completion but should
 * appear in the agent's next conversation turn.
 */
export interface DeferredInjection {
    /** The agent pubkey this injection is for */
    targetPubkey: string;
    /** The role of the injected message */
    role: "system";
    /** The message content */
    content: string;
    /** When this injection was queued (ms since epoch) */
    queuedAt: number;
    /** Optional source identifier for debugging (e.g., "supervision:consecutive-tools-without-todo") */
    source?: string;
}

/**
 * Represents a participant in the delegation chain.
 * Can be either a human user or an agent.
 */
export interface DelegationChainEntry {
    /** The pubkey of the participant */
    pubkey: string;
    /** The display name (agent slug or shortened pubkey) */
    displayName: string;
    /** Whether this is the project owner/human user */
    isUser: boolean;
    /** The conversation ID where this delegation occurred (full ID, truncated only at display time) */
    conversationId?: string;
}

export interface ConversationMetadata {
    title?: string;
    branch?: string;
    summary?: string;
    requirements?: string;
    plan?: string;
    projectPath?: string;
    last_user_message?: string;
    statusLabel?: string;
    statusCurrentActivity?: string;
    referencedArticle?: {
        title: string;
        content: string;
        dTag: string;
    };
    /**
     * The delegation chain showing who initiated this conversation.
     * First entry is the original initiator (typically User), last entry is the current agent.
     * Example: [User, pm-wip, execution-coordinator, claude-code]
     */
    delegationChain?: DelegationChainEntry[];
}

export interface RalTracker {
    id: number;
}

export interface ExecutionTime {
    totalSeconds: number;
    currentSessionStart?: number;
    isActive: boolean;
    lastUpdated: number;
}

export interface ConversationState {
    activeRal: Record<string, RalTracker[]>;
    nextRalNumber: Record<string, number>;
    injections: Injection[];
    messages: ConversationEntry[];
    metadata: ConversationMetadata;
    agentTodos: Record<string, TodoItem[]>;
    todoNudgedAgents: string[]; // Agents who have been nudged about todo usage
    blockedAgents: string[];
    executionTime: ExecutionTime;
    /** Meta model variant override per agent - when set, uses this variant instead of keyword detection */
    metaModelVariantOverride?: Record<string, string>; // agentPubkey -> variantName
    /**
     * Deferred injections - messages to be injected on an agent's NEXT turn.
     * Used by supervision for non-blocking nudges that shouldn't prevent completion.
     */
    deferredInjections?: DeferredInjection[];
}
