import type { AgentInstance } from "@/agents/types";
import type { ConversationCoordinator } from "@/conversations";
import type { DelegationIntent } from "@/nostr/AgentEventEncoder";
import type { AgentPublisher } from "@/nostr/AgentPublisher";
import { DelegationRegistry } from "@/services/delegation";
import { PairModeRegistry } from "@/services/delegation/PairModeRegistry";
import type {
    DelegationMode,
    PairCheckInRequest,
    PairModeAction,
    PairModeConfig,
} from "@/services/delegation/types";
import { DEFAULT_PAIR_MODE_CONFIG } from "@/services/delegation/types";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

export interface DelegationResponses {
    type: "delegation_responses";
    responses: Array<{
        response: string;
        summary?: string;
        from: string;
        event?: NDKEvent; // The actual response event for threading
    }>;
    worktrees?: Array<{
        branch: string;
        path: string;
    }>;
    /** True if the delegation was aborted (pair mode STOP) */
    aborted?: boolean;
    /** Reason for abort if applicable */
    abortReason?: string;
}

/**
 * Options for delegation execution
 */
export interface DelegationExecuteOptions {
    /** Execution mode: 'blocking' (default) or 'pair' */
    mode?: DelegationMode;
    /** Configuration for pair mode (only used when mode is 'pair') */
    pairConfig?: Partial<PairModeConfig>;
}

/**
 * Service that handles delegation execution.
 * Orchestrates the complete delegation workflow: publishing events and waiting for responses.
 */
export class DelegationService {
    constructor(
        private agent: AgentInstance,
        private conversationId: string,
        private conversationCoordinator: ConversationCoordinator,
        private triggeringEvent: NDKEvent,
        private publisher: AgentPublisher,
        private projectPath: string,
        private currentBranch: string
    ) {}

    /**
     * Execute a delegation and wait for all responses.
     *
     * @param intent - The delegation intent with recipients and requests
     * @param options - Optional execution options including mode and pairConfig
     */
    async execute(
        intent: DelegationIntent & { suggestions?: string[] },
        options?: DelegationExecuteOptions
    ): Promise<DelegationResponses> {
        const mode = options?.mode ?? "blocking";
        // Check for self-delegation attempts
        const selfDelegationAttempts = intent.delegations.filter(
            (d) => d.recipient === this.agent.pubkey
        );

        // Only allow self-delegation when phase is explicitly provided
        if (selfDelegationAttempts.length > 0) {
            const hasPhase = selfDelegationAttempts.some((d) => d.phase);
            if (!hasPhase) {
                throw new Error(
                    `Self-delegation is not permitted. Agent "${this.agent.slug}" cannot delegate to itself. Self-delegation is only allowed when specifying a phase for phase transitions.`
                );
            }

            logger.info("[DelegationService] 🔄 Agent delegating to itself via phase transition", {
                fromAgent: this.agent.slug,
                agentPubkey: this.agent.pubkey,
                phases: selfDelegationAttempts.map((d) => d.phase),
            });
        }

        // Create worktrees for delegations that specify a branch
        const worktrees: Array<{ branch: string; path: string }> = [];

        for (const delegation of intent.delegations) {
            if (delegation.branch) {
                const { createWorktree, trackWorktreeCreation } = await import("@/utils/git/worktree");

                try {
                    const worktreePath = await createWorktree(
                        this.projectPath,
                        delegation.branch,
                        this.currentBranch
                    );

                    await trackWorktreeCreation(this.projectPath, {
                        path: worktreePath,
                        branch: delegation.branch,
                        createdBy: this.agent.pubkey,
                        conversationId: this.conversationId,
                        parentBranch: this.currentBranch,
                    });

                    worktrees.push({ branch: delegation.branch, path: worktreePath });

                    logger.info("Created worktree for delegation", {
                        branch: delegation.branch,
                        path: worktreePath,
                        recipient: delegation.recipient.substring(0, 8),
                    });
                } catch (error) {
                    logger.error("Failed to create worktree", {
                        branch: delegation.branch,
                        error: error instanceof Error ? error.message : String(error),
                    });
                    throw new Error(
                        `Failed to create worktree "${delegation.branch}": ${error instanceof Error ? error.message : String(error)}`
                    );
                }
            }
        }

        // Build event context
        const conversation = this.conversationCoordinator.getConversation(this.conversationId);
        const eventContext = {
            triggeringEvent: this.triggeringEvent,
            rootEvent: conversation?.history[0] ?? this.triggeringEvent, // Use triggering event as fallback
            conversationId: this.conversationId,
        };

        // Publish based on intent type
        let result: { batchId: string };

        if (intent.type === "ask") {
            // Handle ask intent - convert to single delegation format for ask
            const askResult = await this.publisher.ask(
                {
                    content: intent.delegations[0]?.request ?? "",
                    suggestions: intent.suggestions,
                },
                eventContext
            );
            result = { batchId: askResult.batchId };
        } else if (intent.type === "delegation_followup") {
            result = await this.publisher.delegateFollowUp(intent, eventContext);
        } else {
            result = await this.publisher.delegate(intent, eventContext);
        }

        // Wait for all responses
        const registry = DelegationRegistry.getInstance();

        // Handle pair mode vs blocking mode
        if (mode === "pair") {
            const delegatedAgentPubkeys = intent.delegations.map((d) => d.recipient);
            return this.executePairMode(result.batchId, options?.pairConfig, worktrees, delegatedAgentPubkeys);
        }

        // Default blocking mode - wait for all responses with no timeout
        const completions = await registry.waitForBatchCompletion(result.batchId);

        logger.debug("Delegation responses received", {
            count: completions.length,
            batchId: result.batchId,
        });

        // Return formatted responses with event details
        return {
            type: "delegation_responses",
            responses: completions.map((c) => ({
                response: c.response,
                summary: c.summary,
                from: c.assignedTo,
                event: c.event,
            })),
            worktrees: worktrees.length > 0 ? worktrees : undefined,
        };
    }

    /**
     * Execute delegation in pair mode with periodic check-ins.
     * The delegator can CONTINUE, STOP, or CORRECT the delegated agent.
     */
    private async executePairMode(
        batchId: string,
        pairConfig?: Partial<PairModeConfig>,
        worktrees?: Array<{ branch: string; path: string }>,
        delegatedAgentPubkeys: string[] = []
    ): Promise<DelegationResponses> {
        const config: Required<PairModeConfig> = {
            stepThreshold: pairConfig?.stepThreshold ?? DEFAULT_PAIR_MODE_CONFIG.stepThreshold,
            checkInTimeoutMs: pairConfig?.checkInTimeoutMs ?? DEFAULT_PAIR_MODE_CONFIG.checkInTimeoutMs,
        };

        logger.info("[DelegationService] Starting pair mode delegation", {
            batchId,
            stepThreshold: config.stepThreshold,
            checkInTimeoutMs: config.checkInTimeoutMs,
        });

        const pairRegistry = PairModeRegistry.getInstance();
        const delegationRegistry = DelegationRegistry.getInstance();

        // Register this delegation for pair mode monitoring
        pairRegistry.registerPairDelegation(batchId, this.agent.pubkey, config, delegatedAgentPubkeys);

        // Set up check-in handler
        return new Promise<DelegationResponses>((resolve) => {
            // Handle check-in requests from delegated agent
            const checkInHandler = async (request: PairCheckInRequest): Promise<void> => {
                logger.info("[DelegationService] Received check-in request", {
                    batchId: request.batchId,
                    stepNumber: request.stepNumber,
                    delegatedAgent: request.delegatedAgentSlug,
                });

                try {
                    // Evaluate the delegated agent's progress
                    const action = await this.handleCheckIn(request);

                    // Send response back to pair registry
                    pairRegistry.respondToCheckIn(batchId, action);
                } catch (error) {
                    logger.error("[DelegationService] Failed to handle check-in", {
                        batchId,
                        error: error instanceof Error ? error.message : String(error),
                    });
                    // Default to CONTINUE on error
                    pairRegistry.respondToCheckIn(batchId, { type: "CONTINUE" });
                }
            };

            // Handle completion
            const completeHandler = async (): Promise<void> => {
                logger.info("[DelegationService] Pair mode delegation completed", { batchId });

                // Clean up listeners
                pairRegistry.off(`${batchId}:checkin`, checkInHandler);
                pairRegistry.off(`${batchId}:complete`, completeHandler);
                pairRegistry.off(`${batchId}:aborted`, abortHandler);

                // Get final completions
                const completions = await delegationRegistry.waitForBatchCompletion(batchId);

                // Cleanup pair mode state
                pairRegistry.cleanup(batchId);

                resolve({
                    type: "delegation_responses",
                    responses: completions.map((c) => ({
                        response: c.response,
                        summary: c.summary,
                        from: c.assignedTo,
                        event: c.event,
                    })),
                    worktrees: worktrees && worktrees.length > 0 ? worktrees : undefined,
                });
            };

            // Handle abort (STOP action)
            const abortHandler = async (data: { reason?: string }): Promise<void> => {
                logger.info("[DelegationService] Pair mode delegation aborted", {
                    batchId,
                    reason: data.reason,
                });

                // Clean up listeners
                pairRegistry.off(`${batchId}:checkin`, checkInHandler);
                pairRegistry.off(`${batchId}:complete`, completeHandler);
                pairRegistry.off(`${batchId}:aborted`, abortHandler);

                // Get any partial completions
                const completions = delegationRegistry.getBatchCompletions(batchId);

                // Cleanup pair mode state
                pairRegistry.cleanup(batchId);

                resolve({
                    type: "delegation_responses",
                    responses: completions.map((c) => ({
                        response: c.response,
                        summary: c.summary,
                        from: c.assignedTo,
                        event: c.event,
                    })),
                    worktrees: worktrees && worktrees.length > 0 ? worktrees : undefined,
                    aborted: true,
                    abortReason: data.reason,
                });
            };

            // Register listeners
            pairRegistry.on(`${batchId}:checkin`, checkInHandler);
            pairRegistry.on(`${batchId}:complete`, completeHandler);
            pairRegistry.on(`${batchId}:aborted`, abortHandler);
        });
    }

    /**
     * Handle a check-in request by evaluating the delegated agent's progress.
     * Invokes the delegator's LLM to decide CONTINUE, STOP, or CORRECT.
     */
    private async handleCheckIn(request: PairCheckInRequest): Promise<PairModeAction> {
        logger.info("[DelegationService] Handling check-in from delegated agent", {
            batchId: request.batchId,
            stepNumber: request.stepNumber,
            delegatedAgent: request.delegatedAgentSlug,
            recentToolCalls: request.recentToolCalls.slice(-5),
        });

        // Build the review prompt for the delegator
        const reviewPrompt = this.buildReviewPrompt(request);

        try {
            // Create LLM service for the delegator to evaluate
            const llmService = this.agent.createLLMService({});

            // Use completion (non-streaming) for the review
            const result = await llmService.complete(
                [{ role: "user", content: reviewPrompt }],
                {}
            );

            // Parse the response to extract the action
            return this.parseCheckInResponse(result.text);
        } catch (error) {
            logger.error("[DelegationService] Failed to get delegator response for check-in", {
                batchId: request.batchId,
                error: error instanceof Error ? error.message : String(error),
            });
            // Default to CONTINUE on error
            return { type: "CONTINUE" };
        }
    }

    /**
     * Build the review prompt for the delegator to evaluate the delegated agent's progress.
     */
    private buildReviewPrompt(request: PairCheckInRequest): string {
        const toolCallsList = request.recentToolCalls.length > 0
            ? request.recentToolCalls.map((t) => `  - ${t}`).join("\n")
            : "  (none recorded)";

        return `# Pair Programming Check-In

You are supervising a delegated task. The delegated agent has reached a check-in point.
Review the progress below and decide how to proceed.

## Delegation Status
- **Delegated Agent**: ${request.delegatedAgentSlug || "Unknown"}
- **Steps Completed**: ${request.stepNumber}
- **Progress Summary**: ${request.progressSummary || "Not available"}

## Recent Tool Calls
${toolCallsList}

## Your Options

Respond with EXACTLY ONE of these actions:

1. **CONTINUE** - Let the agent keep working. Use this if progress looks good.

2. **STOP: <reason>** - Abort the delegation immediately. Use this if:
   - The agent is going in the wrong direction
   - The task should be abandoned
   - You want to take over

3. **CORRECT: <instruction>** - Provide guidance to the agent. Use this to:
   - Redirect the agent's approach
   - Add clarification or constraints
   - Suggest a different strategy

## Your Response

Respond with your chosen action (CONTINUE, STOP, or CORRECT):`;
    }

    /**
     * Parse the delegator's response to extract the action.
     */
    private parseCheckInResponse(response: string): PairModeAction {
        const trimmed = response.trim();
        const upperResponse = trimmed.toUpperCase();

        // Check for CONTINUE
        if (upperResponse === "CONTINUE" || upperResponse.startsWith("CONTINUE")) {
            logger.debug("[DelegationService] Parsed action: CONTINUE");
            return { type: "CONTINUE" };
        }

        // Check for STOP
        if (upperResponse.startsWith("STOP")) {
            const colonIndex = trimmed.indexOf(":");
            const reason = colonIndex !== -1 ? trimmed.substring(colonIndex + 1).trim() : undefined;
            logger.debug("[DelegationService] Parsed action: STOP", { reason });
            return { type: "STOP", reason };
        }

        // Check for CORRECT
        if (upperResponse.startsWith("CORRECT")) {
            const colonIndex = trimmed.indexOf(":");
            const message = colonIndex !== -1 ? trimmed.substring(colonIndex + 1).trim() : trimmed;
            logger.debug("[DelegationService] Parsed action: CORRECT", { messagePreview: message.substring(0, 50) });
            return { type: "CORRECT", message };
        }

        // Default to CONTINUE if we can't parse
        logger.warn("[DelegationService] Could not parse check-in response, defaulting to CONTINUE", {
            responsePreview: trimmed.substring(0, 100),
        });
        return { type: "CONTINUE" };
    }
}
