import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { TelegramAgentConfig } from "@/agents/types";
import { TelegramDeliveryService } from "@/services/telegram/TelegramDeliveryService";
import { createMockAgent, createMockExecutionEnvironment } from "@/test-utils";
import { createSendMessageTool } from "../send_message";

describe("send_message tool", () => {
    let sendToChannelSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        sendToChannelSpy = spyOn(TelegramDeliveryService.prototype, "sendToChannel").mockResolvedValue();
    });

    afterEach(() => {
        sendToChannelSpy.mockRestore();
    });

    it("rejects invalid channel IDs", async () => {
        const tool = createSendMessageTool(createMockExecutionEnvironment({
            agent: createMockAgent({
                telegram: {
                    botToken: "token",
                    chatBindings: [{ chatId: "1001", title: "Ops" }],
                } as TelegramAgentConfig,
            }),
        }));

        const result = await tool.execute({
            channelId: "1001",
            content: "hello",
        });

        expect(result).toEqual({ error: "Invalid channel ID format: 1001" });
        expect(sendToChannelSpy).not.toHaveBeenCalled();
    });

    it("rejects unbound channels", async () => {
        const tool = createSendMessageTool(createMockExecutionEnvironment({
            agent: createMockAgent({
                telegram: {
                    botToken: "token",
                    chatBindings: [{ chatId: "1001", title: "Ops" }],
                } as TelegramAgentConfig,
            }),
        }));

        const result = await tool.execute({
            channelId: "telegram:chat:2002",
            content: "hello",
        });

        expect(result).toEqual({
            error: "Channel telegram:chat:2002 is not in your configured chat bindings",
        });
        expect(sendToChannelSpy).not.toHaveBeenCalled();
    });

    it("sends proactive messages to bound channels", async () => {
        const tool = createSendMessageTool(createMockExecutionEnvironment({
            agent: createMockAgent({
                telegram: {
                    botToken: "token",
                    apiBaseUrl: "https://telegram.test",
                    chatBindings: [{ chatId: "-1001", topicId: "77", title: "Ops" }],
                } as TelegramAgentConfig,
            }),
        }));

        const result = await tool.execute({
            channelId: "telegram:group:-1001:topic:77",
            content: "hello",
        });

        expect(sendToChannelSpy).toHaveBeenCalledWith({
            botToken: "token",
            apiBaseUrl: "https://telegram.test",
            chatId: "-1001",
            messageThreadId: "77",
            content: "hello",
        });
        expect(result).toEqual({
            success: true,
            channelId: "telegram:group:-1001:topic:77",
        });
    });

    it("rejects channels with invalid Telegram topic bindings", async () => {
        const tool = createSendMessageTool(createMockExecutionEnvironment({
            agent: createMockAgent({
                telegram: {
                    botToken: "token",
                    chatBindings: [{ chatId: "5104033799", topicId: "test", title: "testing" }],
                } as TelegramAgentConfig,
            }),
        }));

        const result = await tool.execute({
            channelId: "telegram:group:5104033799:topic:test",
            content: "hello",
        });

        expect(result).toEqual({
            error: "Invalid Telegram message thread ID: test. Thread IDs must be numeric. Channel: telegram:group:5104033799:topic:test",
        });
        expect(sendToChannelSpy).not.toHaveBeenCalled();
    });
});
