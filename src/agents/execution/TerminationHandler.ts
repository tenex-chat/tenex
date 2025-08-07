import type { TracingLogger } from "@/tracing";
import type { ExecutionContext } from "./types";
import { Message } from "multi-llm-ts";
import { StreamStateManager } from "./StreamStateManager";
import { ExecutionConfig } from "./constants";
import { getProjectContext } from "@/services/ProjectContext";
import { PHASES } from "@/conversations/phases";

/**
 * Handles termination logic for agent execution.
 * Responsible for enforcing proper termination, generating reminder messages,
 * and auto-completing when agents fail to terminate properly.
 */
export class TerminationHandler {
    constructor(private stateManager: StreamStateManager) {}

    /**
     * Check if termination is required and enforce it if necessary
     * @returns true if should continue with another attempt, false if properly terminated
     */
    shouldRetryForTermination(
        context: ExecutionContext,
        attempt: number,
        tracingLogger: TracingLogger
    ): boolean {
        // Check if this agent requires termination enforcement
        const isChat = context.phase.toLowerCase() === PHASES.CHAT;
        const isBrainstormPhase = context.phase.toLowerCase() === PHASES.BRAINSTORM;
        const requiresTerminationEnforcement = !isChat && !isBrainstormPhase;

        // If terminated properly or termination not required, we're done
        if (this.stateManager.hasTerminated() || !requiresTerminationEnforcement) {
            return false;
        }

        // If we haven't reached max attempts, retry
        if (attempt < ExecutionConfig.MAX_TERMINATION_ATTEMPTS) {
            tracingLogger.info(
                `📢 ${context.agent.isOrchestrator ? "Orchestrator" : "Non-orchestrator"} agent did not call terminal tool, will retry`,
                {
                    agent: context.agent.name,
                    phase: context.phase,
                    attempt,
                    maxAttempts: ExecutionConfig.MAX_TERMINATION_ATTEMPTS,
                }
            );
            return true;
        }

        // Max attempts reached - auto-complete
        tracingLogger.info("⚠️ Max termination attempts reached, auto-completing", {
            agent: context.agent.name,
            phase: context.phase,
        });
        
        this.autoCompleteTermination(context, tracingLogger);
        return false;
    }

    /**
     * Get reminder message for agents that didn't terminate properly
     */
    getReminderMessage(context: ExecutionContext): string {
        if (context.agent.isOrchestrator) {
            return `I see you've finished processing, but you haven't provided routing instructions yet. As the orchestrator, you MUST route to appropriate agents for the next task. Remember: you are a silent router - provide routing instructions, never speak to users directly.`;
        } else {
            return "I see you've finished responding, but you haven't used the 'complete' tool yet. As a non-orchestrator agent, you MUST use the 'complete' tool to signal that your work is done and report back to the orchestrator. Please use the 'complete' tool now with a summary of what you accomplished.";
        }
    }

    /**
     * Prepare messages for retry attempt with reminder
     */
    prepareRetryMessages(
        currentMessages: Message[],
        context: ExecutionContext,
        tracingLogger: TracingLogger
    ): Message[] {
        const reminderMessage = this.getReminderMessage(context);
        
        tracingLogger.info("📝 Preparing retry with reminder message", {
            agent: context.agent.name,
            previousMessageCount: currentMessages.length,
            contentPreview: this.stateManager.getFullContent().substring(0, 100) + "...",
        });

        return [
            ...currentMessages,
            new Message("assistant", this.stateManager.getFullContent()),
            new Message("user", reminderMessage),
        ];
    }

    /**
     * Auto-complete termination when agent fails to call terminal tool
     */
    private autoCompleteTermination(
        context: ExecutionContext,
        tracingLogger: TracingLogger
    ): void {
        tracingLogger.error(
            `${context.agent.isOrchestrator ? "Orchestrator" : "Agent"} failed to call terminal tool even after reminder - auto-completing`,
            {
                agent: context.agent.name,
                phase: context.phase,
                conversationId: context.conversationId,
                isOrchestrator: context.agent.isOrchestrator,
            }
        );

        const autoCompleteContent = this.stateManager.getFullContent() || "Task completed";

        if (context.agent.isOrchestrator) {
            // For orchestrator, we can't auto-complete since it needs to route
            // This is a critical error - orchestrator must always route
            tracingLogger.error("Orchestrator failed to route - this should not happen", {
                agent: context.agent.name,
                phase: context.phase,
            });
            throw new Error("Orchestrator must provide routing instructions");
        } else {
            // For non-orchestrator, complete back to orchestrator
            const projectContext = getProjectContext();
            const orchestratorAgent = projectContext.getProjectAgent();

            this.stateManager.setTermination({
                type: "complete",
                completion: {
                    response: autoCompleteContent,
                    summary:
                        "Agent completed its turn but failed to call the complete tool after a reminder. [Auto-completed by system]",
                    nextAgent: orchestratorAgent.pubkey,
                },
            });
        }
    }

    /**
     * Check if the current phase/agent combination requires termination enforcement
     */
    requiresTerminationEnforcement(context: ExecutionContext): boolean {
        const isChat = context.phase.toLowerCase() === PHASES.CHAT;
        const isBrainstormPhase = context.phase.toLowerCase() === PHASES.BRAINSTORM;
        return !isChat && !isBrainstormPhase;
    }
}