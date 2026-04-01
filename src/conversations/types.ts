import type { PrincipalRef } from "@/events/runtime/InboundEnvelope";
import type { ToolCallPart, ToolResultPart } from "ai";
import type { TodoItem } from "@/services/ral/types";

export type MessageType = "text" | "tool-call" | "tool-result" | "delegation-marker";
export type PrincipalSnapshot = PrincipalRef;

export interface MessagePrincipalContext {
    senderPrincipal?: PrincipalSnapshot;
    targetedPrincipals?: PrincipalSnapshot[];
}

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

interface ConversationRecordFields {
    /** Canonical Nostr pubkey when available; empty string for transport-only authors. */
    pubkey: string;
    ral?: number; // Only for agent messages
    content: string; // Text content (for text messages) or empty for tool messages
    messageType: MessageType;
    toolData?: ToolCallPart[] | ToolResultPart[]; // Only for tool-call and tool-result
    eventId?: string; // If published to Nostr
    timestamp?: number; // Unix timestamp (seconds) - from NDKEvent.created_at or Date.now()/1000
    targetedPubkeys?: string[]; // Agent pubkeys this message is directed to (from p-tags)
    targetedPrincipals?: PrincipalSnapshot[]; // Optional transport-neutral recipient metadata
    /** Original sender pubkey for injected messages (for attribution when sender differs from expected) */
    senderPubkey?: string;
    /** Optional transport-neutral sender metadata */
    senderPrincipal?: PrincipalSnapshot;
    /**
     * Explicit role override for synthetic entries.
     * When present, this role is used instead of deriving from pubkey.
     */
    role?: "user" | "assistant" | "tool" | "system";
    /**
     * Human-readable summary of a tool call.
     * Stored at creation time so context-management projections can reference it
     * without needing access to the tool registry.
     */
    humanReadable?: string;
    /**
     * XML transcript attributes captured from tool input at execution time.
     * Example: { description: "...", file_path: "/repo/file.ts" }.
     */
    transcriptToolAttributes?: Record<string, string>;
    /**
     * For delegation-marker messageType: contains the marker data.
     * This allows lazy expansion of delegation transcripts when building messages.
     */
    delegationMarker?: DelegationMarker;
}

export interface ConversationRecord extends ConversationRecordFields {
    /** Canonical record identity used by prompt lineage and record references. */
    id: string;
}

/**
 * Input shape for write paths where the caller may not yet have an id assigned.
 */
export interface ConversationRecordInput extends ConversationRecordFields {
    id?: string;
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
    /** Optional transport-aware principal snapshot for routing/persistence fidelity. */
    principal?: PrincipalSnapshot;
}

export interface ConversationMetadata {
    title?: string;
    branch?: string;
    summary?: string;
    requirements?: string;
    plan?: string;
    projectPath?: string;
    lastUserMessage?: string;
    statusLabel?: string;
    statusCurrentActivity?: string;
    /**
     * The delegation chain showing who initiated this conversation.
     * First entry is the original initiator (typically User), last entry is the current agent.
     * Example: [User, pm-wip, execution-coordinator, claude-code]
     */
    delegationChain?: DelegationChainEntry[];
}

export interface ContextManagementScratchpadState {
    entries?: Record<string, string>;
    preserveTurns?: number | null;
    activeNotice?: ContextManagementScratchpadUseNotice;
    omitToolCallIds: string[];
    updatedAt?: number;
    agentLabel?: string;
}

export interface ContextManagementScratchpadUseNotice {
    description: string;
    toolCallId: string;
    rawTurnCountAtCall: number;
    projectedTurnCountAtCall: number;
}

export interface ContextManagementScratchpadEntry {
    agentId: string;
    agentLabel?: string;
    state: ContextManagementScratchpadState;
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
    messages: ConversationRecord[];
    metadata: ConversationMetadata;
    agentTodos: Record<string, TodoItem[]>;
    todoNudgedAgents: string[]; // Agents who have been nudged about todo usage
    blockedAgents: string[];
    executionTime: ExecutionTime;
    /** Meta model variant override per agent - when set, uses this variant instead of keyword detection */
    metaModelVariantOverride?: Record<string, string>; // agentPubkey -> variantName
    /** Per-agent context-management scratchpads used by middleware-managed prompt projection. */
    contextManagementScratchpads?: Record<string, ContextManagementScratchpadState>;
    /** Authoritative local skill IDs that agents have applied to themselves mid-conversation. Keyed by agent pubkey. */
    selfAppliedSkills?: Record<string, string[]>;
}
