/**
 * PairModeController - Runs within the delegated agent's execution context
 * to track steps and trigger check-ins with the delegator.
 *
 * This controller:
 * - Provides an async onStopCheck callback for check-ins (used in stopWhen)
 * - Provides sync correction injection for prepareStep
 * - Tracks the current step number in the AI SDK loop
 * - Throws PairModeAbortError when STOP is received
 */

import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { trace } from "@opentelemetry/api";
import type { StepResult } from "ai";
import { PairModeRegistry } from "./PairModeRegistry";
import type { PairCheckInRequest, PairModeConfig } from "./types";

/**
 * Error thrown when the delegator issues a STOP command.
 * This is caught by AgentExecutor to handle graceful abort.
 */
export class PairModeAbortError extends Error {
    public readonly reason?: string;

    constructor(reason?: string) {
        super(reason ? `Delegation stopped by supervisor: ${reason}` : "Delegation stopped by supervisor");
        this.name = "PairModeAbortError";
        this.reason = reason;
    }
}

/**
 * Controller for managing pair mode check-ins within a delegated agent.
 */
export class PairModeController {
    private stepCount = 0;
    private recentToolCalls: string[] = [];
    private aborted = false;
    private abortReason?: string;
    private lastCheckInStep = 0;
    private pendingCorrections: string[] = [];

    constructor(
        private readonly batchId: string,
        private readonly agentPubkey: string,
        private readonly agentSlug: string,
        private readonly config: Required<PairModeConfig>
    ) {
        // Add telemetry
        const activeSpan = trace.getActiveSpan();
        activeSpan?.addEvent("pair_mode.controller_created", {
            "pair_mode.batch_id": batchId,
            "pair_mode.agent_slug": agentSlug,
            "pair_mode.step_threshold": config.stepThreshold,
        });

        logger.info("[PairModeController] Created controller for pair mode delegation", {
            batchId,
            agentSlug,
            stepThreshold: config.stepThreshold,
        });
    }

    /**
     * Get the batch ID for this pair mode delegation.
     */
    getBatchId(): string {
        return this.batchId;
    }

    /**
     * Create an async callback for the LLMService onStopCheck option.
     * This is called after each step to determine if we should stop for a check-in.
     *
     * @returns Async function that returns true to stop, false to continue
     */
    createStopCheck(): (steps: StepResult<Record<string, AISdkTool>>[]) => Promise<boolean> {
        return async (steps: StepResult<Record<string, AISdkTool>>[]): Promise<boolean> => {
            // Update step count
            this.stepCount = steps.length;

            // Extract recent tool calls from steps
            for (const step of steps) {
                if (step.toolCalls) {
                    for (const tc of step.toolCalls) {
                        if (!this.recentToolCalls.includes(tc.toolName)) {
                            this.recentToolCalls.push(tc.toolName);
                            // Keep only last 10
                            if (this.recentToolCalls.length > 10) {
                                this.recentToolCalls.shift();
                            }
                        }
                    }
                }
            }

            // Check if we've already been aborted
            if (this.aborted) {
                const activeSpan = trace.getActiveSpan();
                activeSpan?.addEvent("pair_mode.stop_check_already_aborted", {
                    "pair_mode.batch_id": this.batchId,
                    "pair_mode.step_count": this.stepCount,
                });
                return true; // Stop the stream
            }

            // Check if we need to do a check-in
            const stepsSinceLastCheckIn = this.stepCount - this.lastCheckInStep;
            const shouldCheckIn = stepsSinceLastCheckIn >= this.config.stepThreshold;

            if (!shouldCheckIn) {
                return false; // Continue
            }

            // Add telemetry for threshold reached
            const activeSpan = trace.getActiveSpan();
            activeSpan?.addEvent("pair_mode.threshold_reached", {
                "pair_mode.batch_id": this.batchId,
                "pair_mode.current_step": this.stepCount,
                "pair_mode.last_check_in_step": this.lastCheckInStep,
                "pair_mode.threshold": this.config.stepThreshold,
            });

            logger.info("[PairModeController] Step threshold reached, requesting check-in", {
                batchId: this.batchId,
                currentStep: this.stepCount,
                lastCheckInStep: this.lastCheckInStep,
                threshold: this.config.stepThreshold,
            });

            const registry = PairModeRegistry.getInstance();

            // Build the check-in request
            const request: PairCheckInRequest = {
                batchId: this.batchId,
                delegatedAgentPubkey: this.agentPubkey,
                delegatedAgentSlug: this.agentSlug,
                stepNumber: this.stepCount,
                totalSteps: 0, // Unknown at runtime
                recentToolCalls: [...this.recentToolCalls],
                progressSummary: undefined,
            };

            // Request check-in (this blocks until delegator responds)
            const action = await registry.requestCheckIn(request);

            // Update our tracking
            this.lastCheckInStep = this.stepCount;

            // Handle the action
            switch (action.type) {
                case "CONTINUE":
                    activeSpan?.addEvent("pair_mode.action_continue", {
                        "pair_mode.batch_id": this.batchId,
                        "pair_mode.step_number": this.stepCount,
                    });
                    logger.info("[PairModeController] Delegator says CONTINUE", {
                        batchId: this.batchId,
                        stepNumber: this.stepCount,
                    });
                    return false; // Continue

                case "STOP":
                    activeSpan?.addEvent("pair_mode.action_stop", {
                        "pair_mode.batch_id": this.batchId,
                        "pair_mode.stop_reason": action.reason ?? "no reason provided",
                    });
                    logger.info("[PairModeController] Delegator says STOP", {
                        batchId: this.batchId,
                        reason: action.reason,
                    });
                    this.aborted = true;
                    this.abortReason = action.reason;
                    return true; // Stop the stream

                case "CORRECT":
                    activeSpan?.addEvent("pair_mode.action_correct", {
                        "pair_mode.batch_id": this.batchId,
                        "pair_mode.correction_preview": action.message.substring(0, 100),
                    });
                    logger.info("[PairModeController] Delegator says CORRECT", {
                        batchId: this.batchId,
                        messagePreview: action.message.substring(0, 100),
                    });
                    // Queue correction for next prepareStep
                    this.pendingCorrections.push(action.message);
                    return false; // Continue (prepareStep will inject the correction)
            }
        };
    }

    /**
     * Get and clear any pending correction messages.
     * Called by prepareStep to inject corrections into the conversation.
     *
     * @returns Array of correction messages to inject, empty if none
     */
    getPendingCorrections(): string[] {
        const corrections = [...this.pendingCorrections];
        this.pendingCorrections = [];
        return corrections;
    }

    /**
     * Check if this controller has been aborted
     */
    isAborted(): boolean {
        return this.aborted;
    }

    /**
     * Get the abort reason if aborted
     */
    getAbortReason(): string | undefined {
        return this.abortReason;
    }

    /**
     * Get the current step count
     */
    getStepCount(): number {
        return this.stepCount;
    }

    /**
     * Get recent tool calls for diagnostics
     */
    getRecentToolCalls(): string[] {
        return [...this.recentToolCalls];
    }

    /**
     * Record tool calls made in a step (called from tool tracker)
     */
    recordToolCalls(toolNames: string[]): void {
        for (const name of toolNames) {
            if (!this.recentToolCalls.includes(name)) {
                this.recentToolCalls.push(name);
                if (this.recentToolCalls.length > 10) {
                    this.recentToolCalls.shift();
                }
            }
        }
    }
}
