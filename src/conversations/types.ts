import type { ToolCallPart, ToolResultPart } from "ai";
import type { TodoItem } from "@/services/ral/types";

export type MessageType = "text" | "tool-call" | "tool-result";

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
