import { PHASES } from "@/conversations/phases";
import type { TracingLogger } from "@/tracing";
import { logger } from "@/utils/logger";
import type { StreamStateManager } from "./StreamStateManager";
import type { ExecutionContext } from "./types";
import { AgentPublisher } from "@/nostr/AgentPublisher";
import type { EventContext } from "@/nostr/AgentEventEncoder";

/**
 * Handles termination logic for agent execution.
 * Checks if agents properly terminated and logs when they don't.
 */
export class TerminationHandler {
  constructor(private stateManager: StreamStateManager) {}

  /**
   * Check if agent terminated properly and publish completion if not
   */
  async checkTermination(
    context: ExecutionContext, 
    tracingLogger: TracingLogger,
    eventContext?: EventContext
  ): Promise<void> {
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

    tracingLogger.info(`⚠️ ${message}`, {
      agent: context.agent.name,
      phase: context.phase,
    });

    // Publish the last response as a completion event
    const fullContent = this.stateManager.getFullContent();
    if (fullContent && eventContext) {
      tracingLogger.info(`⚠️ ${message}`, {
        fullContent
      });
      try {
        const agentPublisher = new AgentPublisher(
          context.agent, 
          context.conversationCoordinator
        );
        
        await agentPublisher.complete(
          {
            type: 'completion',
            content: fullContent,
          },
          eventContext
        );
        
        logger.info("Published auto-completion for unterminated agent", {
          agent: context.agent.name,
          phase: context.phase,
          contentLength: fullContent.length,
        });
      } catch (error) {
        logger.error("Failed to publish auto-completion", {
          error,
          agent: context.agent.name,
        });
      }
    }
  }
}
