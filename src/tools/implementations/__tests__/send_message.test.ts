import { describe, expect, it, mock } from "bun:test";
import type {
    AgentRuntimePublisher,
    PublishedMessageRef,
    TransportMessageIntent,
} from "@/events/runtime/AgentRuntimePublisher";
import type { EventContext } from "@/nostr/types";
import { createMockAgent, createMockExecutionEnvironment } from "@/test-utils";
import { createSendMessageTool } from "../send_message";

describe("send_message tool", () => {
    it("publishes a signed transport event through the runtime publisher", async () => {
        const { context, sendMessage } = makeContext();
        const tool = createSendMessageTool(context);

        const result = await tool.execute({
            channelId: "telegram:group:-1001:topic:77",
            content: "hello there",
        });

        expect(sendMessage).toHaveBeenCalledWith(
            {
                channelId: "telegram:group:-1001:topic:77",
                content: "hello there",
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
        expect(result).toEqual({
            success: true,
            channelId: "telegram:group:-1001:topic:77",
            eventId: "telegram-event-id",
        });
    });

    it("surfaces validation errors before publishing", async () => {
        const { context, sendMessage } = makeContext();
        const tool = createSendMessageTool(context);

        expect(await tool.execute({ channelId: "", content: "hello" })).toEqual({
            error: "channelId is required",
        });
        expect(await tool.execute({ channelId: "telegram:chat:2002", content: "" })).toEqual({
            error: "content is required",
        });
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it("surfaces publisher failures", async () => {
        const { context } = makeContext({
            sendMessage: mock(async () => {
                throw new Error("channel telegram:chat:2002 is not remembered");
            }),
        });
        const tool = createSendMessageTool(context);

        const result = await tool.execute({
            channelId: "telegram:chat:2002",
            content: "hello",
        });

        expect(result).toEqual({
            error: "Message send failed: channel telegram:chat:2002 is not remembered",
        });
    });
});

function makeContext(overrides?: {
    sendMessage?: (
        intent: TransportMessageIntent,
        context: EventContext
    ) => Promise<PublishedMessageRef>;
}) {
    const context = createMockExecutionEnvironment({
        agent: createMockAgent({
            pubkey: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        }),
    });
    const sendMessage =
        overrides?.sendMessage ??
        mock(async (): Promise<PublishedMessageRef> => ({
            id: "telegram-event-id",
            transport: "telegram",
            envelope: context.triggeringEnvelope,
        }));

    context.agentPublisher = {
        ...context.agentPublisher,
        sendMessage,
    } as AgentRuntimePublisher;

    return { context, sendMessage };
}
