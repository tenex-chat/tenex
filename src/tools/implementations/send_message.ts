import { z } from "zod";
import { tool } from "ai";
import type { ToolExecutionContext, AISdkTool } from "@/tools/types";
import { parseTelegramChannelId } from "@/utils/telegram-identifiers";
import { matchesTelegramChatBinding } from "@/services/telegram/telegram-gateway-utils";
import { TelegramDeliveryService } from "@/services/telegram/TelegramDeliveryService";

const deliveryService = new TelegramDeliveryService();

const sendMessageSchema = z.object({
    channelId: z.string().describe("The channel ID to send to (from your channel bindings)"),
    content: z.string().describe("The message content (markdown supported)"),
});

type SendMessageInput = z.infer<typeof sendMessageSchema>;

export function createSendMessageTool(context: ToolExecutionContext): AISdkTool {
    const aiTool = tool({
        description:
            "Send a proactive message to one of your bound channels. " +
            "Use the channel IDs from your channel bindings in the system prompt.",
        inputSchema: sendMessageSchema,
        execute: async (input: SendMessageInput) => {
            const telegramConfig = context.agent.telegram;
            if (!telegramConfig?.botToken) {
                return { error: "No Telegram bot token configured for this agent" };
            }

            const parsed = parseTelegramChannelId(input.channelId);
            if (!parsed) {
                return { error: `Invalid channel ID format: ${input.channelId}` };
            }

            if (!matchesTelegramChatBinding(telegramConfig.chatBindings, parsed.chatId, parsed.messageThreadId)) {
                return { error: `Channel ${input.channelId} is not in your configured chat bindings` };
            }

            await deliveryService.sendToChannel({
                botToken: telegramConfig.botToken,
                apiBaseUrl: telegramConfig.apiBaseUrl,
                chatId: parsed.chatId,
                messageThreadId: parsed.messageThreadId,
                content: input.content,
            });

            return { success: true, channelId: input.channelId };
        },
    });

    return aiTool as AISdkTool;
}
