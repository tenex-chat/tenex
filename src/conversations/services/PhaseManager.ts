import { logger } from "@/utils/logger";
import type { ExecutionQueueManager } from "../executionQueue";
import type { Phase } from "../phases";
import { PHASES } from "../phases";
import type { Conversation, PhaseTransition } from "../types";

export interface PhaseTransitionContext {
  agentPubkey: string;
  agentName: string;
  message: string;
}

export interface PhaseTransitionResult {
  success: boolean;
  transition?: PhaseTransition;
  queued?: boolean;
  queuePosition?: number;
  queueMessage?: string;
  estimatedWait?: number;
}

/**
 * Manages conversation phase transitions and execution queue.
 * Handles phase transitions (all allowed) and EXECUTE phase queueing.
 */
export class PhaseManager {
  constructor(private executionQueueManager?: ExecutionQueueManager) {}

  /**
   * Attempt a phase transition
   * Note: All transitions are allowed - PM decides what makes sense
   */
  async transition(
    conversation: Conversation,
    to: Phase,
    context: PhaseTransitionContext
  ): Promise<PhaseTransitionResult> {
    const from = conversation.phase;

    // Same phase transitions are valid (delegations between agents)
    if (from === to) {
      const transition: PhaseTransition = {
        from,
        to,
        message: context.message,
        timestamp: Date.now(),
        agentPubkey: context.agentPubkey,
        agentName: context.agentName,
      };

      return {
        success: true,
        transition,
      };
    }

    // Handle EXECUTE phase entry with queue management
    if (to === PHASES.EXECUTE && this.executionQueueManager) {
      const permission = await this.executionQueueManager.requestExecution(
        conversation.id,
        context.agentPubkey
      );

      if (!permission.granted) {
        if (!permission.queuePosition || !permission.waitTime) {
          throw new Error("Invalid permission - missing queue position or wait time");
        }
        const queueMessage = this.formatQueueMessage(permission.queuePosition, permission.waitTime);

        logger.info(`[PhaseManager] Conversation ${conversation.id} queued for execution`, {
          position: permission.queuePosition,
          estimatedWait: permission.waitTime,
        });

        return {
          success: false,
          queued: true,
          queuePosition: permission.queuePosition,
          queueMessage,
          estimatedWait: permission.waitTime,
        };
      }
    }

    // Handle EXECUTE phase exit
    if (from === PHASES.EXECUTE && to !== PHASES.EXECUTE && this.executionQueueManager) {
      await this.executionQueueManager.releaseExecution(conversation.id, "phase_transition");
    }

    // Create transition record
    const transition: PhaseTransition = {
      from,
      to,
      message: context.message,
      timestamp: Date.now(),
      agentPubkey: context.agentPubkey,
      agentName: context.agentName,
    };

    logger.info("[PhaseManager] Phase transition", {
      conversationId: conversation.id,
      from,
      to,
      agent: context.agentName,
    });

    return {
      success: true,
      transition,
    };
  }


  /**
   * Setup queue event listeners
   */
  setupQueueListeners(
    onLockAcquired: (conversationId: string, agentPubkey: string) => Promise<void>,
    onTimeout: (conversationId: string) => Promise<void>,
    onTimeoutWarning: (conversationId: string, remainingMs: number) => Promise<void>
  ): void {
    if (!this.executionQueueManager) return;

    this.executionQueueManager.on("lock-acquired", onLockAcquired);
    this.executionQueueManager.on("timeout", onTimeout);
    this.executionQueueManager.on("timeout-warning", onTimeoutWarning);
  }

  private formatQueueMessage(position: number, waitTimeSeconds: number): string {
    const waitTime = this.formatWaitTime(waitTimeSeconds);
    return `🚦 Execution Queue Status\n\nYour conversation has been added to the execution queue.\n\nQueue Position: ${position}\nEstimated Wait Time: ${waitTime}\n\nYou will be automatically notified when execution begins.`;
  }

  private formatWaitTime(seconds: number): string {
    if (seconds < 60) {
      return `~${Math.floor(seconds)} seconds`;
    }
    if (seconds < 3600) {
      return `~${Math.floor(seconds / 60)} minutes`;
    }
    return `~${Math.floor(seconds / 3600)} hours`;
  }

  /**
   * Get the execution queue manager
   */
  getExecutionQueueManager(): ExecutionQueueManager | undefined {
    return this.executionQueueManager;
  }

  /**
   * Set the execution queue manager
   */
  setExecutionQueueManager(manager: ExecutionQueueManager): void {
    this.executionQueueManager = manager;
  }
}
