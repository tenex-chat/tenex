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
  recipientSlug?: string;
}

interface StandardDelegation extends BasePendingDelegation {
  type?: "standard";
}

interface FollowupDelegation extends BasePendingDelegation {
  type: "followup";
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

export interface CompletedDelegation {
  delegationConversationId: string;
  recipientPubkey: string;
  recipientSlug?: string;
  response: string;
  responseEventId?: string;
  completedAt: number;
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
  pendingDelegations: PendingDelegation[];
  completedDelegations: CompletedDelegation[];
  queuedInjections: QueuedInjection[];
  /** Whether the agent is currently streaming a response */
  isStreaming: boolean;
  currentTool?: string;
  toolStartedAt?: number;
  createdAt: number;
  lastActivityAt: number;
  /** The original event that triggered this RAL - used for proper tagging on resumption */
  originalTriggeringEventId?: string;
  /** If set, this RAL is paused by the RAL with this number */
  pausedByRalNumber?: number;
  /** Promise that resolves when this RAL is unpaused */
  pausePromise?: Promise<void>;
  /** Resolver function to unpause this RAL */
  pauseResolver?: () => void;
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
