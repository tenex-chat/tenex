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
    // If agent already terminated properly, we're done
    if (this.stateManager.hasTerminated()) {
      return;
    }

    // Auto-complete for all phases that didn't explicitly terminate
    const fullContent = this.stateManager.getFullContent();
    if (!fullContent || !eventContext) {
      return;
    }

    // Determine if implicit completion is expected for this phase
    const isChat = context.phase === PHASES.CHAT;
    const isBrainstorm = context.phase === PHASES.BRAINSTORM;
    const isExpectedImplicitCompletion = isChat || isBrainstorm;

    // Log appropriately based on whether implicit completion is expected
    if (!isExpectedImplicitCompletion) {
      // Warn for phases where explicit completion is expected
      const message = `Agent finished without calling terminal tool (${context.agent.name})`;
      tracingLogger.info(`⚠️ ${message}`, {
        agent: context.agent.name,
        phase: context.phase,
        contentPreview: fullContent.substring(0, 100),
      });
    } else {
      // Debug log for phases where implicit completion is normal
      tracingLogger.debug("Auto-completing agent response", {
        agent: context.agent.name,
        phase: context.phase,
        contentLength: fullContent.length,
      });
    }

    // Publish the completion event
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
      
      logger.info("Published auto-completion", {
        agent: context.agent.name,
        phase: context.phase,
        wasExpected: isExpectedImplicitCompletion,
        contentLength: fullContent.length,
      });
    } catch (error) {
      logger.error("Failed to publish auto-completion", {
        error,
        agent: context.agent.name,
        phase: context.phase,
      });
    }
  }
}
