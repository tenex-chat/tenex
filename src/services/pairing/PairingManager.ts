import type { NDKEvent, NDKSubscription } from "@nostr-dev-kit/ndk";
import { getNDK } from "@/nostr/ndkClient";
import { RALRegistry } from "@/services/ral";
import { logger } from "@/utils/logger";
import type { PairingConfig, PairingState, AgentEventSummary } from "./types";

/** Callback to trigger agent resumption */
export type ResumeCallback = (agentPubkey: string, conversationId: string) => Promise<void>;

/**
 * PairingManager handles real-time delegation supervision for a single project.
 *
 * When an agent delegates with `pair: { interval: N }`, the PairingManager:
 * 1. Subscribes to tool execution events from the worker agent
 * 2. Every N tool events, triggers a checkpoint
 * 3. Queues checkpoint message into supervisor's RAL
 * 4. Triggers supervisor resumption to process checkpoint
 *
 * Each ProjectRuntime has its own PairingManager instance.
 */
export class PairingManager {
  /** Active pairings keyed by delegationId */
  private pairings: Map<string, PairingState> = new Map();

  /** NDK subscriptions keyed by delegationId */
  private subscriptions: Map<string, NDKSubscription> = new Map();

  /** Callback to trigger supervisor resumption - set by ProjectRuntime */
  private resumeCallback: ResumeCallback;

  constructor(resumeCallback: ResumeCallback) {
    this.resumeCallback = resumeCallback;
  }

  /**
   * Start pairing observation for a delegation.
   */
  startPairing(
    delegationId: string,
    config: PairingConfig,
    supervisorPubkey: string,
    supervisorConversationId: string,
    supervisorRalNumber: number
  ): void {
    // Clean up any existing pairing for this delegation
    if (this.pairings.has(delegationId)) {
      this.stopPairing(delegationId);
    }

    const state: PairingState = {
      delegationId,
      supervisorPubkey,
      supervisorConversationId,
      supervisorRalNumber,
      recipientSlug: config.recipientSlug,
      interval: config.interval,
      eventBuffer: [],
      eventsSinceLastCheckpoint: 0,
      totalEventsSeen: 0,
      checkpointNumber: 0,
      createdAt: Date.now(),
    };

    this.pairings.set(delegationId, state);

    // Subscribe to all events from the worker agent referencing this delegation
    const ndk = getNDK();
    const sub = ndk.subscribe(
      {
        kinds: [1],
        "#e": [delegationId],
      },
      { closeOnEose: false }
    );

    sub.on("event", (event: NDKEvent) => {
      this.handleEvent(delegationId, event);
    });

    sub.on("closed", () => {
      logger.warn("[PairingManager] Subscription closed unexpectedly", {
        delegationId: delegationId.substring(0, 8),
      });
    });

    this.subscriptions.set(delegationId, sub);

    logger.info("[PairingManager] Started pairing", {
      delegationId: delegationId.substring(0, 8),
      supervisor: supervisorPubkey.substring(0, 8),
      recipientSlug: config.recipientSlug,
      interval: config.interval,
    });
  }

  /**
   * Stop pairing observation for a delegation.
   */
  stopPairing(delegationId: string): void {
    const sub = this.subscriptions.get(delegationId);
    if (sub) {
      sub.stop();
      this.subscriptions.delete(delegationId);
    }

    const state = this.pairings.get(delegationId);
    if (state) {
      logger.info("[PairingManager] Stopped pairing", {
        delegationId: delegationId.substring(0, 8),
        totalEventsSeen: state.totalEventsSeen,
        checkpoints: state.checkpointNumber,
      });
    }

    this.pairings.delete(delegationId);
  }

  /**
   * Check if a delegation has active pairing.
   */
  hasPairing(delegationId: string): boolean {
    return this.pairings.has(delegationId);
  }

  /**
   * Get pairing state for debugging/telemetry.
   */
  getPairingState(delegationId: string): PairingState | undefined {
    return this.pairings.get(delegationId);
  }

  /**
   * Get all active pairing delegation IDs for a supervisor.
   */
  getActivePairingsForSupervisor(supervisorPubkey: string): string[] {
    const delegationIds: string[] = [];
    for (const [delegationId, state] of this.pairings) {
      if (state.supervisorPubkey === supervisorPubkey) {
        delegationIds.push(delegationId);
      }
    }
    return delegationIds;
  }

  /**
   * Handle incoming event from subscription.
   * Captures both tool executions and agent text output.
   */
  private handleEvent(delegationId: string, event: NDKEvent): void {
    const state = this.pairings.get(delegationId);
    if (!state) return;

    // Check if this is a tool execution event
    const toolTag = event.tagValue("tool");

    let summary: AgentEventSummary;

    if (toolTag) {
      // Tool execution event
      summary = {
        type: "tool",
        tool: toolTag,
        args: this.extractToolArgs(event),
        resultSummary: this.summarizeContent(event.content),
        timestamp: event.created_at || Math.floor(Date.now() / 1000),
      };
    } else if (event.content && event.content.trim()) {
      // Agent text output
      summary = {
        type: "output",
        content: this.summarizeContent(event.content),
        timestamp: event.created_at || Math.floor(Date.now() / 1000),
      };
    } else {
      // Empty or irrelevant event, skip
      return;
    }

    state.eventBuffer.push(summary);
    state.eventsSinceLastCheckpoint++;
    state.totalEventsSeen++;

    logger.debug("[PairingManager] Event received", {
      delegationId: delegationId.substring(0, 8),
      type: summary.type,
      ...(summary.type === "tool" ? { tool: summary.tool } : {}),
      eventsSinceCheckpoint: state.eventsSinceLastCheckpoint,
      interval: state.interval,
    });

    // Check if checkpoint is due
    if (state.eventsSinceLastCheckpoint >= state.interval) {
      this.triggerCheckpoint(delegationId, state);
    }
  }

  /**
   * Extract tool arguments from event.
   */
  private extractToolArgs(event: NDKEvent): Record<string, unknown> {
    const argsTag = event.tagValue("tool-args");
    if (!argsTag) return {};

    try {
      return JSON.parse(argsTag);
    } catch {
      return {};
    }
  }

  /**
   * Summarize event content (truncate if too long).
   */
  private summarizeContent(content: string): string {
    const maxLength = 200;
    if (content.length <= maxLength) return content;
    return content.substring(0, maxLength) + "...";
  }

  /**
   * Trigger a checkpoint for the supervisor.
   */
  private async triggerCheckpoint(delegationId: string, state: PairingState): Promise<void> {
    state.checkpointNumber++;

    const checkpointInfo = this.buildCheckpointMessage(state);

    // Queue into supervisor's RAL
    const ralRegistry = RALRegistry.getInstance();
    ralRegistry.queueSystemMessage(
      state.supervisorPubkey,
      state.supervisorConversationId,
      state.supervisorRalNumber,
      checkpointInfo
    );

    // Only include guidance instructions on the first checkpoint
    if (state.checkpointNumber === 1) {
      const userInstruction = this.buildCheckpointInstruction(state);
      ralRegistry.queueUserMessage(
        state.supervisorPubkey,
        state.supervisorConversationId,
        state.supervisorRalNumber,
        userInstruction
      );
    }

    // Reset checkpoint state
    const eventCount = state.eventBuffer.length;
    state.eventBuffer = [];
    state.eventsSinceLastCheckpoint = 0;
    state.lastCheckpointAt = Date.now();

    logger.info("[PairingManager] Triggered checkpoint", {
      delegationId: delegationId.substring(0, 8),
      checkpointNumber: state.checkpointNumber,
      eventsSummarized: eventCount,
    });

    // Trigger supervisor resumption
    try {
      await this.resumeCallback(state.supervisorPubkey, state.supervisorConversationId);
    } catch (error) {
      logger.error("[PairingManager] Failed to trigger resumption", {
        delegationId: delegationId.substring(0, 8),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Build the checkpoint message to inject into supervisor's context.
   */
  private buildCheckpointMessage(state: PairingState): string {
    const recipientLabel = state.recipientSlug
      ? `@${state.recipientSlug}`
      : "delegated agent";

    const eventLines = state.eventBuffer
      .map((event, i) => {
        if (event.type === "tool") {
          const argsPreview = this.formatArgs(event.args);
          return `${i + 1}. [tool] ${event.tool}(${argsPreview}): ${event.resultSummary}`;
        } else {
          return `${i + 1}. [output] ${event.content}`;
        }
      })
      .join("\n");

    const ageMinutes = Math.round((Date.now() - state.createdAt) / 60000);

    return `[Pairing Checkpoint #${state.checkpointNumber}] Delegation to ${recipientLabel}
Delegation ID: ${state.delegationId}

Activity since last checkpoint:
${eventLines || "(no activity captured)"}

Progress: ${state.totalEventsSeen} total events | ${state.checkpointNumber} checkpoints | Started ${ageMinutes}m ago`;
  }

  /**
   * Build the user instruction for what to do with the checkpoint.
   */
  private buildCheckpointInstruction(state: PairingState): string {
    const recipientLabel = state.recipientSlug
      ? `@${state.recipientSlug}`
      : "the delegated agent";

    return `Review ${recipientLabel}'s progress above. You can:
- Do nothing if they're on track (they won't see your response)
- Send guidance with delegate_followup(delegationEventId: "${state.delegationId}", message: "...")
- Stop checkpoints with stop_pairing(delegationEventId: "${state.delegationId}")`;
  }

  /**
   * Format tool arguments for display.
   */
  private formatArgs(args: Record<string, unknown>): string {
    const str = JSON.stringify(args);
    const maxLength = 50;
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength) + "...";
  }

  /**
   * Stop all active pairings (called on shutdown).
   */
  stopAll(): void {
    for (const delegationId of this.pairings.keys()) {
      this.stopPairing(delegationId);
    }
  }

  /**
   * Get status for debugging.
   */
  getStatus(): { activePairings: number; delegationIds: string[] } {
    return {
      activePairings: this.pairings.size,
      delegationIds: Array.from(this.pairings.keys()).map((id) => id.substring(0, 8)),
    };
  }
}
