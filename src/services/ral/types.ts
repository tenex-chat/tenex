import type { CoreMessage } from "ai";

export type RALStatus = "executing" | "paused" | "done";

export interface PendingDelegation {
  eventId: string;
  recipientPubkey: string;
  recipientSlug?: string;
  prompt: string;
  isFollowup?: boolean;
  isExternal?: boolean;
  isAsk?: boolean;
  projectId?: string;
  suggestions?: string[];
}

export interface CompletedDelegation {
  eventId: string;
  recipientPubkey: string;
  recipientSlug?: string;
  response: string;
  responseEventId?: string;
  completedAt: number;
}

export interface QueuedInjection {
  type: "user" | "system";
  content: string;
  eventId?: string;
  queuedAt: number;
}

export interface RALState {
  id: string;
  agentPubkey: string;
  messages: CoreMessage[];
  pendingDelegations: PendingDelegation[];
  completedDelegations: CompletedDelegation[];
  queuedInjections: QueuedInjection[];
  status: RALStatus;
  currentTool?: string;
  toolStartedAt?: number;
  createdAt: number;
  lastActivityAt: number;
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
