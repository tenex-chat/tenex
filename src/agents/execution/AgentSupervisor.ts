/**
 * AgentSupervisor - Monitors agent execution and validates completion
 *
 * This class supervises agent execution to ensure:
 * 1. The agent produces an actual response (not just reasoning)
 * 2. The agent doesn't accidentally skip defined phases
 *
 * Validation logic is delegated to focused modules:
 * - PhaseValidator: Phase completion validation
 * - TodoValidator: Todo completion validation
 * - WorktreeValidator: Worktree cleanup validation
 */

import type { AgentInstance } from "@/agents/types";
import type { CompleteEvent } from "@/llm/service";
import type { EventContext } from "@/nostr/AgentEventEncoder";
import type { AgentPublisher } from "@/nostr/AgentPublisher";
import { buildSystemPromptMessages } from "@/prompts/utils/systemPromptBuilder";
import { getProjectContext, isProjectContextInitialized } from "@/services/projects";
import { logger } from "@/utils/logger";
import { trace } from "@opentelemetry/api";

import type { ToolExecutionTracker } from "./ToolExecutionTracker";
import type { ExecutionContext } from "./types";
import {
    checkPhaseCompletion,
    validatePhaseSkipping,
} from "./validators/PhaseValidator";
import {
    checkTodoCompletion,
    validateTodoPending,
} from "./validators/TodoValidator";
import {
    checkWorktreeCreation,
    validateWorktreeCleanup,
} from "./validators/WorktreeValidator";

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
        return checkPhaseCompletion(this.agent, this.toolTracker, this.context);
    }

    /**
     * Check if there are pending todo items (items with status='pending')
     */
    checkTodoCompletion(): { hasPending: boolean; pendingItems: string[] } {
        return checkTodoCompletion(this.agent, this.context);
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
                const shouldContinue = await validatePhaseSkipping(
                    this.agent,
                    this.context,
                    this.toolTracker,
                    completionEvent.message,
                    () => this.getSystemPrompt()
                );

                if (shouldContinue) {
                    activeSpan?.addEvent("supervisor.phases_needed", {
                        "phase.unused": phaseCheck.unusedPhases.join(","),
                    });
                    this.phaseValidationDecision = shouldContinue;
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
            const shouldContinue = await validateTodoPending(
                this.agent,
                this.context,
                completionEvent.message,
                todoCheck.pendingItems,
                () => this.getSystemPrompt()
            );

            if (shouldContinue) {
                activeSpan?.addEvent("supervisor.todos_needed", {
                    "todo.pending": todoCheck.pendingItems.join(","),
                });
                this.phaseValidationDecision = shouldContinue;
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
        const worktreeCheck = await checkWorktreeCreation(this.agent, this.context);
        if (worktreeCheck.created) {
            // Ask agent about worktree cleanup
            const cleanupPrompt = validateWorktreeCleanup(
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

            this.worktreeCleanupDecision = `Agent addressed worktree cleanup for branches: ${worktreeCheck.worktrees.map((wt) => wt.branch).join(", ")}`;

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
}
