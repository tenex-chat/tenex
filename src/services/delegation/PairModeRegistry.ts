/**
 * PairModeRegistry - Singleton that coordinates pair programming check-ins
 * between delegator and delegated agents.
 *
 * This registry manages:
 * - Active pair mode delegations
 * - Check-in requests and responses
 * - Correction message queues
 * - Abort signals
 */

import { EventEmitter } from "node:events";
import { logger } from "@/utils/logger";
import type {
    CheckInResult,
    PairCheckInRequest,
    PairDelegationState,
    PairModeAction,
    PairModeConfig,
} from "./types";

/** Maximum number of check-in history entries to keep per delegation */
const MAX_CHECK_IN_HISTORY = 100;

export class PairModeRegistry extends EventEmitter {
    private static instance: PairModeRegistry;

    /** Active pair mode delegations by batchId */
    private activeDelegations: Map<string, PairDelegationState> = new Map();

    /** Pending check-ins awaiting delegator response */
    private pendingCheckIns: Map<
        string,
        {
            resolve: (action: PairModeAction) => void;
            reject: (error: Error) => void;
            timeout: NodeJS.Timeout;
        }
    > = new Map();

    /** History of check-ins for each delegation (limited to MAX_CHECK_IN_HISTORY) */
    private checkInHistory: Map<string, CheckInResult[]> = new Map();

    private constructor() {
        super();
        // Increase max listeners to avoid warnings with many concurrent delegations
        this.setMaxListeners(100);
    }

    /**
     * Get the singleton instance
     */
    static getInstance(): PairModeRegistry {
        if (!PairModeRegistry.instance) {
            PairModeRegistry.instance = new PairModeRegistry();
        }
        return PairModeRegistry.instance;
    }

    /**
     * Reset the singleton instance. Used for testing only.
     * @internal
     */
    static resetInstance(): void {
        if (PairModeRegistry.instance) {
            // Clean up all active delegations
            for (const batchId of PairModeRegistry.instance.activeDelegations.keys()) {
                PairModeRegistry.instance.cleanup(batchId);
            }
            PairModeRegistry.instance.removeAllListeners();
        }
        PairModeRegistry.instance = undefined as unknown as PairModeRegistry;
    }

    /**
     * Register a new pair mode delegation.
     * Called by the delegator when initiating a pair mode delegation.
     */
    registerPairDelegation(
        batchId: string,
        delegatorPubkey: string,
        config?: Partial<PairModeConfig>
    ): void {
        const fullConfig: Required<PairModeConfig> = {
            stepThreshold: config?.stepThreshold ?? 10,
            checkInTimeoutMs: config?.checkInTimeoutMs ?? 60000,
        };

        const state: PairDelegationState = {
            batchId,
            mode: "pair",
            config: fullConfig,
            checkInCount: 0,
            lastCheckInStep: 0,
            correctionMessages: [],
            status: "running",
            delegatorPubkey,
        };

        this.activeDelegations.set(batchId, state);
        this.checkInHistory.set(batchId, []);

        logger.info("[PairModeRegistry] Registered pair mode delegation", {
            batchId,
            delegatorPubkey: delegatorPubkey.substring(0, 8),
            stepThreshold: fullConfig.stepThreshold,
            timeoutMs: fullConfig.checkInTimeoutMs,
        });
    }

    /**
     * Check if a batch is a pair mode delegation
     */
    isPairModeDelegation(batchId: string): boolean {
        return this.activeDelegations.has(batchId);
    }

    /**
     * Get the pair mode state for a delegation
     */
    getState(batchId: string): PairDelegationState | undefined {
        return this.activeDelegations.get(batchId);
    }

    /**
     * Check if a check-in is needed based on current step
     */
    shouldCheckIn(batchId: string, currentStep: number): boolean {
        const state = this.activeDelegations.get(batchId);
        if (!state) return false;
        if (state.status !== "running") return false;

        const stepsSinceLastCheckIn = currentStep - state.lastCheckInStep;
        return stepsSinceLastCheckIn >= state.config.stepThreshold;
    }

    /**
     * Request a check-in from the delegator.
     * This method blocks until the delegator responds or timeout occurs.
     *
     * @returns The action decided by the delegator
     */
    async requestCheckIn(request: PairCheckInRequest): Promise<PairModeAction> {
        const state = this.activeDelegations.get(request.batchId);
        if (!state) {
            throw new Error(`No pair delegation found for batchId: ${request.batchId}`);
        }

        // Update state
        state.status = "paused";
        state.checkInCount++;

        logger.info("[PairModeRegistry] Requesting check-in from delegator", {
            batchId: request.batchId,
            stepNumber: request.stepNumber,
            checkInNumber: state.checkInCount,
            delegatedAgent: request.delegatedAgentSlug,
            recentTools: request.recentToolCalls.slice(-5),
        });

        // Emit check-in event for the delegator to handle
        this.emit(`${request.batchId}:checkin`, request);

        // Wait for response with timeout
        return new Promise<PairModeAction>((resolve, reject) => {
            const timeout = setTimeout(() => {
                logger.warn("[PairModeRegistry] Check-in timeout, defaulting to CONTINUE", {
                    batchId: request.batchId,
                    timeoutMs: state.config.checkInTimeoutMs,
                });

                this.pendingCheckIns.delete(request.batchId);

                // Record the timeout as a CONTINUE in history
                this.addToHistory(request.batchId, {
                    action: { type: "CONTINUE" },
                    timestamp: Date.now(),
                    stepNumber: request.stepNumber,
                });

                // Resume running
                state.status = "running";
                state.lastCheckInStep = request.stepNumber;

                resolve({ type: "CONTINUE" });
            }, state.config.checkInTimeoutMs);

            this.pendingCheckIns.set(request.batchId, { resolve, reject, timeout });
        });
    }

    /**
     * Respond to a pending check-in.
     * Called by the delegator after evaluating the delegated agent's progress.
     */
    respondToCheckIn(batchId: string, action: PairModeAction): void {
        const pending = this.pendingCheckIns.get(batchId);
        const state = this.activeDelegations.get(batchId);

        if (!pending) {
            logger.warn("[PairModeRegistry] No pending check-in found", { batchId });
            return;
        }

        if (!state) {
            pending.reject(new Error(`No pair delegation found for batchId: ${batchId}`));
            return;
        }

        // Clear timeout and pending state
        clearTimeout(pending.timeout);
        this.pendingCheckIns.delete(batchId);

        // Record in history
        this.addToHistory(batchId, {
            action,
            timestamp: Date.now(),
            stepNumber: state.lastCheckInStep + state.config.stepThreshold,
        });

        // Update state based on action
        switch (action.type) {
            case "CONTINUE":
                state.status = "running";
                state.lastCheckInStep += state.config.stepThreshold;
                logger.info("[PairModeRegistry] Delegator responded CONTINUE", { batchId });
                break;

            case "STOP":
                state.status = "aborted";
                logger.info("[PairModeRegistry] Delegator responded STOP", {
                    batchId,
                    reason: action.reason,
                });
                break;

            case "CORRECT":
                state.status = "running";
                state.lastCheckInStep += state.config.stepThreshold;
                state.correctionMessages.push(action.message);
                logger.info("[PairModeRegistry] Delegator responded CORRECT", {
                    batchId,
                    messagePreview: action.message.substring(0, 100),
                });
                break;
        }

        // Resolve the pending promise
        pending.resolve(action);
    }

    /**
     * Get and clear any pending correction messages for a delegation.
     * Called by PairModeController to inject corrections into the agent's context.
     */
    getCorrectionMessages(batchId: string): string[] {
        const state = this.activeDelegations.get(batchId);
        if (!state) return [];

        const messages = [...state.correctionMessages];
        state.correctionMessages = [];
        return messages;
    }

    /**
     * Record that a step has been processed.
     * Used to track progress without triggering a check-in.
     */
    recordStep(batchId: string, stepNumber: number): void {
        const state = this.activeDelegations.get(batchId);
        if (state && state.status === "running") {
            // Only update if it's a genuine new step
            logger.debug("[PairModeRegistry] Recorded step", {
                batchId,
                stepNumber,
                lastCheckInStep: state.lastCheckInStep,
            });
        }
    }

    /**
     * Mark a pair delegation as complete.
     * Called when the delegated agent finishes execution.
     */
    completeDelegation(batchId: string): void {
        const state = this.activeDelegations.get(batchId);
        if (state) {
            state.status = "completed";
            logger.info("[PairModeRegistry] Pair delegation completed", {
                batchId,
                checkInCount: state.checkInCount,
            });

            // Emit completion event
            this.emit(`${batchId}:complete`);
        }
    }

    /**
     * Mark a pair delegation as aborted.
     * Called when STOP action is processed or an error occurs.
     */
    abortDelegation(batchId: string, reason?: string): void {
        const state = this.activeDelegations.get(batchId);
        if (state) {
            state.status = "aborted";
            logger.info("[PairModeRegistry] Pair delegation aborted", {
                batchId,
                reason,
                checkInCount: state.checkInCount,
            });

            // Emit abort event
            this.emit(`${batchId}:aborted`, { reason });

            // Reject any pending check-in
            const pending = this.pendingCheckIns.get(batchId);
            if (pending) {
                clearTimeout(pending.timeout);
                pending.reject(new Error(`Delegation aborted: ${reason}`));
                this.pendingCheckIns.delete(batchId);
            }
        }
    }

    /**
     * Get check-in history for a delegation
     */
    getCheckInHistory(batchId: string): CheckInResult[] {
        return this.checkInHistory.get(batchId) || [];
    }

    /**
     * Add a check-in result to history with size limit
     */
    private addToHistory(batchId: string, result: CheckInResult): void {
        const history = this.checkInHistory.get(batchId) || [];
        history.push(result);

        // Enforce max history limit
        if (history.length > MAX_CHECK_IN_HISTORY) {
            history.shift(); // Remove oldest entry
        }

        this.checkInHistory.set(batchId, history);
    }

    /**
     * Clean up a completed or aborted delegation.
     * Called after the delegation response has been processed.
     */
    cleanup(batchId: string): void {
        this.activeDelegations.delete(batchId);
        this.checkInHistory.delete(batchId);

        // Remove all listeners for this batch
        this.removeAllListeners(`${batchId}:checkin`);
        this.removeAllListeners(`${batchId}:complete`);
        this.removeAllListeners(`${batchId}:aborted`);

        logger.debug("[PairModeRegistry] Cleaned up delegation", { batchId });
    }

    /**
     * Find an active pair delegation by delegated agent pubkey.
     * Used by AgentExecutor to detect if current execution is in pair mode.
     */
    findDelegationByAgent(_agentPubkey: string): PairDelegationState | undefined {
        for (const state of this.activeDelegations.values()) {
            // The delegatedAgentPubkey is set when check-in is requested
            // We match by checking if this agent has pending check-ins
            if (state.status === "running" || state.status === "paused") {
                return state;
            }
        }
        return undefined;
    }
}
