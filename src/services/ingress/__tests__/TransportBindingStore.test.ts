import { afterEach, describe, expect, it } from "bun:test";
import { TransportBindingStore } from "@/services/ingress/TransportBindingStoreService";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("TransportBindingStore", () => {
    const tempPaths: string[] = [];

    afterEach(() => {
        for (const path of tempPaths.splice(0)) {
            if (existsSync(path)) {
                rmSync(path, { force: true });
            }
        }
    });

    it("persists transport-aware bindings to transport-bindings.json format", () => {
        const storagePath = join(tmpdir(), `transport-bindings-${Date.now()}.json`);
        tempPaths.push(storagePath);

        const store = new TransportBindingStore(storagePath);
        store.rememberBinding({
            transport: "telegram",
            projectId: "project-a",
            agentPubkey: "a".repeat(64),
            channelId: "telegram:chat:1001",
        });

        const reloaded = new TransportBindingStore(storagePath);
        expect(
            reloaded.getBinding("a".repeat(64), "telegram:chat:1001")
        ).toMatchObject({
            transport: "telegram",
            projectId: "project-a",
        });
    });
});
