import type { LLMService } from "@/llm/service";
import type { ConversationStore } from "@/conversations/ConversationStore";
import type { ConversationEntry } from "@/conversations/types";
import { trace, SpanStatusCode, type Span } from "@opentelemetry/api";
import { logger } from "@/utils/logger";
import { config } from "@/services/ConfigService";
import type {
  CompressionSegment,
} from "./compression-types.js";
import {
  CompressionSegmentsSchema,
  type CompressionSegmentInput,
} from "./compression-schema.js";
import {
  estimateTokensFromEntries,
  selectCandidateRangeFromEntries,
  validateSegmentsForEntries,
  applySegmentsToEntries,
  createFallbackSegmentForEntries,
} from "./compression-utils.js";

const tracer = trace.getTracer("tenex.compression");

/**
 * CompressionService - Orchestrates conversation history compression.
 *
 * Works at the ConversationEntry level (storage layer) before messages
 * are compiled for LLM consumption.
 *
 * LLM REQUIREMENTS:
 * - Compression requires an LLM provider with structured output (JSON mode) support
 * - If summarization fails (e.g., non-JSON-capable models like some Ollama models),
 *   the service gracefully falls back to sliding window truncation
 * - Check telemetry events (compression.summary_failed) to diagnose failures
 * - Recommended: Use OpenAI, Anthropic, or other providers with native JSON support
 */
export class CompressionService {
  constructor(
    private conversationStore: ConversationStore,
    private llmService: LLMService
  ) {}

  /**
   * Non-blocking proactive compression.
   * Called after each LLM response to compress old messages.
   */
  async maybeCompressAsync(conversationId: string): Promise<void> {
    this.performCompression(conversationId, false).catch((error) => {
      logger.warn("Proactive compression failed", {
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * Blocking reactive compression.
   * Called when messages must fit within token budget.
   * If tokenBudget is undefined, uses the configured default.
   */
  async ensureUnderLimit(
    conversationId: string,
    tokenBudget?: number
  ): Promise<void> {
    await this.performCompression(conversationId, true, tokenBudget);
  }

  /**
   * Get existing compression segments for a conversation.
   */
  async getSegments(conversationId: string): Promise<CompressionSegment[]> {
    return this.conversationStore.loadCompressionLog(conversationId);
  }

  /**
   * Apply existing compression segments to entries.
   * This is called by MessageBuilder to get compressed history.
   */
  applyExistingCompressions(
    entries: ConversationEntry[],
    segments: CompressionSegment[]
  ): ConversationEntry[] {
    return applySegmentsToEntries(entries, segments);
  }

  /**
   * Internal method to perform compression.
   */
  private async performCompression(
    conversationId: string,
    blocking: boolean,
    tokenBudget?: number
  ): Promise<void> {
    return tracer.startActiveSpan("compression.perform", async (span) => {
      try {
        span.setAttribute("conversation.id", conversationId.substring(0, 12));
        span.setAttribute("blocking", blocking);

        // Get all entries
        const entries = this.conversationStore.getAllMessages();
        const existingSegments =
          await this.conversationStore.loadCompressionLog(conversationId);

        span.setAttribute("entries.total", entries.length);
        span.setAttribute("segments.existing", existingSegments.length);

        // Get compression config
        const compressionConfig = this.getCompressionConfig();
        if (!compressionConfig.enabled) {
          span.setStatus({ code: SpanStatusCode.OK });
          return;
        }

        const effectiveBudget = tokenBudget ?? compressionConfig.tokenBudget;
        const currentTokens = estimateTokensFromEntries(entries);

        span.setAttribute("tokens.current", currentTokens);
        span.setAttribute("tokens.budget", effectiveBudget);

        // Check if compression is needed
        if (
          !blocking &&
          currentTokens < compressionConfig.tokenThreshold
        ) {
          // Proactive mode: only compress if over threshold
          span.setStatus({ code: SpanStatusCode.OK });
          return;
        }

        if (blocking && currentTokens <= effectiveBudget) {
          // Already under budget
          span.setStatus({ code: SpanStatusCode.OK });
          return;
        }

        // Find range to compress
        const range = selectCandidateRangeFromEntries(
          entries,
          existingSegments[existingSegments.length - 1] || null
        );

        if (!range) {
          if (blocking && currentTokens > effectiveBudget) {
            // Must compress but can't - use fallback
            await this.useFallback(
              conversationId,
              entries,
              compressionConfig.slidingWindowSize,
              span
            );
          }
          span.setStatus({ code: SpanStatusCode.OK });
          return;
        }

        // Attempt LLM compression
        try {
          const rangeEntries = entries.slice(range.startIndex, range.endIndex);
          const newSegments = await this.compressEntries(rangeEntries);

          // Emit telemetry for successful summary generation
          span.addEvent("compression.summary_generated", {
            "segments.count": newSegments.length,
            "model": this.llmService.model,
          });

          // Validate segments
          const validation = validateSegmentsForEntries(
            newSegments,
            entries,
            range
          );

          if (!validation.valid) {
            logger.warn("Compression segment validation failed", {
              conversationId,
              error: validation.error,
            });

            // Emit telemetry for validation failure
            span.addEvent("compression.summary_failed", {
              "reason": "validation_failed",
              "error": validation.error,
            });

            if (blocking) {
              await this.useFallback(
                conversationId,
                entries,
                compressionConfig.slidingWindowSize,
                span
              );
            }
            return;
          }

          // Persist segments
          await this.conversationStore.appendCompressionSegments(
            conversationId,
            newSegments
          );

          // Emit telemetry for reactive compression completion
          if (blocking) {
            span.addEvent("compression.reactive_applied", {
              "segments.added": newSegments.length,
              "tokens.before": currentTokens,
              "tokens.budget": effectiveBudget,
            });
          }

          span.setAttribute("segments.added", newSegments.length);
          span.setStatus({ code: SpanStatusCode.OK });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.warn("LLM compression failed", {
            conversationId,
            error: errorMessage,
            blocking,
          });

          // Emit telemetry for LLM failure
          span.addEvent("compression.summary_failed", {
            "reason": "llm_error",
            "error": errorMessage,
            "blocking": blocking,
          });

          if (blocking) {
            // Graceful degradation: use fallback truncation
            await this.useFallback(
              conversationId,
              entries,
              compressionConfig.slidingWindowSize,
              span
            );
          } else {
            // Proactive mode: fail silently, don't throw
            // This prevents compression failures from breaking the main flow
            logger.warn("Proactive compression skipped due to LLM error", {
              conversationId,
            });
          }
        }
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  /**
   * Compress a range of entries using LLM.
   */
  private async compressEntries(
    entries: ConversationEntry[]
  ): Promise<CompressionSegment[]> {
    return tracer.startActiveSpan(
      "compression.llm_compress",
      async (span) => {
        try {
          span.setAttribute("entries.count", entries.length);

          // Format entries for LLM, including tool payloads
          const formattedEntries = entries
            .map((e) => {
              let formatted = `[${e.messageType}]`;

              // Add text content if present
              if (e.content) {
                formatted += ` ${e.content}`;
              }

              // Add tool payload summary for tool-call/tool-result entries
              if (e.toolData && e.toolData.length > 0) {
                const toolSummary = e.toolData
                  .map((tool) => {
                    if ('toolName' in tool) {
                      // ToolCallPart
                      return `Tool: ${tool.toolName}`;
                    } else if ('toolCallId' in tool) {
                      // ToolResultPart - cast to any to avoid type narrowing issues
                      const toolResult = tool as any;
                      const resultPreview = typeof toolResult.result === 'string'
                        ? toolResult.result.substring(0, 100)
                        : JSON.stringify(toolResult.result).substring(0, 100);
                      return `Result: ${resultPreview}${resultPreview.length >= 100 ? '...' : ''}`;
                    }
                    return '';
                  })
                  .filter(Boolean)
                  .join(', ');

                if (toolSummary) {
                  formatted += ` [${toolSummary}]`;
                }
              }

              return formatted;
            })
            .join("\n\n");

          const eventIds = entries
            .filter((e) => e.eventId)
            .map((e) => e.eventId!);

          if (eventIds.length === 0) {
            throw new Error("No eventIds found in entries to compress");
          }

          // Call LLM to compress
          const result = await this.llmService.generateObject(
            [
              {
                role: "user",
                content: `You are compressing conversation history. Analyze the following messages and create 1-3 compressed segments that preserve key information while being concise.

For each segment, provide:
- fromEventId: starting message event ID
- toEventId: ending message event ID
- compressed: a concise summary (2-4 sentences) of the key points

Messages to compress:
${formattedEntries}

Event IDs in order: ${eventIds.join(", ")}

Create segments that group related topics together. Preserve important decisions, errors, and outcomes.`,
              },
            ],
            CompressionSegmentsSchema
          );

          // Convert LLM output to CompressionSegment format
          const segments: CompressionSegment[] = result.object.map(
            (seg: CompressionSegmentInput) => ({
              fromEventId: seg.fromEventId,
              toEventId: seg.toEventId,
              compressed: seg.compressed,
              createdAt: Date.now(),
              model: this.llmService.model,
            })
          );

          span.setAttribute("segments.count", segments.length);
          span.setStatus({ code: SpanStatusCode.OK });

          return segments;
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      }
    );
  }

  /**
   * Emergency fallback: create a compression segment representing truncation.
   * Uses sliding window strategy when LLM compression fails.
   */
  private async useFallback(
    conversationId: string,
    entries: ConversationEntry[],
    windowSize: number,
    span: Span
  ): Promise<void> {
    span.setAttribute("fallback.used", true);
    span.setAttribute("fallback.window_size", windowSize);

    logger.warn("Compression fallback triggered - using sliding window truncation", {
      conversationId,
      entriesCount: entries.length,
      windowSize,
    });

    // Delegate to pure utility function
    const fallbackSegment = createFallbackSegmentForEntries(entries, windowSize);

    if (!fallbackSegment) {
      // Can't create a valid segment (too few entries or insufficient event IDs)
      logger.warn("Cannot create fallback segment - insufficient data", {
        conversationId,
        entriesCount: entries.length,
        windowSize,
      });
      span.setStatus({ code: SpanStatusCode.OK });
      return;
    }

    // Persist the fallback segment
    await this.conversationStore.appendCompressionSegments(
      conversationId,
      [fallbackSegment]
    );

    span.setAttribute("fallback.segment_created", true);
    span.setStatus({ code: SpanStatusCode.OK });
  }

  /**
   * Get compression configuration from config service.
   * Public to allow external callers (e.g., MessageCompiler) to check config.
   */
  getCompressionConfig(): {
    enabled: boolean;
    tokenThreshold: number;
    tokenBudget: number;
    slidingWindowSize: number;
  } {
    const cfg = config.getConfig();
    return {
      enabled: cfg.compression?.enabled ?? true,
      tokenThreshold: cfg.compression?.tokenThreshold ?? 50000,
      tokenBudget: cfg.compression?.tokenBudget ?? 40000,
      slidingWindowSize: cfg.compression?.slidingWindowSize ?? 50,
    };
  }
}

/**
 * Factory method to create CompressionService.
 */
export function createCompressionService(
  conversationStore: ConversationStore,
  llmService: LLMService
): CompressionService {
  return new CompressionService(conversationStore, llmService);
}
