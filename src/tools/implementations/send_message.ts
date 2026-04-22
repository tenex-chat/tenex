import { z } from "zod";
import { tool } from "ai";
import {
    getActiveTelegramSendBridge,
    type TelegramSendBridge,
} from "@/agents/execution/worker/telegram-send-bridge";
import type { AISdkTool, ToolExecutionContext } from "@/tools/types";

const sendMessageSchema = z.object({
    channelId: z.string().describe("The channel ID to send to (from your channel bindings)"),
    content: z.string().describe("The message content (markdown supported)"),
});

type SendMessageInput = z.infer<typeof sendMessageSchema>;

export function createSendMessageTool(
    context: ToolExecutionContext,
    options: {
        bridge?: TelegramSendBridge;
    } = {}
): AISdkTool {
    const aiTool = tool({
        description:
            "Send a proactive message to one of your bound channels. " +
            "Use the channel IDs from your channel bindings in the system prompt.",
        inputSchema: sendMessageSchema,
        execute: async (input: SendMessageInput) => {
            const bridge = options.bridge ?? getActiveTelegramSendBridge();
            if (!bridge) {
                return {
                    error: "Telegram send bridge is not available in this execution context",
                };
            }

            if (!input.channelId) {
                return { error: "channelId is required" };
            }
            if (!input.content) {
                return { error: "content is required" };
            }

            const result = await bridge.sendProactive({
                senderAgentPubkey: context.agent.pubkey,
                channelId: input.channelId,
                content: input.content,
            });

            if (result.status === "accepted") {
                return { success: true, channelId: input.channelId };
            }

            const reason = result.errorReason ?? "send_failed";
            const detail = result.errorDetail ? `: ${result.errorDetail}` : "";
            return { error: `Telegram send failed (${reason})${detail}` };
        },
    });

    return aiTool as AISdkTool;
}
