import { promises as fs } from "node:fs";
import { config } from "@/services/ConfigService";
import * as path from "node:path";
import { formatAnyError } from "@/lib/error-formatter";
import { logger } from "@/utils/logger";
import type { ModelMessage } from "ai";

/**
 * Storage interface for tool messages
 * Single Responsibility: Persist and retrieve tool execution messages
 */
export class ToolMessageStorage {
    constructor(
        private readonly storageDir = config.getConfigPath("tool-messages")
    ) {}

    private encodePathSegment(value: string): string {
        return encodeURIComponent(value);
    }

    private getConversationDir(conversationId: string): string {
        return path.join(
            this.storageDir,
            this.encodePathSegment(conversationId)
        );
    }

    private getMessagePath(conversationId: string, toolCallId: string): string {
        return path.join(
            this.getConversationDir(conversationId),
            `${this.encodePathSegment(toolCallId)}.json`
        );
    }

    /**
     * Store tool messages for later reconstruction
     */
    async store(
        conversationId: string,
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

            const conversationDir = this.getConversationDir(conversationId);
            await fs.mkdir(conversationDir, { recursive: true });

            const filePath = this.getMessagePath(
                conversationId,
                toolCall.toolCallId
            );
            const data = {
                conversationId,
                toolCallId: toolCall.toolCallId,
                agentPubkey,
                timestamp: Date.now(),
                messages,
            };

            await fs.writeFile(filePath, JSON.stringify(data, null, 2));

            logger.debug("[ToolMessageStorage] Stored tool messages", {
                conversationId,
                toolCallId: toolCall.toolCallId,
                filePath,
            });
        } catch (error) {
            logger.error("[ToolMessageStorage] Failed to store tool messages", {
                error: formatAnyError(error),
                conversationId,
                toolCallId: toolCall.toolCallId,
            });
        }
    }

    /**
     * Load tool messages from storage by conversation ID and tool call ID.
     */
    async load(
        conversationId: string,
        toolCallId: string
    ): Promise<ModelMessage[] | null> {
        try {
            const filePath = this.getMessagePath(conversationId, toolCallId);
            const data = await fs.readFile(filePath, "utf-8");
            const parsed = JSON.parse(data);
            return parsed.messages as ModelMessage[];
        } catch {
            return null;
        }
    }

    private async cleanupDirectory(
        dirPath: string,
        olderThanMs: number,
        now: number
    ): Promise<void> {
        const entries = await fs.readdir(dirPath, {
            withFileTypes: true,
        });

        for (const entry of entries) {
            const entryPath = path.join(dirPath, entry.name);

            if (entry.isDirectory()) {
                await this.cleanupDirectory(entryPath, olderThanMs, now);

                const remainingEntries = await fs.readdir(entryPath);
                if (remainingEntries.length === 0) {
                    await fs.rmdir(entryPath);
                }
                continue;
            }

            if (!entry.name.endsWith(".json")) {
                continue;
            }

            const stats = await fs.stat(entryPath);
            if (now - stats.mtimeMs > olderThanMs) {
                await fs.unlink(entryPath);
                logger.debug(
                    "[ToolMessageStorage] Cleaned up old tool message file",
                    {
                        filePath: entryPath,
                        ageMs: now - stats.mtimeMs,
                    }
                );
            }
        }
    }

    /**
     * Clean up old tool messages
     */
    async cleanup(olderThanMs: number = 24 * 60 * 60 * 1000): Promise<void> {
        try {
            const now = Date.now();
            await this.cleanupDirectory(this.storageDir, olderThanMs, now);
        } catch (error) {
            logger.error("[ToolMessageStorage] Failed to cleanup", {
                error: formatAnyError(error),
            });
        }
    }
}

// Singleton instance
export const toolMessageStorage = new ToolMessageStorage();
