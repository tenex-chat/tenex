import type { ToolCallPart, ToolResultPart } from "ai";
import type { TodoItem } from "@/services/ral/types";

export type MessageType = "text" | "tool-call" | "tool-result" | "delegation-marker";

/**
 * Marker stored in conversation history when a delegation completes.
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
    /** When the delegation completed */
    completedAt: number;
    /** Whether the delegation completed successfully or was aborted */
    status: "completed" | "aborted";
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
}
