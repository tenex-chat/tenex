import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramPendingBindingStore } from "@/services/telegram/TelegramPendingBindingStoreService";

describe("TelegramPendingBindingStore", () => {
    let tempDir: string;
    let storagePath: string;
    let nowSpy: ReturnType<typeof spyOn>;

    beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), "tenex-pending-bindings-"));
        storagePath = join(tempDir, "telegram-pending-bindings.json");
        nowSpy = spyOn(Date, "now").mockReturnValue(2_000_000_000_000);
    });

    afterEach(async () => {
        nowSpy.mockRestore();
        await rm(tempDir, { recursive: true, force: true });
    });

    it("drops expired bindings while loading persisted state", async () => {
        await writeFile(storagePath, `${JSON.stringify([{
            agentPubkey: "agent-1",
            channelId: "telegram:chat:1",
            projects: [{ projectId: "project-a", title: "Project A" }],
            requestedAt: 2_000_000_000_000 - (1000 * 60 * 60 * 25),
        }], null, 2)}\n`);

        const store = new TelegramPendingBindingStore(storagePath);

        expect(store.getPending("agent-1", "telegram:chat:1")).toBeUndefined();
        expect(JSON.parse(await readFile(storagePath, "utf8"))).toEqual([]);
    });

    it("evicts expired bindings on access", async () => {
        const store = new TelegramPendingBindingStore(storagePath);
        store.rememberPending({
            agentPubkey: "agent-1",
            channelId: "telegram:chat:1",
            projects: [{ projectId: "project-a", title: "Project A" }],
            requestedAt: 2_000_000_000_000 - (1000 * 60 * 60 * 23),
        });

        expect(store.getPending("agent-1", "telegram:chat:1")).toEqual({
            agentPubkey: "agent-1",
            channelId: "telegram:chat:1",
            projects: [{ projectId: "project-a", title: "Project A" }],
            requestedAt: 2_000_000_000_000 - (1000 * 60 * 60 * 23),
        });

        nowSpy.mockReturnValue(2_000_000_000_000 + (1000 * 60 * 60 * 2));

        expect(store.getPending("agent-1", "telegram:chat:1")).toBeUndefined();
        expect(JSON.parse(await readFile(storagePath, "utf8"))).toEqual([]);
    });
});
