import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import {
    TelegramConfigSessionStore,
    type TelegramConfigSessionRecord,
} from "@/services/telegram/TelegramConfigSessionStoreService";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function createSessionRecord(): Omit<TelegramConfigSessionRecord, "createdAt" | "id" | "updatedAt"> {
    return {
        agentName: "Telegram Agent",
        agentPubkey: "a".repeat(64),
        availableModels: ["model-a", "model-b"],
        availableTools: ["fs_read", "shell"],
        channelId: "telegram:chat:1001",
        chatId: "1001",
        currentPage: 0,
        kind: "tools",
        messageId: "200",
        principalId: "telegram:user:42",
        projectBinding: `31933:${"f".repeat(64)}:project-alpha`,
        projectId: "project-alpha",
        projectTitle: "Project Alpha",
        selectedModel: "model-a",
        selectedTools: ["fs_read"],
    };
}

describe("TelegramConfigSessionStore", () => {
    const tempDirs: string[] = [];

    afterEach(() => {
        setSystemTime();

        for (const dir of tempDirs.splice(0)) {
            if (existsSync(dir)) {
                rmSync(dir, { recursive: true, force: true });
            }
        }
    });

    it("persists sessions so menus survive store reinitialization", () => {
        const baseDir = join(tmpdir(), `telegram-config-store-${Date.now()}`);
        const storagePath = join(baseDir, "telegram-config-sessions.json");
        tempDirs.push(baseDir);
        mkdirSync(baseDir, { recursive: true });

        const store = new TelegramConfigSessionStore(storagePath);
        const created = store.createSession(createSessionRecord());

        const reloadedStore = new TelegramConfigSessionStore(storagePath);
        expect(reloadedStore.getSession(created.id)).toEqual(created);
    });

    it("expires stale sessions after the TTL window", () => {
        const baseDir = join(tmpdir(), "telegram-config-store-expiry");
        const storagePath = join(baseDir, "telegram-config-sessions.json");
        tempDirs.push(baseDir);
        mkdirSync(baseDir, { recursive: true });

        setSystemTime(new Date("2026-03-19T10:00:00.000Z"));
        const store = new TelegramConfigSessionStore(storagePath);
        const created = store.createSession(createSessionRecord());

        setSystemTime(new Date("2026-03-19T10:16:00.000Z"));
        const reloadedStore = new TelegramConfigSessionStore(storagePath);
        expect(reloadedStore.getSession(created.id)).toBeUndefined();
    });
});
