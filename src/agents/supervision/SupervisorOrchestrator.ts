import { logger } from "@/utils/logger";
import { HeuristicRegistry } from "./heuristics/HeuristicRegistry";
import { supervisorLLMService } from "./SupervisorLLMService";
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
            };
            this.supervisionStates.set(executionId, state);
        }
        return state;
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
     * @returns Result of the supervision check
     */
    async checkPostCompletion(context: PostCompletionContext): Promise<SupervisionCheckResult> {
        const heuristics = this.registry.getPostCompletionHeuristics();

        if (heuristics.length === 0) {
            logger.debug("[SupervisorOrchestrator] No post-completion heuristics registered");
            return { hasViolation: false };
        }

        logger.debug(
            `[SupervisorOrchestrator] Running ${heuristics.length} post-completion heuristics for ${context.agentSlug}`
        );

        for (const heuristic of heuristics) {
            try {
                // Run detection
                const detection = await heuristic.detect(context);

                if (!detection.triggered) {
                    continue;
                }

                logger.info(
                    `[SupervisorOrchestrator] Heuristic "${heuristic.id}" triggered for ${context.agentSlug}`,
                    { reason: detection.reason }
                );

                // For heuristics that skip verification, treat detection as confirmed
                if (heuristic.skipVerification) {
                    logger.info(
                        `[SupervisorOrchestrator] Heuristic "${heuristic.id}" skips verification, applying correction directly`
                    );

                    const syntheticVerification: VerificationResult = {
                        verdict: "violation",
                        explanation: "Heuristic configured to skip LLM verification",
                    };

                    const correctionAction = heuristic.getCorrectionAction(syntheticVerification);

                    if (correctionAction.type === "inject-message" && !correctionAction.message) {
                        correctionAction.message = heuristic.buildCorrectionMessage(
                            context,
                            syntheticVerification
                        );
                    }

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
                    logger.warn(
                        `[SupervisorOrchestrator] Violation confirmed for heuristic "${heuristic.id}"`,
                        { explanation: verification.explanation }
                    );

                    // Get correction action
                    const correctionAction = heuristic.getCorrectionAction(verification);

                    // Build correction message if action type supports it
                    if ((correctionAction.type === "inject-message" || correctionAction.type === "block-tool") && !correctionAction.message) {
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
                    `[SupervisorOrchestrator] Heuristic "${heuristic.id}" detection was false positive`,
                    { explanation: verification.explanation }
                );
            } catch (error) {
                logger.error(
                    `[SupervisorOrchestrator] Error running heuristic "${heuristic.id}"`,
                    error
                );
                // Continue to next heuristic on error
            }
        }

        return { hasViolation: false };
    }

    /**
     * Check pre-tool execution heuristics for a specific tool
     * @param context - The pre-tool context
     * @returns Result of the supervision check
     */
    async checkPreTool(context: PreToolContext): Promise<SupervisionCheckResult> {
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
                    if ((correctionAction.type === "inject-message" || correctionAction.type === "block-tool") && !correctionAction.message) {
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
