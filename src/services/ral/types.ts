/** Role types that can be used for message injection */
export type InjectionRole = "user" | "system";

/** Result of injecting a message into an active RAL */
export interface InjectionResult {
  /** The active RAL entry, if found */
  activeRal?: RALRegistryEntry;
  /** Whether the message was queued for injection */
  queued: boolean;
  /** Whether an active streaming run was aborted */
  aborted: boolean;
}

// ============================================================================
// Todo Types
// ============================================================================

export type TodoStatus = "pending" | "in_progress" | "done" | "skipped";

export interface TodoItem {
  /** Unique identifier - can be custom or auto-generated from title */
  id: string;
  /** Human-readable title */
  title: string;
  /** Detailed description of what needs to be done */
  description: string;
  /** Current status of the todo item */
  status: TodoStatus;
  /** Required when status='skipped' - explains why item was skipped */
  skipReason?: string;
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
  /**
   * If true, this delegation has been killed via the kill tool.
   * Completion events for killed delegations should be ignored.
   * This prevents the race condition where a delegation completes
   * after being killed but before the abort fully propagates.
   */
  killed?: boolean;
  /** Timestamp when delegation was killed (for debugging) */
  killedAt?: number;
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

/**
 * Discriminated union for completed delegations.
 * Either successfully completed or aborted with a reason.
 */
export type CompletedDelegation =
  | {
      delegationConversationId: string;
      recipientPubkey: string;
      senderPubkey: string;
      transcript: DelegationMessage[];
      completedAt: number;
      /** Which RAL created this delegation (for provenance tracking) */
      ralNumber: number;
      status: "completed";
    }
  | {
      delegationConversationId: string;
      recipientPubkey: string;
      senderPubkey: string;
      transcript: DelegationMessage[];
      completedAt: number;
      /** Which RAL created this delegation (for provenance tracking) */
      ralNumber: number;
      status: "aborted";
      abortReason: string;
    };

export interface QueuedInjection {
  role: InjectionRole;
  content: string;
  queuedAt: number;
  /** If true, message is included in LLM context but NOT persisted to ConversationStore */
  ephemeral?: boolean;
  /** Original sender pubkey (for message attribution when sender differs from expected) */
  senderPubkey?: string;
  /** Original Nostr event ID (for deduplication - prevents double-insertion via both addEvent and injection paths) */
  eventId?: string;
}

export interface RALRegistryEntry {
  id: string;
  /** Sequential number for this RAL within the conversation (1, 2, 3...) */
  ralNumber: number;
  agentPubkey: string;
  /** The project this RAL belongs to - required for multi-project isolation in daemon mode */
  projectId: string;
  /** The conversation this RAL belongs to - RAL is scoped per agent+conversation */
  conversationId: string;
  queuedInjections: QueuedInjection[];
  /** Whether the agent is currently streaming a response */
  isStreaming: boolean;
  /**
   * Map of currently executing tool call IDs to their tool info.
   * Multiple tools can execute concurrently. ACTING state is derived from activeTools.size > 0.
   * Keyed by toolCallId (not toolName) to properly track concurrent calls of the same tool.
   * Value contains tool name (for display) and startedAt timestamp (for duration tracking).
   */
  activeTools: Map<string, { name: string; startedAt: number }>;
  /** Most recently started tool name (derived from activeTools, for display only) */
  currentTool?: string;
  /** Start time of the most recently started tool (derived from activeTools, for display only) */
  toolStartedAt?: number;
  createdAt: number;
  lastActivityAt: number;
  /** The original event that triggered this RAL - used for proper tagging on resumption */
  originalTriggeringEventId?: string;
  /** OTEL trace ID for correlating stop events with the agent execution */
  traceId?: string;
  /** OTEL span ID of the agent execution span - used as parent for stop spans */
  executionSpanId?: string;
  /** Accumulated LLM runtime in milliseconds across all streaming sessions */
  accumulatedRuntime: number;
  /** Last reported runtime in milliseconds - used to calculate incremental runtime */
  lastReportedRuntime: number;
  /** Timestamp when current LLM stream started (for calculating duration) - immutable for stream lifetime */
  llmStreamStartTime?: number;
  /** Checkpoint timestamp for incremental runtime reporting mid-stream (resets on each consume) */
  lastRuntimeCheckpointAt?: number;
  /** Heuristic state - namespaced under 'heuristics' */
  heuristics?: {
    /** Pending violations waiting to be injected */
    pendingViolations: Array<{
      id: string;
      title: string;
      message: string;
      severity: "warning" | "error";
      timestamp: number;
      heuristicId: string;
    }>;
    /** Set of violation IDs shown in this RAL (for deduplication) */
    shownViolationIds: Set<string>;
    /** O(1) precomputed summary for heuristic evaluation */
    summary?: {
      /** Tool call history (bounded to last N tools) */
      recentTools: Array<{ name: string; timestamp: number }>;
      /** Flags for quick checks */
      flags: {
        hasTodoWrite: boolean;
        hasDelegation: boolean;
        hasVerification: boolean;
        hasGitAgentCommit: boolean;
      };
      /** Pending delegation count for this RAL (O(1) counter) */
      pendingDelegationCount: number;
    };
    /** Tool args storage: toolCallId -> args (for passing to heuristics) */
    toolArgs?: Map<string, unknown>;
  };
}

export interface StopExecutionSignal {
  __stopExecution: true;
  pendingDelegations: PendingDelegation[];
}

/**
 * Check if value is a direct (unwrapped) StopExecutionSignal
 */
function isDirectStopExecutionSignal(value: unknown): value is StopExecutionSignal {
  return (
    typeof value === "object" &&
    value !== null &&
    "__stopExecution" in value &&
    (value as StopExecutionSignal).__stopExecution === true
  );
}

/**
 * Try to extract a StopExecutionSignal from an MCP-wrapped response.
 *
 * Claude Code SDK wraps tool results in MCP format:
 * - Array format: [{ type: "text", text: '{"__stopExecution":true,...}' }]
 * - Object format: { content: [{ type: "text", text: "..." }] }
 *
 * Returns the parsed StopExecutionSignal if found, null otherwise.
 */
function extractFromMCPWrapped(value: unknown): StopExecutionSignal | null {
  // Handle both array format and { content: [...] } format
  const content = Array.isArray(value)
    ? value
    : (typeof value === "object" && value !== null && "content" in value)
      ? (value as { content: unknown[] }).content
      : null;

  if (!Array.isArray(content)) return null;

  // Find the text item in the content array
  const textItem = content.find((c: unknown) =>
    typeof c === "object" &&
    c !== null &&
    (c as { type?: string }).type === "text"
  ) as { text?: string } | undefined;

  if (!textItem?.text) return null;

  try {
    const parsed = JSON.parse(textItem.text);
    if (isDirectStopExecutionSignal(parsed)) {
      return parsed;
    }
  } catch {
    // Not valid JSON, not a stop signal
  }

  return null;
}

/**
 * Type guard for StopExecutionSignal.
 *
 * Handles both:
 * 1. Direct StopExecutionSignal objects (from standard AI SDK providers)
 * 2. MCP-wrapped responses (from Claude Code SDK where tool results get
 *    wrapped in [{ type: "text", text: "..." }] format)
 */
export function isStopExecutionSignal(value: unknown): value is StopExecutionSignal {
  // Check direct format first (most common case)
  if (isDirectStopExecutionSignal(value)) {
    return true;
  }

  // Check MCP-wrapped format (Claude Code SDK)
  return extractFromMCPWrapped(value) !== null;
}

/**
 * Extract the pending delegations from a StopExecutionSignal.
 *
 * Works with both direct and MCP-wrapped formats.
 * Returns null if value is not a StopExecutionSignal.
 */
export function extractPendingDelegations(value: unknown): PendingDelegation[] | null {
  // Check direct format first
  if (isDirectStopExecutionSignal(value)) {
    return value.pendingDelegations;
  }

  // Check MCP-wrapped format
  const extracted = extractFromMCPWrapped(value);
  if (extracted) {
    return extracted.pendingDelegations;
  }

  return null;
}
