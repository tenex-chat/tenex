/**
 * Configuration for pairing (real-time delegation supervision).
 * Stored in RALRegistryEntry when a delegation is made with pairing enabled.
 */
export interface PairingConfig {
  /** The delegation event ID being observed */
  delegationId: string;
  /** The worker agent's pubkey */
  recipientPubkey: string;
  /** The worker agent's slug (for display) */
  recipientSlug?: string;
  /** Number of tool executions between checkpoints */
  interval: number;
}

/**
 * Runtime state for an active pairing session.
 * Tracked by PairingManager.
 */
export interface PairingState {
  /** The delegation event ID being observed */
  delegationId: string;
  /** The supervisor agent's pubkey */
  supervisorPubkey: string;
  /** The conversation ID where the supervisor is running */
  supervisorConversationId: string;
  /** The RAL number of the supervisor's paused execution */
  supervisorRalNumber: number;
  /** The worker agent's slug (for display) */
  recipientSlug?: string;
  /** Number of tool executions between checkpoints */
  interval: number;

  /** Buffer of events since last checkpoint (tool executions + agent output) */
  eventBuffer: AgentEventSummary[];
  /** Count of events since last checkpoint */
  eventsSinceLastCheckpoint: number;
  /** Total events seen across all checkpoints */
  totalEventsSeen: number;
  /** Current checkpoint number (1-indexed) */
  checkpointNumber: number;

  /** When this pairing session started */
  createdAt: number;
  /** When the last checkpoint was triggered */
  lastCheckpointAt?: number;
}

/**
 * Summary of a tool execution event.
 */
export interface ToolEventSummary {
  type: "tool";
  /** The tool name (e.g., "shell", "read_file") */
  tool: string;
  /** Tool arguments (may be truncated) */
  args: Record<string, unknown>;
  /** Summarized result (truncated content) */
  resultSummary: string;
  /** Unix timestamp of the event */
  timestamp: number;
}

/**
 * Summary of agent text output.
 */
export interface OutputEventSummary {
  type: "output";
  /** The text content (may be truncated) */
  content: string;
  /** Unix timestamp of the event */
  timestamp: number;
}

/**
 * Union of all event types captured during pairing.
 */
export type AgentEventSummary = ToolEventSummary | OutputEventSummary;
