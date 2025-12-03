import type { AgentInstance } from "@/agents/types";
import type { ConversationCoordinator } from "@/conversations";
import type { DelegationIntent } from "@/nostr/AgentEventEncoder";
import type { AgentPublisher } from "@/nostr/AgentPublisher";
import { DelegationRegistry } from "@/services/delegation";
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
        private publisher: AgentPublisher
    ) {}

    /**
     * Execute a delegation and wait for all responses.
     */
    async execute(
        intent: DelegationIntent & { suggestions?: string[] }
    ): Promise<DelegationResponses> {
        // Check for self-delegation attempts
        const selfDelegationAttempts = intent.delegations.filter(
            (d) => d.recipient === this.agent.pubkey
        );

        // Only allow self-delegation when phase is explicitly provided (i.e., delegate_phase tool)
        if (selfDelegationAttempts.length > 0) {
            const hasPhase = selfDelegationAttempts.some((d) => d.phase);
            if (!hasPhase) {
                throw new Error(
                    `Self-delegation is not permitted. Agent "${this.agent.slug}" cannot delegate to itself. Self-delegation is only allowed when using the delegate_phase tool for phase transitions.`
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
                const { createWorktree } = await import("@/utils/git/initializeGitRepo");
                const { trackWorktreeCreation } = await import("@/utils/git/worktree");
                const { getProjectContext } = await import("@/services/ProjectContext");

                const projectContext = getProjectContext();
                const projectPath = projectContext.projectPath;
                const currentBranch = projectContext.currentBranch ?? "main";

                try {
                    const worktreePath = await createWorktree(
                        projectPath,
                        delegation.branch,
                        currentBranch
                    );

                    await trackWorktreeCreation(projectPath, {
                        path: worktreePath,
                        branch: delegation.branch,
                        createdBy: this.agent.pubkey,
                        conversationId: this.conversationId,
                        parentBranch: currentBranch,
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

        // Wait for all responses - no timeout as delegations are long-running
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
}
