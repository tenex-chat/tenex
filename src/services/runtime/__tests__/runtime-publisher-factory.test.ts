import { describe, expect, it } from "bun:test";
import { AgentPublisher } from "@/nostr/AgentPublisher";
import { createDefaultRuntimePublisherFactory } from "@/services/runtime/runtime-publisher-factory";
import { TelegramDeliveryService } from "@/services/telegram/TelegramDeliveryService";
import { TelegramRuntimePublisherService } from "@/services/telegram/TelegramRuntimePublisherService";
import type { RuntimePublishAgent } from "@/events/runtime/RuntimeAgent";

function createAgent(overrides: Partial<RuntimePublishAgent> = {}): RuntimePublishAgent {
    return {
        name: "telegram-agent",
        slug: "telegram-agent",
        pubkey: "a".repeat(64),
        sign: async () => undefined,
        ...overrides,
    };
}

describe("createDefaultRuntimePublisherFactory", () => {
    it("selects the Telegram runtime publisher for Telegram-enabled agents", () => {
        const publisherFactory = createDefaultRuntimePublisherFactory(new TelegramDeliveryService());

        const publisher = publisherFactory(createAgent({
            telegram: {
                botToken: "token",
            },
        }));

        expect(publisher).toBeInstanceOf(TelegramRuntimePublisherService);
    });

    it("falls back to the Nostr publisher for non-Telegram agents", () => {
        const publisherFactory = createDefaultRuntimePublisherFactory(new TelegramDeliveryService());

        const publisher = publisherFactory(createAgent());

        expect(publisher).toBeInstanceOf(AgentPublisher);
    });
});
