/**
 * Pair Programming Mode Types for Delegation
 *
 * These types enable a "pair programming" mode where the delegator agent
 * can periodically check in on the delegated agent's progress and provide
 * guidance via CONTINUE, STOP, or CORRECT actions.
 */

/**
 * Delegation execution mode
 */
export type DelegationMode = "blocking" | "pair";

/**
 * Configuration for pair programming mode
 */
export interface PairModeConfig {
    /** Number of AI SDK steps between check-ins (default: 10) */
    stepThreshold: number;
    /** Maximum time to wait for delegator response during check-in (ms, default: 60000) */
    checkInTimeoutMs?: number;
}

/**
 * Default configuration for pair mode
 */
export const DEFAULT_PAIR_MODE_CONFIG: Required<PairModeConfig> = {
    stepThreshold: 10,
    checkInTimeoutMs: 60000,
};

/**
 * Actions the delegator can take during a pair mode check-in
 */
export type PairModeAction =
    | { type: "CONTINUE" }
    | { type: "STOP"; reason?: string }
    | { type: "CORRECT"; message: string };

/**
 * Check-in request sent from delegated agent to delegator
 */
export interface PairCheckInRequest {
    /** Batch ID for the delegation */
    batchId: string;
    /** Public key of the delegated agent */
    delegatedAgentPubkey: string;
    /** Slug of the delegated agent */
    delegatedAgentSlug?: string;
    /** Current step number in the AI SDK loop */
    stepNumber: number;
    /** Estimated total steps (0 if unknown) */
    totalSteps: number;
    /** Recent tool calls made by the delegated agent */
    recentToolCalls: string[];
    /** Optional progress summary */
    progressSummary?: string;
}

/**
 * State for tracking a pair mode delegation
 */
export interface PairDelegationState {
    /** Batch ID for this delegation */
    batchId: string;
    /** Mode is always "pair" for tracked delegations */
    mode: "pair";
    /** Configuration for this pair delegation */
    config: Required<PairModeConfig>;
    /** Number of check-ins that have occurred */
    checkInCount: number;
    /** Step number at last check-in */
    lastCheckInStep: number;
    /** Pending correction messages to inject */
    correctionMessages: string[];
    /** Current status of the delegation */
    status: "running" | "paused" | "aborted" | "completed";
    /** Public key of the delegator agent */
    delegatorPubkey: string;
}

/**
 * Result of a check-in operation
 */
export interface CheckInResult {
    /** The action taken by the delegator */
    action: PairModeAction;
    /** Timestamp when the check-in was processed */
    timestamp: number;
    /** Step number when check-in occurred */
    stepNumber: number;
}
