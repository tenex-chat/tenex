import type { AgentInstance } from "@/agents/types";
import type { CompleteEvent } from "@/llm/service";
import type { EventContext } from "@/nostr/AgentEventEncoder";
import type { AgentPublisher } from "@/nostr/AgentPublisher";
import { buildSystemPromptMessages } from "@/prompts/utils/systemPromptBuilder";
import { config } from "@/services/ConfigService";
import { getProjectContext, isProjectContextInitialized } from "@/services/projects";
import { logger } from "@/utils/logger";
import { formatConversationSnapshot } from "@/utils/phase-utils";
import { trace } from "@opentelemetry/api";
import { getAgentWorktrees, type WorktreeMetadata } from "@/utils/git/worktree";
import * as fs from "node:fs/promises";
import type { ToolExecutionTracker } from "./ToolExecutionTracker";
import type { ExecutionContext } from "./types";

/**
 * AgentSupervisor - Monitors agent execution and validates completion
 *
 * This class supervises agent execution to ensure:
 * 1. The agent produces an actual response (not just reasoning)
 * 2. The agent doesn't accidentally skip defined phases
 *
 * It integrates with ToolExecutionTracker to monitor phase usage.
 */
export class AgentSupervisor {
    private invalidReason: string | undefined;
    private continuationAttempts = 0;
    private maxContinuationAttempts = 3;
    private lastInvalidReason: string | undefined;
    private phaseValidationDecision: string | undefined;
    private worktreeCleanupDecision: string | undefined;

    constructor(
        private agent: AgentInstance,
        private context: ExecutionContext,
        private toolTracker: ToolExecutionTracker
    ) {}

    /**
     * Check if any phases were skipped
     */
    checkPhaseCompletion(): { skipped: boolean; unusedPhases: string[] } {
        if (!this.agent.phases) {
            logger.info("[AgentSupervisor] No phases defined for agent", {
                agent: this.agent.slug,
            });
            return { skipped: false, unusedPhases: [] };
        }

        // Get all executions from the current tracker
        const allExecutions = this.toolTracker.getAllExecutions();

        // Find delegate executions with phase from this turn
        const executedPhases = new Set<string>();

        for (const execution of allExecutions.values()) {
            if (execution.toolName === "delegate") {
                // Extract phase name from the args (unified delegate tool)
                const args = execution.input as { delegations?: Array<{ phase?: string }> };
                if (args?.delegations) {
                    for (const delegation of args.delegations) {
                        if (delegation.phase) {
                            executedPhases.add(delegation.phase.toLowerCase());
                        }
                    }
                }
            }
        }

        // Also check historical phases from previous turns
        const historicalPhases = this.scanHistoricalPhases();
        const allExecutedPhases = new Set([...executedPhases, ...historicalPhases]);

        // Check what's missing
        const definedPhases = Object.keys(this.agent.phases);
        const unusedPhases = definedPhases.filter((p) => !allExecutedPhases.has(p.toLowerCase()));

        trace.getActiveSpan()?.addEvent("supervisor.phase_check", {
            "phase.defined_count": definedPhases.length,
            "phase.executed_this_turn": executedPhases.size,
            "phase.skipped": unusedPhases.length > 0,
        });

        return {
            skipped: unusedPhases.length > 0,
            unusedPhases,
        };
    }

    /**
     * Scan historical phases (from previous turns)
     */
    private scanHistoricalPhases(): Set<string> {
        const historicalPhases = new Set<string>();
        const conversation = this.context.getConversation();

        if (!conversation) return historicalPhases;

        // Only scan events BEFORE this execution started
        for (const event of conversation.history) {
            if (event.pubkey !== this.agent.pubkey) continue;
            if (event.id === this.context.triggeringEvent.id) break; // Stop at current trigger

            const toolTag = event.tags.find((t) => t[0] === "tool" && t[1] === "delegate");
            if (toolTag) {
                // Check if this delegation had a phase
                const phaseTag = event.tags.find((t) => t[0] === "phase");
                if (phaseTag?.[1]) {
                    historicalPhases.add(phaseTag[1].toLowerCase());
                }
            }
        }

        return historicalPhases;
    }

    /**
     * Check if there are pending todo items (items with status='pending')
     */
    checkTodoCompletion(): { hasPending: boolean; pendingItems: string[] } {
        const conversation = this.context.getConversation();
        if (!conversation) {
            return { hasPending: false, pendingItems: [] };
        }

        const todos = conversation.agentTodos.get(this.agent.pubkey) || [];
        const pendingTodos = todos.filter((t) => t.status === "pending");

        trace.getActiveSpan()?.addEvent("supervisor.todo_check", {
            "todo.pending_count": pendingTodos.length,
            "todo.pending_items": pendingTodos.map((t) => t.title).join(","),
        });

        return {
            hasPending: pendingTodos.length > 0,
            pendingItems: pendingTodos.map((t) => t.title),
        };
    }

    /**
     * Reset state for continuation
     */
    reset(): void {
        this.invalidReason = undefined;
        this.phaseValidationDecision = undefined;
        this.worktreeCleanupDecision = undefined;
        // Don't reset continuationAttempts or lastInvalidReason - track across the entire execution
        // Keep toolTracker state to accumulate phase usage
    }

    /**
     * Get the continuation prompt for when execution is not complete
     */
    getContinuationPrompt(): string {
        return this.invalidReason || "Please continue with your task.";
    }

    /**
     * Check if the execution is complete and publish any decisions
     * @param completionEvent - The completion event from the LLM (can be undefined if stream failed)
     * @param agentPublisher - Publisher for nostr events
     * @param eventContext - Context for event publishing
     * @returns true if execution is complete, false if it needs to continue
     */
    async isExecutionComplete(
        completionEvent: CompleteEvent | undefined,
        agentPublisher: AgentPublisher,
        eventContext: EventContext
    ): Promise<boolean> {
        const activeSpan = trace.getActiveSpan();

        activeSpan?.addEvent("supervisor.validation_start", {
            "supervisor.continuation_attempts": this.continuationAttempts,
            "supervisor.has_phases": !!this.agent.phases,
            "supervisor.phase_count": this.agent.phases
                ? Object.keys(this.agent.phases).length
                : 0,
        });

        // Check if we've exceeded max continuation attempts
        if (this.continuationAttempts >= this.maxContinuationAttempts) {
            logger.warn(
                "[AgentSupervisor] ⚠️ Max continuation attempts reached, forcing completion",
                {
                    agent: this.agent.slug,
                    attempts: this.continuationAttempts,
                    lastReason: this.lastInvalidReason,
                }
            );

            activeSpan?.addEvent("supervisor.forced_completion", {
                "reason": "max_attempts_exceeded",
                "attempts": this.continuationAttempts,
            });

            return true;
        }

        // First validation: Check if we received a completion event at all
        if (!completionEvent) {
            logger.error("[AgentSupervisor] ❌ INVALID: No completion event received from LLM", {
                agent: this.agent.slug,
                attempts: this.continuationAttempts,
            });

            const reason = "The LLM did not return a completion event. Please try again.";

            activeSpan?.addEvent("supervisor.validation_failed", {
                "validation.type": "missing_completion_event",
                "validation.attempts": this.continuationAttempts,
            });

            this.invalidReason = reason;
            this.lastInvalidReason = reason;
            this.continuationAttempts++;
            return false;
        }

        // Second validation: Check if there's an actual response (not just reasoning)
        if (!completionEvent.message?.trim()) {
            const reason =
                "You didn't provide a response to the user. Please address their request.";

            activeSpan?.addEvent("supervisor.empty_response", {
                "validation.has_reasoning": !!completionEvent.reasoning,
            });

            this.invalidReason = reason;
            this.lastInvalidReason = reason;
            this.continuationAttempts++;
            return false;
        }

        activeSpan?.addEvent("supervisor.response_validated", {
            "response.length": completionEvent.message.length,
        });

        // Third validation: Check phase completion if applicable
        if (this.agent.phases && Object.keys(this.agent.phases).length > 0) {
            activeSpan?.addEvent("supervisor.checking_phases", {
                "phase.defined_count": Object.keys(this.agent.phases).length,
            });

            const phaseCheck = this.checkPhaseCompletion();

            if (phaseCheck.skipped) {
                activeSpan?.addEvent("supervisor.phases_skipped", {
                    "phase.unused": phaseCheck.unusedPhases.join(","),
                });

                // Validate if skipping was intentional
                const shouldContinue = await this.validatePhaseSkipping(completionEvent.message);

                if (shouldContinue) {
                    activeSpan?.addEvent("supervisor.phases_needed", {
                        "phase.unused": phaseCheck.unusedPhases.join(","),
                    });
                    this.invalidReason = shouldContinue;
                    this.lastInvalidReason = shouldContinue;
                    this.continuationAttempts++;
                    return false;
                }

                activeSpan?.addEvent("supervisor.skip_intentional", {
                    "phase.skipped": phaseCheck.unusedPhases.join(","),
                });
            } else {
                activeSpan?.addEvent("supervisor.phases_complete");
            }
        }

        // Fourth validation: Check todo completion (pending items)
        const todoCheck = this.checkTodoCompletion();
        if (todoCheck.hasPending) {
            activeSpan?.addEvent("supervisor.todos_pending", {
                "todo.pending_count": todoCheck.pendingItems.length,
                "todo.pending_items": todoCheck.pendingItems.join(","),
            });

            // Validate if pending todos were intentionally not addressed
            const shouldContinue = await this.validateTodoPending(
                completionEvent.message,
                todoCheck.pendingItems
            );

            if (shouldContinue) {
                activeSpan?.addEvent("supervisor.todos_needed", {
                    "todo.pending": todoCheck.pendingItems.join(","),
                });
                this.invalidReason = shouldContinue;
                this.lastInvalidReason = shouldContinue;
                this.continuationAttempts++;
                return false;
            }

            activeSpan?.addEvent("supervisor.todos_skip_intentional", {
                "todo.skipped": todoCheck.pendingItems.join(","),
            });
        }

        // Fifth validation: Check for worktrees created by this agent
        const worktreeCheck = await this.checkWorktreeCreation();
        if (worktreeCheck.created) {
            // Ask agent about worktree cleanup
            const cleanupPrompt = await this.validateWorktreeCleanup(
                completionEvent.message,
                worktreeCheck.worktrees
            );

            if (cleanupPrompt) {
                activeSpan?.addEvent("supervisor.worktree_cleanup_needed", {
                    "worktree.count": worktreeCheck.worktrees.length,
                    "worktree.branches": worktreeCheck.worktrees
                        .map((wt) => wt.branch)
                        .join(", "),
                });

                this.invalidReason = cleanupPrompt;
                this.lastInvalidReason = cleanupPrompt;
                this.continuationAttempts++;
                return false;
            }

            activeSpan?.addEvent("supervisor.worktree_addressed", {
                "worktree.count": worktreeCheck.worktrees.length,
            });
        }

        // All validations passed - publish any decisions before completing
        if (this.phaseValidationDecision) {
            await agentPublisher.conversation(
                {
                    content: this.phaseValidationDecision,
                    isReasoning: true,
                },
                eventContext
            );
        }

        if (this.worktreeCleanupDecision) {
            await agentPublisher.conversation(
                {
                    content: this.worktreeCleanupDecision,
                    isReasoning: true,
                },
                eventContext
            );
        }

        activeSpan?.addEvent("supervisor.complete");
        return true;
    }

    /**
     * Validate if phase skipping was intentional using conversation snapshot
     * @param completionContent - The agent's response that skipped phases
     * @returns continuation instruction if agent should continue with phases, empty string if skipping was intentional
     */
    async validatePhaseSkipping(completionContent: string): Promise<string> {
        const phaseCheck = this.checkPhaseCompletion();
        if (!phaseCheck.skipped) {
            return ""; // No phases skipped, no need to continue
        }

        try {
            // Format the conversation as a readable snapshot
            const conversationSnapshot = await formatConversationSnapshot(this.context);

            // Get the agent's system prompt to understand its behavior and phase definitions
            const systemPrompt = await this.getSystemPrompt();

            // Build validation messages with system context + snapshot
            const validationPrompt = this.buildValidationPrompt(
                phaseCheck.unusedPhases,
                conversationSnapshot,
                completionContent
            );

            // Create LLM service with NO TOOLS to force text response
            const llmService = this.context.agent.createLLMService();

            // Make the validation call with system prompt + validation question
            const result = await llmService.complete(
                [
                    {
                        role: "system",
                        content: systemPrompt,
                    },
                    {
                        role: "system",
                        content: validationPrompt.system,
                    },
                    {
                        role: "user",
                        content: validationPrompt.user,
                    },
                ],
                {} // No tools
            );

            const response = result.text?.trim() || "";
            const responseLower = response.toLowerCase();
            const shouldContinue = responseLower.includes("continue");

            // Store the decision for later retrieval
            this.phaseValidationDecision = response;

            return shouldContinue ? response : "";
        } catch (error) {
            logger.error("[AgentSupervisor] ❌ Phase validation failed", {
                agent: this.agent.slug,
                error: error instanceof Error ? error.message : String(error),
                defaulting: "Assuming phases were intentionally skipped",
            });
            // On error, assume phases were intentional
            return "";
        }
    }

    /**
     * Get the agent's system prompt
     */
    private async getSystemPrompt(): Promise<string> {
        const conversation = this.context.getConversation();

        if (!conversation) {
            // Fallback minimal prompt
            return `You are ${this.context.agent.name}. ${this.context.agent.instructions || ""}`;
        }

        if (isProjectContextInitialized()) {
            // Project mode
            const projectCtx = getProjectContext();
            const project = projectCtx.project;
            const availableAgents = Array.from(projectCtx.agents.values());
            const agentLessonsMap = new Map();
            const currentAgentLessons = projectCtx.getLessonsForAgent(this.context.agent.pubkey);

            if (currentAgentLessons.length > 0) {
                agentLessonsMap.set(this.context.agent.pubkey, currentAgentLessons);
            }

            const isProjectManager =
                this.context.agent.pubkey === projectCtx.getProjectManager().pubkey;

            const systemMessages = await buildSystemPromptMessages({
                agent: this.context.agent,
                project,
                projectBasePath: this.context.projectBasePath,
                workingDirectory: this.context.workingDirectory,
                currentBranch: this.context.currentBranch,
                availableAgents,
                conversation,
                agentLessons: agentLessonsMap,
                isProjectManager,
                projectManagerPubkey: projectCtx.getProjectManager().pubkey,
                alphaMode: this.context.alphaMode,
            });

            // Combine all system messages into one
            return systemMessages.map((msg) => msg.message.content).join("\n\n");
        }
        // Fallback minimal prompt
        return `You are ${this.context.agent.name}. ${this.context.agent.instructions || ""}`;
    }

    /**
     * Build a contextual validation prompt that speaks directly to the agent
     */
    private buildValidationPrompt(
        unusedPhases: string[],
        conversationSnapshot: string,
        agentResponse: string
    ): { system: string; user: string } {
        const system = `You just completed a response without executing all your defined phases.

<conversation-history>
${conversationSnapshot}
</conversation-history>

<your-response>
${agentResponse}
</your-response>

<phases not executed>
${unusedPhases.join(", ")}
</phases not executed>`;

        const user = `Review the conversation flow and your response. Consider:
1. Did you fully address what was requested in the conversation?
2. Would executing your unused phases provide additional value or complete the task?
3. Was skipping these phases appropriate given the specific request?

Respond in one of two formats:
- "I'M DONE: [brief explanation of why you intentionally skipped the phases]"
- "CONTINUE: [brief explanation of what you will do next]" if you should execute your phases for a more complete response. Be specific about which phase you'll execute and why.`;

        return { system, user };
    }

    /**
     * Validate if pending todos were intentionally not addressed
     * @param completionContent - The agent's response that left todos pending
     * @param pendingItems - List of pending todo titles
     * @returns continuation instruction if agent should continue, empty string if intentional
     */
    async validateTodoPending(completionContent: string, pendingItems: string[]): Promise<string> {
        if (pendingItems.length === 0) {
            return ""; // No pending todos
        }

        try {
            const conversationSnapshot = await formatConversationSnapshot(this.context);
            const systemPrompt = await this.getSystemPrompt();

            const validationPrompt = this.buildTodoValidationPrompt(
                pendingItems,
                conversationSnapshot,
                completionContent
            );

            const llmService = this.context.agent.createLLMService();

            const result = await llmService.complete(
                [
                    { role: "system", content: systemPrompt },
                    { role: "system", content: validationPrompt.system },
                    { role: "user", content: validationPrompt.user },
                ],
                {} // No tools
            );

            const response = result.text?.trim() || "";
            const shouldContinue = response.toLowerCase().includes("continue");

            // Reuse phaseValidationDecision for todo decisions
            this.phaseValidationDecision = response;

            return shouldContinue ? response : "";
        } catch (error) {
            logger.error("[AgentSupervisor] ❌ Todo validation failed", {
                agent: this.agent.slug,
                error: error instanceof Error ? error.message : String(error),
            });
            return "";
        }
    }

    /**
     * Build validation prompt for pending todos
     */
    private buildTodoValidationPrompt(
        pendingItems: string[],
        conversationSnapshot: string,
        agentResponse: string
    ): { system: string; user: string } {
        const system = `You just completed a response but have pending todo items.

<conversation-history>
${conversationSnapshot}
</conversation-history>

<your-response>
${agentResponse}
</your-response>

<pending-todos>
${pendingItems.join("\n")}
</pending-todos>`;

        const user = `Review the conversation and your pending todos. Consider:
1. Did you fully address what was requested?
2. Are the pending items still relevant to the task?
3. Should you complete them or explicitly skip them (with a reason)?

Respond in one of two formats:
- "I'M DONE: [brief explanation of why pending items are not needed]"
- "CONTINUE: [brief explanation of what you will do next]"`;

        return { system, user };
    }

    /**
     * Check for worktrees created by this agent
     */
    async checkWorktreeCreation(): Promise<{ created: boolean; worktrees: WorktreeMetadata[] }> {
        const agentWorktrees = await getAgentWorktrees(
            this.context.projectBasePath,
            config.getConfigPath("projects"),
            this.agent.pubkey,
            this.context.conversationId
        );

        const activeWorktrees: WorktreeMetadata[] = [];

        // Check if these worktrees still exist
        for (const worktree of agentWorktrees) {
            try {
                await fs.access(worktree.path);
                // Only consider worktrees that haven't been merged or deleted
                if (!worktree.mergedAt && !worktree.deletedAt) {
                    activeWorktrees.push(worktree);
                }
            } catch {
                // Worktree path doesn't exist anymore
            }
        }

        return {
            created: activeWorktrees.length > 0,
            worktrees: activeWorktrees,
        };
    }

    /**
     * Validate if worktree cleanup was addressed
     * @param completionContent - The agent's response
     * @param worktrees - The worktrees created by this agent
     * @returns continuation instruction if agent should cleanup worktrees, empty string if addressed
     */
    async validateWorktreeCleanup(
        completionContent: string,
        worktrees: WorktreeMetadata[]
    ): Promise<string> {
        // Check if the agent's response mentions any of the worktree branches
        const mentionedBranches = worktrees.filter((wt) =>
            completionContent.toLowerCase().includes(wt.branch.toLowerCase())
        );

        // Check for common cleanup-related keywords
        const cleanupKeywords = [
            "merge",
            "merged",
            "delete",
            "deleted",
            "remove",
            "removed",
            "keep",
            "keeping",
            "retain",
            "leave",
            "worktree",
            "branch",
            "cleanup",
            "clean up",
        ];

        const hasCleanupKeywords = cleanupKeywords.some((keyword) =>
            completionContent.toLowerCase().includes(keyword)
        );

        // If response mentions branches and cleanup keywords, assume it was addressed
        if (mentionedBranches.length > 0 && hasCleanupKeywords) {
            this.worktreeCleanupDecision = `Agent addressed worktree cleanup for branches: ${mentionedBranches.map((wt) => wt.branch).join(", ")}`;
            return "";
        }

        // Build the cleanup prompt
        const branchList = worktrees
            .map((wt) => `- Branch "${wt.branch}" (created from ${wt.parentBranch})`)
            .join("\n");

        const cleanupPrompt = `You created the following git worktree${worktrees.length > 1 ? "s" : ""} during this task:
${branchList}

Please specify what should be done with ${worktrees.length > 1 ? "these worktrees" : "this worktree"}:
- MERGE: If the work is complete and should be merged back to the parent branch
- DELETE: If the worktree is no longer needed and can be removed
- KEEP: If the worktree should remain for future work

Use appropriate git commands (git merge, git worktree remove, etc.) to perform the cleanup, or clearly state your decision if you want to keep ${worktrees.length > 1 ? "them" : "it"}.`;

        return cleanupPrompt;
    }
}
