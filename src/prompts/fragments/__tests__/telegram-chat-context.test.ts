import { describe, expect, it } from "bun:test";
import { telegramChatContextFragment } from "../33-telegram-chat-context";

describe("telegramChatContextFragment", () => {
    it("renders Telegram group metadata and provenance labels", () => {
        const result = telegramChatContextFragment.template({
            triggeringEnvelope: {
                transport: "telegram",
                principal: {
                    id: "telegram:user:42",
                    transport: "telegram",
                    displayName: "Alice",
                    username: "alice_tg",
                    kind: "human",
                },
                channel: {
                    id: "telegram:group:-2001:topic:55",
                    transport: "telegram",
                    kind: "topic",
                },
                message: {
                    id: "telegram:tg_n2001_99",
                    transport: "telegram",
                    nativeId: "tg_n2001_99",
                },
                recipients: [],
                content: "hello",
                occurredAt: 123,
                capabilities: ["telegram-bot", "telegram-group"],
                metadata: {
                    transport: {
                        telegram: {
                            updateId: 1,
                            chatId: "-2001",
                            messageId: "99",
                            threadId: "55",
                            chatType: "supergroup",
                            isEditedMessage: false,
                            senderUserId: "42",
                            chatTitle: "Operators",
                            chatUsername: "operators_hq",
                            memberCount: 12,
                            administrators: [{
                                userId: "7",
                                displayName: "Ada",
                                username: "ada_admin",
                                customTitle: "Owner",
                            }],
                            seenParticipants: [{
                                userId: "42",
                                displayName: "Alice",
                                username: "alice_tg",
                                lastSeenAt: 123,
                            }],
                        },
                    },
                },
            },
        });

        expect(result).toContain("## Telegram Chat Context");
        expect(result).toContain("- Context: Telegram topic");
        expect(result).toContain("- Chat title: Operators");
        expect(result).toContain("- Chat username: @operators_hq");
        expect(result).toContain("- Current sender: Alice (@alice_tg)");
        expect(result).toContain("- Topic/thread ID: 55");
        expect(result).toContain("- Member count (Telegram API snapshot): 12");
        expect(result).toContain("Administrators (Telegram API snapshot): Ada (@ada_admin) [Owner]");
        expect(result).toContain("Recently seen participants (TENEX-local observations): Alice (@alice_tg)");
    });

    it("renders nothing for non-Telegram executions", () => {
        const result = telegramChatContextFragment.template({});
        expect(result).toBe("");
    });
});
