/**
 * Types for the reactive heuristic reminder system
 *
 * This module defines the core types for heuristics that provide
 * real-time guidance to agents based on their actions.
 */


/**
 * Context provided to heuristics for evaluation.
 * All data is precomputed for O(1) access - NO expensive scans allowed.
 * BLOCKER 3 FIX: Includes timestamp for deterministic violation IDs.
 */
export interface HeuristicContext {
  /** Agent's public key */
  agentPubkey: string;

  /** Conversation ID */
  conversationId: string;

  /** Current RAL number */
  ralNumber: number;

  /** Timestamp when evaluation started (for deterministic IDs) */
  evaluationTimestamp: number;

  /** Tool that just executed */
  tool: {
    name: string;
    callId: string;
    args: unknown;
    result: unknown;
  };

  /** Precomputed conversation state (O(1) lookups) */
  state: {
    /** Has TodoWrite been called in this RAL? */
    hasTodoWrite: boolean;

    /** Has delegation tool been called in this RAL? */
    hasDelegation: boolean;

    /** Count of pending delegations for this RAL */
    pendingDelegationCount: number;

    /** Current git branch (if available) */
    currentBranch?: string;

    /** Is this a worktree branch? */
    isWorktreeBranch: boolean;

    /** Has verification been performed? (e.g., tests, builds) */
    hasVerification: boolean;

    /** Has git-agent been used for commits? */
    hasGitAgentCommit: boolean;

    /** Total message count in conversation */
    messageCount: number;
  };

  /** Recent tool history (limited, bounded list) */
  recentTools: Array<{
    name: string;
    timestamp: number;
  }>;
}

/**
 * A violation represents a heuristic rule that was broken.
 * These are stored in RAL state and injected as warnings.
 */
export interface HeuristicViolation {
  /** Unique ID for this violation type */
  id: string;

  /** Human-readable title */
  title: string;

  /** Detailed markdown message to show the agent */
  message: string;

  /** Severity level for prioritization */
  severity: "warning" | "error";

  /** Timestamp when violation was detected */
  timestamp: number;

  /** Which heuristic detected this */
  heuristicId: string;
}

/**
 * Result from evaluating a heuristic.
 * null = no violation, HeuristicViolation = rule was broken
 */
export type HeuristicResult = HeuristicViolation | null;

/**
 * A heuristic is a pure, synchronous function that checks a rule.
 * CRITICAL: Must be pure (no I/O, no async, no side effects)
 */
export interface Heuristic {
  /** Unique identifier for this heuristic */
  id: string;

  /** Human-readable name */
  name: string;

  /** Description of what this heuristic checks */
  description: string;

  /**
   * Evaluate the heuristic against the current context.
   * MUST be pure and synchronous.
   * MUST NOT throw exceptions (use try/catch in implementation).
   *
   * @param context - Precomputed O(1) context
   * @returns Violation if rule broken, null otherwise
   */
  evaluate: (context: HeuristicContext) => HeuristicResult;
}

/**
 * Configuration for the heuristic engine
 */
export interface HeuristicEngineConfig {
  /** Maximum warnings to show per LLM step (default: 3) */
  maxWarningsPerStep?: number;

  /** Enable debug logging */
  debug?: boolean;
}

/**
 * Internal state for tracking violations
 */
export interface ViolationState {
  /** Pending violations waiting to be injected */
  pending: HeuristicViolation[];

  /** Violations shown in this RAL (for deduplication) */
  shown: Set<string>;
}
