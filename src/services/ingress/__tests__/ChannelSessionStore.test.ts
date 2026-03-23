import { afterEach, describe, expect, it } from "bun:test";
import { ChannelSessionStore } from "@/services/ingress/ChannelSessionStoreService";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("ChannelSessionStore", () => {
    const tempPaths: string[] = [];

    afterEach(() => {
        for (const path of tempPaths.splice(0)) {
            if (existsSync(path)) {
                rmSync(path, { force: true });
            }
        }
    });

    it("persists channel session continuity data", () => {
        const storagePath = join(tmpdir(), `channel-sessions-${Date.now()}.json`);
        tempPaths.push(storagePath);

        const store = new ChannelSessionStore(storagePath);
        store.rememberSession({
            projectId: "project-a",
            agentPubkey: "a".repeat(64),
            channelId: "telegram:chat:1001",
            conversationId: "conversation-1",
            lastMessageId: "tg_1001_1",
        });

        const reloaded = new ChannelSessionStore(storagePath);
        expect(
            reloaded.getSession("project-a", "a".repeat(64), "telegram:chat:1001")
        ).toMatchObject({
            conversationId: "conversation-1",
            lastMessageId: "tg_1001_1",
        });
    });
});
