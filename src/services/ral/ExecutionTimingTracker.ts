import { trace } from "@opentelemetry/api";
import { logger } from "@/utils/logger";
import type { RALRegistryEntry } from "./types";

/**
 * ExecutionTimingTracker - Tracks LLM stream timing for a single RAL entry.
 *
 * This is intentionally stateless. Callers pass the live RAL entry in so the
 * tracker can update timing fields without owning any registry storage.
 */
export class ExecutionTimingTracker {
  /**
   * Mark the start of an LLM streaming session.
   * Call this immediately before llmService.stream() to begin timing.
   *
   * @param lastUserMessage - The last user message that triggered this LLM call (for debugging)
   */
  startLLMStream(
    ral: RALRegistryEntry | undefined,
    _agentPubkey: string,
    _conversationId: string,
    ralNumber: number,
    lastUserMessage?: string
  ): void {
    if (ral) {
      const now = Date.now();
      ral.llmStreamStartTime = now;
      ral.lastRuntimeCheckpointAt = now; // Initialize checkpoint to stream start
      ral.lastActivityAt = now;

      // Include the last user message in telemetry for debugging
      // Truncate to 1000 chars to avoid bloating traces
      const truncatedMessage = lastUserMessage
        ? (lastUserMessage.length > 1000 ? `${lastUserMessage.substring(0, 1000)}...` : lastUserMessage)
        : undefined;

      trace.getActiveSpan()?.addEvent("ral.llm_stream_started", {
        "ral.number": ralNumber,
        "ral.accumulated_runtime_ms": ral.accumulatedRuntime,
        ...(truncatedMessage && { "ral.last_user_message": truncatedMessage }),
      });
    }
  }

  /**
   * Mark the end of an LLM streaming session and accumulate the runtime.
   * Call this in the finally block after llmService.stream() completes.
   * @returns The total accumulated runtime in milliseconds
   */
  endLLMStream(
    ral: RALRegistryEntry | undefined,
    _agentPubkey: string,
    _conversationId: string,
    ralNumber: number
  ): number {
    if (ral && ral.llmStreamStartTime !== undefined) {
      const now = Date.now();
      // Calculate TOTAL stream duration from original start (not from checkpoint)
      const streamDuration = now - ral.llmStreamStartTime;
      // Add only the time since last checkpoint (to avoid double-counting what was already consumed)
      const checkpointTime = ral.lastRuntimeCheckpointAt ?? ral.llmStreamStartTime;
      // Guard against clock rollback - keep runtime monotonic
      const unreportedDuration = Math.max(0, now - checkpointTime);
      ral.accumulatedRuntime += unreportedDuration;
      // Clear both stream timing fields
      ral.llmStreamStartTime = undefined;
      ral.lastRuntimeCheckpointAt = undefined;
      ral.lastActivityAt = now;

      trace.getActiveSpan()?.addEvent("ral.llm_stream_ended", {
        "ral.number": ralNumber,
        "ral.stream_duration_ms": streamDuration,
        "ral.accumulated_runtime_ms": ral.accumulatedRuntime,
      });

      return ral.accumulatedRuntime;
    }
    return ral?.accumulatedRuntime ?? 0;
  }

  /**
   * Get the accumulated LLM runtime for a RAL.
   */
  getAccumulatedRuntime(ral: RALRegistryEntry | undefined): number {
    return ral?.accumulatedRuntime ?? 0;
  }

  /**
   * Get the unreported runtime (runtime accumulated since last publish) and mark it as reported.
   * Returns the unreported runtime in milliseconds, then resets the counter.
   * This is used for incremental runtime reporting in agent events.
   *
   * IMPORTANT: This method handles mid-stream runtime calculation. When called during an active
   * LLM stream, it calculates the "live" runtime since the last checkpoint (or stream start),
   * accumulates it, and updates the checkpoint timestamp. The original llmStreamStartTime is
   * preserved so that endLLMStream() can still report correct total stream duration.
   */
  consumeUnreportedRuntime(
    ral: RALRegistryEntry | undefined,
    agentPubkey: string,
    conversationId: string,
    ralNumber: number
  ): number {
    if (!ral) {
      // DEBUG: RAL not found
      logger.warn("[RALRegistry.consumeUnreportedRuntime] RAL not found", {
        agentPubkey: agentPubkey.substring(0, 8),
        conversationId: conversationId.substring(0, 8),
        ralNumber,
      });
      return 0;
    }

    const now = Date.now();

    // DEBUG: Log state before calculating
    logger.info("[RALRegistry.consumeUnreportedRuntime] RAL state", {
      agentPubkey: agentPubkey.substring(0, 8),
      ralNumber,
      llmStreamStartTime: ral.llmStreamStartTime,
      lastRuntimeCheckpointAt: ral.lastRuntimeCheckpointAt,
      accumulatedRuntime: ral.accumulatedRuntime,
      lastReportedRuntime: ral.lastReportedRuntime,
    });

    // If there's an active LLM stream, capture the runtime since last checkpoint
    // Use checkpoint if available, otherwise fall back to stream start
    if (ral.llmStreamStartTime !== undefined) {
      const checkpointTime = ral.lastRuntimeCheckpointAt ?? ral.llmStreamStartTime;
      const liveStreamRuntime = now - checkpointTime;
      ral.accumulatedRuntime += liveStreamRuntime;
      // Update checkpoint only - preserve llmStreamStartTime for endLLMStream()
      ral.lastRuntimeCheckpointAt = now;
    }

    const unreported = ral.accumulatedRuntime - ral.lastReportedRuntime;

    // Guard against NaN or negative deltas (defensive programming)
    // Repair lastReportedRuntime to prevent permanent suppression of future runtime
    if (!Number.isFinite(unreported) || unreported < 0) {
      logger.warn("[RALRegistry] Invalid runtime delta", {
        unreported,
        accumulated: ral.accumulatedRuntime,
        lastReported: ral.lastReportedRuntime,
      });
      ral.lastReportedRuntime = ral.accumulatedRuntime;
      return 0;
    }

    ral.lastReportedRuntime = ral.accumulatedRuntime;

    if (unreported > 0) {
      trace.getActiveSpan()?.addEvent("ral.runtime_consumed", {
        "ral.number": ralNumber,
        "ral.unreported_runtime_ms": unreported,
        "ral.accumulated_runtime_ms": ral.accumulatedRuntime,
      });
    }

    return unreported;
  }

  /**
   * Get the unreported runtime without consuming it.
   * Use consumeUnreportedRuntime() when publishing events.
   *
   * NOTE: This also calculates "live" runtime during active streams for accurate preview.
   */
  getUnreportedRuntime(ral: RALRegistryEntry | undefined): number {
    if (!ral) return 0;

    // Calculate current accumulated + live stream time since checkpoint for accurate preview
    let effectiveAccumulated = ral.accumulatedRuntime;
    if (ral.llmStreamStartTime !== undefined) {
      const checkpointTime = ral.lastRuntimeCheckpointAt ?? ral.llmStreamStartTime;
      effectiveAccumulated += Date.now() - checkpointTime;
    }

    return effectiveAccumulated - ral.lastReportedRuntime;
  }
}
