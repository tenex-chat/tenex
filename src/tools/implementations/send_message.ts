import { z } from "zod";
import { tool } from "ai";
import type { AISdkTool, ToolExecutionContext } from "@/tools/types";

const sendMessageSchema = z.object({
    channelId: z.string().describe("The channel ID to send to (from your channel bindings)"),
    content: z.string().describe("The message content (markdown supported)"),
});

type SendMessageInput = z.infer<typeof sendMessageSchema>;

export function createSendMessageTool(
    context: ToolExecutionContext
): AISdkTool {
    const aiTool = tool({
        description:
            "Send a proactive message to one of your bound channels. " +
            "Use the channel IDs from your channel bindings in the system prompt.",
        inputSchema: sendMessageSchema,
        execute: async (input: SendMessageInput) => {
            if (!input.channelId) {
                return { error: "channelId is required" };
            }
            if (!input.content) {
                return { error: "content is required" };
            }

            try {
                const result = await context.agentPublisher.sendMessage(
                    {
                        channelId: input.channelId,
                        content: input.content,
                    },
                    {
                        conversationId: context.conversationId,
                        rootEvent: {
                            id: context.triggeringEnvelope.message.nativeId,
                        },
                        triggeringEnvelope: context.triggeringEnvelope,
                        ralNumber: context.ralNumber,
                    }
                );
                return {
                    success: true,
                    channelId: input.channelId,
                    eventId: result.id,
                };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return { error: `Message send failed: ${message}` };
            }
        },
    });

    return aiTool as AISdkTool;
}
