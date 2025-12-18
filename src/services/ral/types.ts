import type { ModelMessage } from "ai";

export type RALStatus = "executing" | "paused" | "done";

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
  eventId?: string;
  queuedAt: number;
}

export interface RALState {
  id: string;
  agentPubkey: string;
  messages: ModelMessage[];
  pendingDelegations: PendingDelegation[];
  completedDelegations: CompletedDelegation[];
  queuedInjections: QueuedInjection[];
  status: RALStatus;
  currentTool?: string;
  toolStartedAt?: number;
  createdAt: number;
  lastActivityAt: number;
  /** The original event that triggered this RAL - used for proper tagging on resumption */
  originalTriggeringEventId?: string;
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
