/**
 * Delegation Services
 *
 * Handles agent-to-agent delegation workflows
 */

export { DelegationService } from "./DelegationService";
export type { DelegationResponses, DelegationExecuteOptions } from "./DelegationService";
export { DelegationRegistry } from "./DelegationRegistry";
export type { DelegationRecord } from "./DelegationRegistry";

// Pair mode exports
export { PairModeRegistry } from "./PairModeRegistry";
export { PairModeController, PairModeAbortError } from "./PairModeController";
export type {
    DelegationMode,
    PairModeConfig,
    PairModeAction,
    PairCheckInRequest,
    PairDelegationState,
    CheckInResult,
} from "./types";
export { DEFAULT_PAIR_MODE_CONFIG } from "./types";
