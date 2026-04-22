import { describe, expect, it } from "bun:test";
import type { AgentWorkerProtocolMessage } from "@/events/runtime/AgentWorkerProtocol";
import type { TelegramSendBridge } from "@/agents/execution/worker/telegram-send-bridge";
import { createMockAgent, createMockExecutionEnvironment } from "@/test-utils";
import { createSendMessageTool } from "../send_message";

type TelegramSendResult = Extract<AgentWorkerProtocolMessage, { type: "telegram_send_result" }>;

interface CapturedRequest {
    senderAgentPubkey: string;
    channelId: string;
    content: string;
}

function makeBridge(result: TelegramSendResult): {
    bridge: TelegramSendBridge;
    captured: CapturedRequest[];
} {
    const captured: CapturedRequest[] = [];
    const bridge: TelegramSendBridge = {
        async sendProactive(params) {
            captured.push(params);
            return result;
        },
    };
    return { bridge, captured };
}

function acceptedResult(correlationId: string): TelegramSendResult {
    return {
        version: 1,
        type: "telegram_send_result",
        correlationId,
        sequence: 42,
        timestamp: 1_710_000_000_000,
        status: "accepted",
    };
}

function failedResult(
    correlationId: string,
    errorReason: string,
    errorDetail?: string
): TelegramSendResult {
    return {
        version: 1,
        type: "telegram_send_result",
        correlationId,
        sequence: 42,
        timestamp: 1_710_000_000_000,
        status: "failed",
        errorReason,
        errorDetail,
    };
}

describe("send_message tool", () => {
    it("surfaces an error when no bridge is active", async () => {
        const tool = createSendMessageTool(
            createMockExecutionEnvironment({
                agent: createMockAgent({}),
            })
        );

        const result = await tool.execute({
            channelId: "telegram:group:-1001:topic:77",
            content: "hello",
        });

        expect(result).toEqual({
            error: "Telegram send bridge is not available in this execution context",
        });
    });

    it("emits telegram_send_request and returns accepted on bridge success", async () => {
        const { bridge, captured } = makeBridge(acceptedResult("exec:tg-send:1"));
        const agent = createMockAgent({
            pubkey: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        });
        const tool = createSendMessageTool(
            createMockExecutionEnvironment({ agent }),
            { bridge }
        );

        const result = await tool.execute({
            channelId: "telegram:group:-1001:topic:77",
            content: "hello there",
        });

        expect(captured).toEqual([
            {
                senderAgentPubkey:
                    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                channelId: "telegram:group:-1001:topic:77",
                content: "hello there",
            },
        ]);
        expect(result).toEqual({
            success: true,
            channelId: "telegram:group:-1001:topic:77",
        });
    });

    it("surfaces invalid_channel_id failures with the error detail", async () => {
        const { bridge, captured } = makeBridge(
            failedResult("exec:tg-send:1", "invalid_channel_id", "channel id must start with 'telegram:'")
        );
        const tool = createSendMessageTool(
            createMockExecutionEnvironment({ agent: createMockAgent({}) }),
            { bridge }
        );

        const result = await tool.execute({
            channelId: "1001",
            content: "hello",
        });

        expect(result).toEqual({
            error: "Telegram send failed (invalid_channel_id): channel id must start with 'telegram:'",
        });
        expect(captured).toHaveLength(1);
    });

    it("surfaces unbound_channel failures", async () => {
        const { bridge } = makeBridge(
            failedResult("exec:tg-send:1", "unbound_channel", "channel telegram:chat:2002 is not remembered")
        );
        const tool = createSendMessageTool(
            createMockExecutionEnvironment({ agent: createMockAgent({}) }),
            { bridge }
        );

        const result = await tool.execute({
            channelId: "telegram:chat:2002",
            content: "hello",
        });

        expect(result).toEqual({
            error: "Telegram send failed (unbound_channel): channel telegram:chat:2002 is not remembered",
        });
    });

    it("surfaces outbox_error failures with no detail", async () => {
        const { bridge } = makeBridge(failedResult("exec:tg-send:1", "outbox_error"));
        const tool = createSendMessageTool(
            createMockExecutionEnvironment({ agent: createMockAgent({}) }),
            { bridge }
        );

        const result = await tool.execute({
            channelId: "telegram:group:-1001:topic:77",
            content: "hello",
        });

        expect(result).toEqual({ error: "Telegram send failed (outbox_error)" });
    });
});
