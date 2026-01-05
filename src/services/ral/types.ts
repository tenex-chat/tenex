/** Role types that can be used for message injection */
export type InjectionRole = "user" | "system";

export type DelegationType = "standard" | "followup" | "external" | "ask";

// ============================================================================
// Todo Types
// ============================================================================

export type TodoStatus = "pending" | "in_progress" | "done" | "skipped";

export interface TodoItem {
  /** Unique slug derived from title */
  id: string;
  /** Human-readable title */
  title: string;
  /** Detailed description of what needs to be done */
  description: string;
  /** Current status of the todo item */
  status: TodoStatus;
  /** Required when status='skipped' - explains why item was skipped */
  skipReason?: string;
  /** System-set instructions passed to delegated agents (from phases) */
  delegationInstructions?: string;
  /** Order in the list (0-indexed) */
  position: number;
  /** Timestamp when item was created */
  createdAt: number;
  /** Timestamp of last status change */
  updatedAt: number;
}

interface BasePendingDelegation {
  delegationConversationId: string;
  recipientPubkey: string;
  senderPubkey: string;
  prompt: string;
  /** Which RAL created this delegation (for provenance tracking) */
  ralNumber: number;
}

interface StandardDelegation extends BasePendingDelegation {
  type?: "standard";
}

interface FollowupDelegation extends BasePendingDelegation {
  type: "followup";
  /** The event ID of the followup message (needed for routing responses) */
  followupEventId?: string;
}

interface ExternalDelegation extends BasePendingDelegation {
  type: "external";
  projectId?: string;
}

interface AskDelegation extends BasePendingDelegation {
  type: "ask";
  suggestions?: string[];
}

export type PendingDelegation =
  | StandardDelegation
  | FollowupDelegation
  | ExternalDelegation
  | AskDelegation;

export interface DelegationMessage {
  senderPubkey: string;
  recipientPubkey: string;
  content: string;
  timestamp: number;
}

export interface CompletedDelegation {
  delegationConversationId: string;
  recipientPubkey: string;
  senderPubkey: string;
  transcript: DelegationMessage[];
  completedAt: number;
  /** Which RAL created this delegation (for provenance tracking) */
  ralNumber: number;
}

export interface QueuedInjection {
  role: InjectionRole;
  content: string;
  queuedAt: number;
}

export interface RALState {
  id: string;
  /** Sequential number for this RAL within the conversation (1, 2, 3...) */
  ralNumber: number;
  agentPubkey: string;
  /** The conversation this RAL belongs to - RAL is scoped per agent+conversation */
  conversationId: string;
  queuedInjections: QueuedInjection[];
  /** Whether the agent is currently streaming a response */
  isStreaming: boolean;
  currentTool?: string;
  toolStartedAt?: number;
  createdAt: number;
  lastActivityAt: number;
  /** The original event that triggered this RAL - used for proper tagging on resumption */
  originalTriggeringEventId?: string;
  /** OTEL trace ID for correlating stop events with the agent execution */
  traceId?: string;
  /** OTEL span ID of the agent execution span - used as parent for stop spans */
  executionSpanId?: string;
}

export interface StopExecutionSignal {
  __stopExecution: true;
  pendingDelegations: PendingDelegation[];
}

export function isStopExecutionSignal(value: unknown): value is StopExecutionSignal {
  return (
    typeof value === "object" &&
    value !== null &&
    "__stopExecution" in value &&
    (value as StopExecutionSignal).__stopExecution === true
  );
}
