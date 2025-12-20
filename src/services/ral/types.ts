import type { ModelMessage } from "ai";

/** Role types that can be used for message injection */
export type InjectionRole = "user" | "system";

export type DelegationType = "standard" | "followup" | "external" | "ask";

interface BasePendingDelegation {
  eventId: string;
  recipientPubkey: string;
  recipientSlug?: string;
  prompt: string;
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
  eventId: string;
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
  messages: ModelMessage[];
  /** Index in messages where this RAL's unique content starts (after shared conversation history) */
  uniqueMessagesStartIndex: number;
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
