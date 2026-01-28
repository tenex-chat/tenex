import { logger } from "@/utils/logger";
import { HeuristicRegistry } from "./heuristics/HeuristicRegistry";
import { supervisorLLMService } from "./SupervisorLLMService";
import { checkSupervisionHealth } from "./supervisionHealthCheck";
import type {
    CorrectionAction,
    HeuristicDetection,
    PostCompletionContext,
    PreToolContext,
    SupervisionContext,
    SupervisionState,
    VerificationResult,
} from "./types";
import { MAX_SUPERVISION_RETRIES } from "./types";
import { trace, SpanStatusCode } from "@opentelemetry/api";

const tracer = trace.getTracer("tenex.supervision");

/**
 * Determines if a correction message should be built for the given action.
 * - inject-message type always needs a message
 * - block-tool type always needs a message
 * - suppress-publish type needs a message only when reEngage is true (to guide the agent on what to fix)
 * Uses strict undefined check to preserve intentional empty strings.
 */
function shouldBuildCorrectionMessage(action: CorrectionAction): boolean {
    if (action.message !== undefined) return false;
    if (action.type === "inject-message" || action.type === "block-tool") return true;
    return action.type === "suppress-publish" && action.reEngage === true;
}

/**
 * Result of a supervision check
 */
export interface SupervisionCheckResult {
    /** Whether any heuristic was triggered and verified as a violation */
    hasViolation: boolean;
    /** The correction action to take if there's a violation */
    correctionAction?: CorrectionAction;
    /** The heuristic that triggered the violation */
    heuristicId?: string;
    /** The detection that was triggered */
    detection?: HeuristicDetection;
    /** The verification result from the LLM */
    verification?: VerificationResult;
}

/**
 * Main orchestrator for agent supervision
 * Coordinates heuristic checks and LLM verification
 */
export class SupervisorOrchestrator {
    private supervisionStates: Map<string, SupervisionState> = new Map();
    private registry: HeuristicRegistry;

    constructor() {
        this.registry = HeuristicRegistry.getInstance();
    }

    /**
     * Get the current supervision state for an execution
     * Creates a new state if one doesn't exist
     * @param executionId - Unique identifier for the execution
     */
    getSupervisionState(executionId: string): SupervisionState {
        let state = this.supervisionStates.get(executionId);
        if (!state) {
            state = {
                retryCount: 0,
                maxRetries: MAX_SUPERVISION_RETRIES,
                enforcedHeuristics: new Set(),
            };
            this.supervisionStates.set(executionId, state);
        }
        return state;
    }

    /**
     * Check if a heuristic has been enforced in this execution
     * @param executionId - Unique identifier for the execution
     * @param heuristicId - The heuristic ID to check
     */
    isHeuristicEnforced(executionId: string, heuristicId: string): boolean {
        const state = this.getSupervisionState(executionId);
        return state.enforcedHeuristics.has(heuristicId);
    }

    /**
     * Mark a heuristic as enforced for this execution
     * @param executionId - Unique identifier for the execution
     * @param heuristicId - The heuristic ID to mark as enforced
     */
    markHeuristicEnforced(executionId: string, heuristicId: string): void {
        const state = this.getSupervisionState(executionId);
        state.enforcedHeuristics.add(heuristicId);
        logger.debug(`[SupervisorOrchestrator] Marked heuristic "${heuristicId}" as enforced for ${executionId}`);
    }

    /**
     * Increment the retry count for an execution
     * @param executionId - Unique identifier for the execution
     */
    incrementRetryCount(executionId: string): void {
        const state = this.getSupervisionState(executionId);
        state.retryCount++;
        logger.debug(`[SupervisorOrchestrator] Retry count for ${executionId}: ${state.retryCount}`);
    }

    /**
     * Check if an execution has exceeded the maximum retries
     * @param executionId - Unique identifier for the execution
     */
    hasExceededMaxRetries(executionId: string): boolean {
        const state = this.getSupervisionState(executionId);
        return state.retryCount >= state.maxRetries;
    }

    /**
     * Clear the supervision state for an execution
     * @param executionId - Unique identifier for the execution
     */
    clearState(executionId: string): void {
        this.supervisionStates.delete(executionId);
        logger.debug(`[SupervisorOrchestrator] Cleared supervision state for ${executionId}`);
    }

    /**
     * Build the supervision context for LLM verification
     */
    private buildSupervisionContext(
        context: PostCompletionContext | PreToolContext,
        heuristicId: string,
        detection: HeuristicDetection
    ): SupervisionContext {
        return {
            agentSlug: context.agentSlug,
            agentPubkey: context.agentPubkey,
            systemPrompt: context.systemPrompt,
            conversationHistory: context.conversationHistory,
            availableTools: context.availableTools,
            triggeringHeuristic: heuristicId,
            detection,
        };
    }

    /**
     * Check all post-completion heuristics
     * @param context - The post-completion context
     * @param executionId - Unique identifier for the execution (used to skip already-enforced heuristics)
     * @returns Result of the supervision check
     */
    async checkPostCompletion(context: PostCompletionContext, executionId?: string): Promise<SupervisionCheckResult> {
        const span = tracer.startSpan("supervision.check_post_completion", {
            attributes: {
                "agent.slug": context.agentSlug,
                "agent.pubkey": context.agentPubkey,
                "execution.id": executionId || "none",
            },
        });

        // Track if any error occurred during heuristic execution
        let hadError = false;

        try {
            // Use centralized health check for consistent fail-closed validation
            // NOTE: We do NOT call registerDefaultHeuristics() here. Registration must happen
            // at startup (in AgentExecutor or ProjectRuntime). If heuristics aren't registered,
            // we fail-closed by checking the current state and throwing.
            const healthResult = checkSupervisionHealth();

            span.setAttributes({
                "heuristics.registry_size": healthResult.registrySize,
                "heuristics.post_completion_count": healthResult.postCompletionCount,
                "heuristics.ids": healthResult.heuristicIds.join(","),
            });

            // FAIL-CLOSED: Health check validates both registry size AND post-completion count
            if (!healthResult.healthy) {
                const errorMessage = `[SupervisorOrchestrator] ${healthResult.errorMessage}`;

                logger.error(errorMessage);
                span.recordException(new Error(errorMessage));
                span.setStatus({ code: SpanStatusCode.ERROR, message: "Supervision health check failed" });
                span.addEvent("supervision.health_check_failed", {
                    "registry.size": healthResult.registrySize,
                    "registry.ids": healthResult.heuristicIds.join(","),
                    "post_completion.count": healthResult.postCompletionCount,
                });

                throw new Error(
                    "Supervision system misconfigured: no post-completion heuristics registered. " +
                    "Call registerDefaultHeuristics() during startup."
                );
            }

            const heuristics = this.registry.getPostCompletionHeuristics();

            // Routine execution - use DEBUG level to avoid log spam
            logger.debug(
                `[SupervisorOrchestrator] Running ${heuristics.length} post-completion heuristics for ${context.agentSlug}`,
                {
                    heuristicIds: heuristics.map(h => h.id),
                    registrySize: healthResult.registrySize,
                    executionId,
                }
            );

            span.addEvent("supervision.heuristics_check_started", {
                "heuristics.count": heuristics.length,
            });

            for (const heuristic of heuristics) {
                // Skip heuristics already enforced in this execution
                if (executionId && this.isHeuristicEnforced(executionId, heuristic.id)) {
                    logger.debug(`[SupervisorOrchestrator] Skipping heuristic "${heuristic.id}" - already enforced`);
                    continue;
                }

                try {
                    // Run detection
                    const detection = await heuristic.detect(context);

                    span.addEvent("supervision.heuristic_checked", {
                        "heuristic.id": heuristic.id,
                        "heuristic.triggered": detection.triggered,
                    });

                    if (!detection.triggered) {
                        continue;
                    }

                    // Triggered heuristics are significant - keep at INFO level
                    logger.info(
                        `[SupervisorOrchestrator] Heuristic "${heuristic.id}" triggered for ${context.agentSlug}`,
                        { reason: detection.reason }
                    );

                    // For heuristics that skip verification, treat detection as confirmed
                    if (heuristic.skipVerification) {
                        logger.debug(
                            `[SupervisorOrchestrator] Heuristic "${heuristic.id}" skips verification, applying correction directly`
                        );

                        const syntheticVerification: VerificationResult = {
                            verdict: "violation",
                            explanation: "Heuristic configured to skip LLM verification",
                        };

                        const correctionAction = heuristic.getCorrectionAction(syntheticVerification);

                        if (shouldBuildCorrectionMessage(correctionAction)) {
                            correctionAction.message = heuristic.buildCorrectionMessage(
                                context,
                                syntheticVerification
                            );
                        }

                        span.addEvent("supervision.violation_detected", {
                            "heuristic.id": heuristic.id,
                            "action.type": correctionAction.type,
                            "skipped_verification": true,
                        });
                        span.setStatus({ code: SpanStatusCode.OK });

                        return {
                            hasViolation: true,
                            correctionAction,
                            heuristicId: heuristic.id,
                            detection,
                            verification: syntheticVerification,
                        };
                    }

                    // Build verification prompt and context
                    const verificationPrompt = heuristic.buildVerificationPrompt(context, detection);
                    const supervisionContext = this.buildSupervisionContext(
                        context,
                        heuristic.id,
                        detection
                    );

                    // Verify with LLM
                    const verification = await supervisorLLMService.verify(
                        supervisionContext,
                        verificationPrompt
                    );

                    if (verification.verdict === "violation") {
                        // Violations are significant - keep at WARN level
                        logger.warn(
                            `[SupervisorOrchestrator] Violation confirmed for heuristic "${heuristic.id}"`,
                            { explanation: verification.explanation }
                        );

                        // Get correction action
                        const correctionAction = heuristic.getCorrectionAction(verification);

                        // Build correction message if action type supports it
                        if (shouldBuildCorrectionMessage(correctionAction)) {
                            correctionAction.message = heuristic.buildCorrectionMessage(
                                context,
                                verification
                            );
                        }

                        span.addEvent("supervision.violation_detected", {
                            "heuristic.id": heuristic.id,
                            "action.type": correctionAction.type,
                            "skipped_verification": false,
                        });
                        span.setStatus({ code: SpanStatusCode.OK });

                        return {
                            hasViolation: true,
                            correctionAction,
                            heuristicId: heuristic.id,
                            detection,
                            verification,
                        };
                    }

                    // False positives are routine - use DEBUG level
                    logger.debug(
                        `[SupervisorOrchestrator] Heuristic "${heuristic.id}" detection was false positive`,
                        { explanation: verification.explanation }
                    );
                } catch (error) {
                    // Normalize error before recording
                    const normalizedError = error instanceof Error ? error : new Error(String(error));
                    hadError = true;

                    logger.error(
                        `[SupervisorOrchestrator] Error running heuristic "${heuristic.id}"`,
                        normalizedError
                    );
                    span.recordException(normalizedError);
                    // Continue to next heuristic on error
                }
            }

            span.addEvent("supervision.check_completed", {
                "violations_found": false,
                "had_errors": hadError,
            });

            // Set span status based on whether errors occurred during heuristic execution
            if (hadError) {
                span.setStatus({ code: SpanStatusCode.ERROR, message: "Errors occurred during heuristic execution" });
            } else {
                span.setStatus({ code: SpanStatusCode.OK });
            }

            // Routine successful completion - use DEBUG level
            logger.debug("[SupervisorOrchestrator] All heuristics passed - no violations detected", {
                agent: context.agentSlug,
                heuristicsChecked: heuristics.length,
            });

            return { hasViolation: false };
        } catch (error) {
            // Normalize error before recording
            const normalizedError = error instanceof Error ? error : new Error(String(error));
            span.recordException(normalizedError);
            span.setStatus({ code: SpanStatusCode.ERROR });
            throw error;
        } finally {
            span.end();
        }
    }

    /**
     * Check pre-tool execution heuristics for a specific tool
     * @param context - The pre-tool context
     * @param executionId - Unique identifier for the execution (used to skip already-enforced heuristics)
     * @returns Result of the supervision check
     */
    async checkPreTool(context: PreToolContext, executionId?: string): Promise<SupervisionCheckResult> {
        const heuristics = this.registry.getPreToolHeuristics(context.toolName);

        if (heuristics.length === 0) {
            logger.debug(
                `[SupervisorOrchestrator] No pre-tool heuristics for tool "${context.toolName}"`
            );
            return { hasViolation: false };
        }

        logger.debug(
            `[SupervisorOrchestrator] Running ${heuristics.length} pre-tool heuristics for "${context.toolName}"`
        );

        for (const heuristic of heuristics) {
            // Skip heuristics already enforced in this execution
            if (executionId && this.isHeuristicEnforced(executionId, heuristic.id)) {
                logger.debug(`[SupervisorOrchestrator] Skipping pre-tool heuristic "${heuristic.id}" - already enforced`);
                continue;
            }

            try {
                // Run detection
                const detection = await heuristic.detect(context);

                if (!detection.triggered) {
                    continue;
                }

                logger.info(
                    `[SupervisorOrchestrator] Pre-tool heuristic "${heuristic.id}" triggered for "${context.toolName}"`,
                    { reason: detection.reason }
                );

                // Build verification prompt and context
                const verificationPrompt = heuristic.buildVerificationPrompt(context, detection);
                const supervisionContext = this.buildSupervisionContext(
                    context,
                    heuristic.id,
                    detection
                );

                // Verify with LLM
                const verification = await supervisorLLMService.verify(
                    supervisionContext,
                    verificationPrompt
                );

                if (verification.verdict === "violation") {
                    logger.warn(
                        `[SupervisorOrchestrator] Pre-tool violation confirmed for "${heuristic.id}"`,
                        { explanation: verification.explanation, tool: context.toolName }
                    );

                    // Get correction action
                    const correctionAction = heuristic.getCorrectionAction(verification);

                    // Build correction message if action type supports it
                    if (shouldBuildCorrectionMessage(correctionAction)) {
                        correctionAction.message = heuristic.buildCorrectionMessage(
                            context,
                            verification
                        );
                    }

                    return {
                        hasViolation: true,
                        correctionAction,
                        heuristicId: heuristic.id,
                        detection,
                        verification,
                    };
                }

                logger.debug(
                    `[SupervisorOrchestrator] Pre-tool heuristic "${heuristic.id}" was false positive`,
                    { explanation: verification.explanation }
                );
            } catch (error) {
                logger.error(
                    `[SupervisorOrchestrator] Error running pre-tool heuristic "${heuristic.id}"`,
                    error
                );
                // Continue to next heuristic on error
            }
        }

        return { hasViolation: false };
    }
}

/**
 * Singleton instance of the supervisor orchestrator
 */
export const supervisorOrchestrator = new SupervisorOrchestrator();
