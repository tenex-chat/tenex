import { afterEach, describe, expect, it } from "bun:test";
import { IdentityBindingStore } from "@/services/identity/IdentityBindingStoreService";
import { TelegramInboundAdapter } from "@/services/telegram/TelegramInboundAdapter";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("TelegramInboundAdapter", () => {
    const tempDirs: string[] = [];
    const originalBaseDir = process.env.TENEX_BASE_DIR;

    afterEach(() => {
        IdentityBindingStore.resetInstance();
        process.env.TENEX_BASE_DIR = originalBaseDir;

        for (const dir of tempDirs.splice(0)) {
            if (existsSync(dir)) {
                rmSync(dir, { recursive: true, force: true });
            }
        }
    });

    it("normalizes Telegram updates into canonical envelopes", () => {
        const baseDir = join(tmpdir(), `telegram-inbound-${Date.now()}`);
        tempDirs.push(baseDir);
        mkdirSync(baseDir, { recursive: true });
        process.env.TENEX_BASE_DIR = baseDir;

        const linkedPubkey = "a".repeat(64);
        const store = IdentityBindingStore.getInstance();
        store.linkPrincipalToPubkey("telegram:user:42", linkedPubkey, {
            displayName: "Alice Telegram",
        });

        const adapter = new TelegramInboundAdapter();
        const result = adapter.toEnvelope({
            update: {
                update_id: 1,
                message: {
                    message_id: 99,
                    date: 123,
                    chat: {
                        id: -2001,
                        type: "supergroup",
                        title: "Operators",
                    },
                    from: {
                        id: 42,
                        is_bot: false,
                        first_name: "Alice",
                        username: "alice_tg",
                    },
                    text: "hello from telegram",
                    message_thread_id: 55,
                },
            },
            binding: {
                agent: {
                    name: "Telegram Agent",
                    slug: "telegram-agent",
                    pubkey: "b".repeat(64),
                } as any,
                config: {
                    botToken: "token",
                },
                chatBindings: [],
            },
            projectBinding: `31933:${"c".repeat(64)}:telegram-project`,
            replyToNativeMessageId: "tg_n2001_98",
        });

        expect(result.envelope.principal).toMatchObject({
            id: "telegram:user:42",
            transport: "telegram",
            linkedPubkey,
            displayName: "Alice",
            username: "alice_tg",
        });
        expect(result.envelope.channel).toEqual({
            id: "telegram:group:-2001:topic:55",
            transport: "telegram",
            kind: "topic",
            projectBinding: `31933:${"c".repeat(64)}:telegram-project`,
        });
        expect(result.envelope.message).toEqual({
            id: "telegram:tg_n2001_99",
            transport: "telegram",
            nativeId: "tg_n2001_99",
            replyToId: "telegram:tg_n2001_98",
        });
        expect(result.envelope.recipients).toEqual([
            {
                id: `nostr:${"b".repeat(64)}`,
                transport: "nostr",
                linkedPubkey: "b".repeat(64),
                displayName: "Telegram Agent",
                kind: "agent",
            },
        ]);
    });
});
