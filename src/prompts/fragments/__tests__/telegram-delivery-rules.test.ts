import { describe, expect, it } from "bun:test";
import { telegramDeliveryRulesFragment } from "../34-telegram-delivery-rules";

describe("telegramDeliveryRulesFragment", () => {
    it("renders Telegram voice marker guidance for Telegram executions", () => {
        const result = telegramDeliveryRulesFragment.template({
            triggeringEnvelope: {
                transport: "telegram",
                principal: {
                    id: "telegram:user:42",
                    transport: "telegram",
                    kind: "human",
                },
                channel: {
                    id: "telegram:chat:1001",
                    transport: "telegram",
                    kind: "dm",
                },
                message: {
                    id: "telegram:tg_1001_5",
                    transport: "telegram",
                    nativeId: "tg_1001_5",
                },
                recipients: [],
                content: "hello",
                occurredAt: 123,
                capabilities: ["telegram-bot"],
                metadata: {},
            },
        });

        expect(result).toContain("## Telegram Delivery Rules");
        expect(result).toContain("[[telegram_voice:/absolute/path/to/file.ogg]]");
        expect(result).toContain("send the voice message first");
        expect(result).toContain("Never explain the marker");
    });

    it("renders nothing for non-Telegram executions", () => {
        expect(telegramDeliveryRulesFragment.template({})).toBe("");
    });
});
