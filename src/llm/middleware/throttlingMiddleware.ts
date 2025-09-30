import type {
  Experimental_LanguageModelV1Middleware,
  LanguageModelV1StreamPart,
} from "ai";
import { logger } from "@/utils/logger";
import * as fs from "fs/promises";
import * as path from "path";

/**
 * Throttling middleware that buffers content chunks and flushes them
 * at regular intervals after the first chunk arrives.
 *
 * This is different from debouncing (smoothStream) - we flush X ms after the FIRST chunk,
 * not X ms after each chunk. This ensures consistent streaming cadence.
 *
 * This middleware is designed to work with the AI SDK's streamText function
 * and buffers text-delta chunks to reduce the frequency of Nostr events
 * (kind:21111) while maintaining smooth streaming.
 *
 * Includes line-based chunking to ensure clean breaks at line boundaries.
 */
export function throttlingMiddleware(
  options: {
    flushInterval?: number;
    chunking?: 'line' | 'none';
  } = {},
): Experimental_LanguageModelV1Middleware {
  const flushInterval = options.flushInterval ?? 500; // Default 500ms
  const chunking = options.chunking ?? 'line'; // Default to line-based chunking

  return {
    middlewareVersion: "v2" as const,
    wrapStream: async ({ doStream }) => {
      const startTime = Date.now();
      const sessionId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).substring(7)}`;
      const logDir = path.join(process.cwd(), '.tenex', 'debug', 'stream-chunks');
      const logFile = path.join(logDir, `stream-${sessionId}.jsonl`);

      // Ensure debug directory exists
      await fs.mkdir(logDir, { recursive: true });

      logger.info("[ThrottlingMiddleware] Starting stream wrapper", {
        flushInterval,
        timestamp: new Date().toISOString(),
        debugLogFile: logFile,
      });

      // Get the original stream result
      const result = await doStream();

      // Buffers for text and reasoning content
      let textBuffer = "";
      let textId = "";
      let reasoningBuffer = "";
      let reasoningId = "";
      let flushTimer: NodeJS.Timeout | null = null;
      let lastFlushTime = 0;
      let totalFlushes = 0;
      let totalChunks = 0;

      // Create a TransformStream that wraps our throttling logic
      const transformStream = new TransformStream<LanguageModelV1StreamPart, LanguageModelV1StreamPart>({
        async transform(chunk, controller) {
          const chunkTimestamp = Date.now();
          totalChunks++;

          // Write raw chunk to debug file
          const rawChunkLog = {
            timestamp: new Date().toISOString(),
            elapsedMs: chunkTimestamp - startTime,
            chunkNumber: totalChunks,
            chunkType: chunk.type,
            rawPayload: chunk,
          };

          await fs.appendFile(
            logFile,
            JSON.stringify(rawChunkLog) + '\n',
            'utf8'
          );

          logger.debug("[ThrottlingMiddleware] Received chunk", {
            timestamp: new Date().toISOString(),
            elapsedSinceStart: chunkTimestamp - startTime,
            chunkType: chunk.type,
            chunkNumber: totalChunks,
          });

          // Helper to detect complete lines in buffer
          const extractCompleteLines = (buffer: string): { complete: string; remaining: string } => {
            if (chunking === 'none') {
              // No chunking - flush entire buffer
              return { complete: buffer, remaining: "" };
            }

            // Line-based chunking - find last newline
            const lastNewline = buffer.lastIndexOf('\n');
            if (lastNewline === -1) {
              // No complete lines yet, keep buffering
              return { complete: "", remaining: buffer };
            }

            // Include the newline in the complete part
            return {
              complete: buffer.slice(0, lastNewline + 1),
              remaining: buffer.slice(lastNewline + 1)
            };
          };

          // Helper to flush buffers
          const flush = (forceFlushAll: boolean = false) => {
            const flushTime = Date.now();
            totalFlushes++;

            // For text buffer
            if (textBuffer.length > 0) {
              let toFlush = "";

              if (forceFlushAll) {
                // Force flush everything (e.g., at stream end)
                toFlush = textBuffer;
                textBuffer = "";
              } else {
                // Extract only complete lines (or everything if chunking is 'none')
                const { complete, remaining } = extractCompleteLines(textBuffer);
                toFlush = complete;
                textBuffer = remaining;
              }

              if (toFlush.length > 0) {
                logger.info("[ThrottlingMiddleware] Flushing text buffer", {
                  timestamp: new Date().toISOString(),
                  elapsedSinceStart: flushTime - startTime,
                  bufferLength: toFlush.length,
                  content: toFlush,
                  remainingBuffer: textBuffer.length,
                  id: textId,
                  flushNumber: totalFlushes,
                  forceFlushAll,
                });
                controller.enqueue({
                  type: "text-delta",
                  delta: toFlush,
                  id: textId,
                } as LanguageModelV1StreamPart);
              }
            }

            // For reasoning buffer
            if (reasoningBuffer.length > 0) {
              let toFlush = "";

              if (forceFlushAll) {
                // Force flush everything
                toFlush = reasoningBuffer;
                reasoningBuffer = "";
              } else {
                // Extract only complete lines (or everything if chunking is 'none')
                const { complete, remaining } = extractCompleteLines(reasoningBuffer);
                toFlush = complete;
                reasoningBuffer = remaining;
              }

              if (toFlush.length > 0) {
                logger.info("[ThrottlingMiddleware] Flushing reasoning buffer", {
                  timestamp: new Date().toISOString(),
                  elapsedSinceStart: flushTime - startTime,
                  bufferLength: toFlush.length,
                  content: toFlush,
                  remainingBuffer: reasoningBuffer.length,
                  id: reasoningId,
                  flushNumber: totalFlushes,
                  forceFlushAll,
                });
                controller.enqueue({
                  type: "reasoning-delta",
                  delta: toFlush,
                  id: reasoningId,
                } as LanguageModelV1StreamPart);
              }
            }

            lastFlushTime = flushTime;
            if (flushTimer) {
              clearTimeout(flushTimer);
              flushTimer = null;
            }
          };

          // Handle different chunk types
          if (chunk.type === "text-delta") {
            // Extract delta content (handle both v1 text and v2 delta properties)
            const deltaContent = (chunk as any).delta || (chunk as any).text;
            const chunkId = (chunk as any).id || textId || "text-default";

            if (deltaContent) {
              // If ID changes, force flush current buffer
              if (textId && chunkId !== textId) {
                flush(true);
              }

              textBuffer += deltaContent;
              textId = chunkId;

              logger.debug("[ThrottlingMiddleware] Buffering text-delta", {
                timestamp: new Date().toISOString(),
                elapsedSinceStart: chunkTimestamp - startTime,
                deltaContent,
                deltaLength: deltaContent.length,
                newBufferLength: textBuffer.length,
                id: textId,
              });

              // Check if we should flush immediately due to newline
              if (chunking === 'line' && textBuffer.includes('\n')) {
                logger.info("[ThrottlingMiddleware] Found newline, flushing immediately", {
                  timestamp: new Date().toISOString(),
                  elapsedSinceStart: chunkTimestamp - startTime,
                });
                flush();
              } else if (!flushTimer) {
                // Start flush timer if not already running
                logger.info("[ThrottlingMiddleware] Starting flush timer", {
                  timestamp: new Date().toISOString(),
                  elapsedSinceStart: chunkTimestamp - startTime,
                  flushInterval,
                });
                flushTimer = setTimeout(() => {
                  flush();
                  // Schedule next flush if we still have content coming
                  if (textBuffer.length > 0 || reasoningBuffer.length > 0) {
                    flushTimer = setTimeout(() => flush(), flushInterval);
                  } else {
                    flushTimer = null;
                  }
                }, flushInterval);
              }
            }
          } else if (chunk.type === "reasoning-delta") {
            // Extract delta content (handle both v1 text and v2 delta properties)
            const deltaContent = (chunk as any).delta || (chunk as any).text;
            const chunkId = (chunk as any).id || reasoningId || "reasoning-default";

            if (deltaContent) {
              // If ID changes, force flush current buffer
              if (reasoningId && chunkId !== reasoningId) {
                flush(true);
              }

              reasoningBuffer += deltaContent;
              reasoningId = chunkId;

              logger.debug("[ThrottlingMiddleware] Buffering reasoning-delta", {
                timestamp: new Date().toISOString(),
                elapsedSinceStart: chunkTimestamp - startTime,
                deltaContent,
                deltaLength: deltaContent.length,
                newBufferLength: reasoningBuffer.length,
                id: reasoningId,
              });

              // Check if we should flush immediately due to newline
              if (chunking === 'line' && reasoningBuffer.includes('\n')) {
                logger.info("[ThrottlingMiddleware] Found newline in reasoning, flushing immediately", {
                  timestamp: new Date().toISOString(),
                  elapsedSinceStart: chunkTimestamp - startTime,
                });
                flush();
              } else if (!flushTimer) {
                // Start flush timer if not already running
                logger.info("[ThrottlingMiddleware] Starting flush timer for reasoning", {
                  timestamp: new Date().toISOString(),
                  elapsedSinceStart: chunkTimestamp - startTime,
                  flushInterval,
                });
                flushTimer = setTimeout(() => {
                  flush();
                  // Schedule next flush if we still have content coming
                  if (textBuffer.length > 0 || reasoningBuffer.length > 0) {
                    flushTimer = setTimeout(() => flush(), flushInterval);
                  } else {
                    flushTimer = null;
                  }
                }, flushInterval);
              }
            }
          } else {
            // For non-text/reasoning chunks, force flush any buffered content first
            if (textBuffer.length > 0 || reasoningBuffer.length > 0) {
              logger.info("[ThrottlingMiddleware] Non-text chunk received, force flushing buffers", {
                timestamp: new Date().toISOString(),
                elapsedSinceStart: chunkTimestamp - startTime,
                chunkType: chunk.type,
                hasTextBuffer: textBuffer.length > 0,
                hasReasoningBuffer: reasoningBuffer.length > 0,
              });
              flush(true);
            }

            // Pass through the non-text chunk
            controller.enqueue(chunk);
          }
        },

        async flush(controller) {
          const finalTime = Date.now();

          // Force flush any remaining buffered content (including partial lines)
          if (textBuffer.length > 0 || reasoningBuffer.length > 0) {
            logger.info("[ThrottlingMiddleware] Final flush of remaining buffers", {
              timestamp: new Date().toISOString(),
              elapsedSinceStart: finalTime - startTime,
              hasTextBuffer: textBuffer.length > 0,
              hasReasoningBuffer: reasoningBuffer.length > 0,
            });

            // Force flush everything at stream end
            if (textBuffer.length > 0) {
              controller.enqueue({
                type: "text-delta",
                delta: textBuffer,
                id: textId,
              } as LanguageModelV1StreamPart);
              textBuffer = "";
            }

            if (reasoningBuffer.length > 0) {
              controller.enqueue({
                type: "reasoning-delta",
                delta: reasoningBuffer,
                id: reasoningId,
              } as LanguageModelV1StreamPart);
              reasoningBuffer = "";
            }
          }

          // Clear timer if still running
          if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = null;
          }

          logger.info("[ThrottlingMiddleware] Stream completed", {
            timestamp: new Date().toISOString(),
            totalDuration: finalTime - startTime,
            totalChunks,
            totalFlushes,
          });

          // Write summary to debug file
          await fs.appendFile(
            logFile,
            '\n' + JSON.stringify({
              type: 'STREAM_SUMMARY',
              timestamp: new Date().toISOString(),
              totalDuration: finalTime - startTime,
              totalChunks,
              totalFlushes,
              logFile,
            }) + '\n',
            'utf8'
          );
        }
      });

      // Pipe the original stream through our transform
      const pipelineStream = result.stream.pipeThrough(transformStream);

      // Return the same structure as doStream, but with our wrapped stream
      return {
        stream: pipelineStream,
        request: result.request,
        response: result.response,
      };
    },
  };
}