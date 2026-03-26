import { z } from "zod";
import { tool } from "ai";
import type { ToolExecutionContext, AISdkTool } from "@/tools/types";
import {
    getTransportBindingStore,
    type TransportBindingStore,
} from "@/services/ingress/TransportBindingStoreService";
import { getProjectContext } from "@/services/projects";
import {
    getTelegramThreadTargetValidationError,
    parseTelegramChannelId,
} from "@/utils/telegram-identifiers";
import { TelegramDeliveryService } from "@/services/telegram/TelegramDeliveryService";

// Shared instance preserves the TelegramBotClient cache across tool executions.
const deliveryService = new TelegramDeliveryService();

const sendMessageSchema = z.object({
    channelId: z.string().describe("The channel ID to send to (from your channel bindings)"),
    content: z.string().describe("The message content (markdown supported)"),
});

type SendMessageInput = z.infer<typeof sendMessageSchema>;

export function createSendMessageTool(
    context: ToolExecutionContext,
    options: {
        channelBindingStore?: Pick<TransportBindingStore, "getBinding">;
    } = {}
): AISdkTool {
    const channelBindingStore = options.channelBindingStore ?? getTransportBindingStore();
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

            const threadTargetError = getTelegramThreadTargetValidationError(
                parsed.chatId,
                parsed.messageThreadId
            );
            if (threadTargetError) {
                return { error: `${threadTargetError} Channel: ${input.channelId}` };
            }

            const projectId = getProjectContext().project.dTag
                ?? getProjectContext().project.tagValue("d");
            if (!projectId) {
                return { error: "Project context is missing a project ID for transport binding lookup" };
            }

            const binding = channelBindingStore.getBinding(
                context.agent.pubkey,
                input.channelId,
                "telegram"
            );
            if (!binding || binding.projectId !== projectId) {
                return { error: `Channel ${input.channelId} is not in your remembered transport bindings` };
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
