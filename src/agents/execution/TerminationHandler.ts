import type { TracingLogger } from "@/tracing";
import type { ExecutionContext } from "./types";
import { StreamStateManager } from "./StreamStateManager";
import { PHASES } from "@/conversations/phases";
import { logger } from "@/utils/logger";

/**
 * Handles termination logic for agent execution.
 * Checks if agents properly terminated and logs when they don't.
 */
export class TerminationHandler {
    constructor(private stateManager: StreamStateManager) {}

    /**
     * Check if agent terminated properly and log if not
     */
    checkTermination(
        context: ExecutionContext,
        tracingLogger: TracingLogger
    ): void {
        // Check if this agent requires termination
        const isChat = context.phase === PHASES.CHAT;
        const isBrainstormPhase = context.phase === PHASES.BRAINSTORM;
        const requiresTermination = !isChat && !isBrainstormPhase;

        // If terminated properly or termination not required, we're done
        if (this.stateManager.hasTerminated() || !requiresTermination) {
            return;
        }

        // Log that agent didn't terminate properly
        const message = `Agent finished without calling terminal tool (${context.agent.name})`;
        
        logger.info(message, {
            agent: context.agent.name,
            phase: context.phase,
            conversationId: context.conversationId,
        });
        
        tracingLogger.info(`⚠️ ${message}`, {
            agent: context.agent.name,
            phase: context.phase,
        });
    }
}