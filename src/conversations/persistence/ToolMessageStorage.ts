import { promises as fs } from "node:fs";
import { config } from "@/services/ConfigService";
import * as path from "node:path";
import { formatAnyError } from "@/lib/error-formatter";
import { logger } from "@/utils/logger";
import { isShortEventId } from "@/types/event-ids";
import type { ModelMessage } from "ai";

/**
 * Storage interface for tool messages
 * Single Responsibility: Persist and retrieve tool execution messages
 */
export class ToolMessageStorage {
    private readonly storageDir = config.getConfigPath("tool-messages");

    /**
     * Store tool messages for later reconstruction
     */
    async store(
        eventId: string,
        toolCall: {
            toolCallId: string;
            toolName: string;
            input: unknown;
        },
        toolResult: {
            toolCallId: string;
            toolName: string;
            output: unknown;
            error?: boolean;
        },
        agentPubkey: string
    ): Promise<void> {
        try {
            // Ensure input is always an object (AI SDK schema requires it, and JSON.stringify strips undefined)
            const safeInput = toolCall.input !== undefined ? toolCall.input : {};

            // Ensure output is always defined
            const safeOutput = toolResult.output !== undefined
                ? {
                    type: "text" as const,
                    value: typeof toolResult.output === "string"
                        ? toolResult.output
                        : JSON.stringify(toolResult.output),
                }
                : { type: "text" as const, value: "" };

            const messages: ModelMessage[] = [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "tool-call" as const,
                            toolCallId: toolCall.toolCallId,
                            toolName: toolCall.toolName,
                            input: safeInput,
                        },
                    ],
                },
                {
                    role: "tool",
                    content: [
                        {
                            type: "tool-result" as const,
                            toolCallId: toolResult.toolCallId,
                            toolName: toolResult.toolName,
                            output: safeOutput,
                        },
                    ],
                },
            ];

            await fs.mkdir(this.storageDir, { recursive: true });

            const filePath = path.join(this.storageDir, `${eventId}.json`);
            const data = {
                eventId,
                agentPubkey,
                timestamp: Date.now(),
                messages,
            };

            await fs.writeFile(filePath, JSON.stringify(data, null, 2));

            logger.debug("[ToolMessageStorage] Stored tool messages", {
                eventId: eventId.substring(0, 8),
                filePath,
            });
        } catch (error) {
            logger.error("[ToolMessageStorage] Failed to store tool messages", {
                error: formatAnyError(error),
                eventId,
            });
        }
    }

    /**
     * Load tool messages from storage by event ID (full or short prefix).
     */
    async load(eventId: string): Promise<ModelMessage[] | null> {
        try {
            let resolvedId = eventId;

            if (isShortEventId(eventId)) {
                const files = await fs.readdir(this.storageDir).catch(() => [] as string[]);
                const match = files.find((f) => f.endsWith(".json") && f.startsWith(eventId));
                if (!match) return null;
                resolvedId = match.slice(0, -5); // strip .json
            }

            const filePath = path.join(this.storageDir, `${resolvedId}.json`);
            const data = await fs.readFile(filePath, "utf-8");
            const parsed = JSON.parse(data);
            return parsed.messages as ModelMessage[];
        } catch {
            return null;
        }
    }

    /**
     * Clean up old tool messages
     */
    async cleanup(olderThanMs: number = 24 * 60 * 60 * 1000): Promise<void> {
        try {
            const files = await fs.readdir(this.storageDir);
            const now = Date.now();

            for (const file of files) {
                if (!file.endsWith(".json")) continue;

                const filePath = path.join(this.storageDir, file);
                const stats = await fs.stat(filePath);

                if (now - stats.mtimeMs > olderThanMs) {
                    await fs.unlink(filePath);
                    logger.debug("[ToolMessageStorage] Cleaned up old tool message file", {
                        file,
                        ageMs: now - stats.mtimeMs,
                    });
                }
            }
        } catch (error) {
            logger.error("[ToolMessageStorage] Failed to cleanup", {
                error: formatAnyError(error),
            });
        }
    }
}

// Singleton instance
export const toolMessageStorage = new ToolMessageStorage();
