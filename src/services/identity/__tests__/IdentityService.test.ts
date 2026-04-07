import { afterEach, describe, expect, it } from "bun:test";
import { IdentityBindingStore } from "@/services/identity/IdentityBindingStoreService";
import { IdentityService } from "@/services/identity/IdentityService";
import { PUBKEY_DISPLAY_LENGTH } from "@/utils/nostr-entity-parser";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("IdentityService", () => {
    const tempPaths: string[] = [];

    afterEach(() => {
        for (const path of tempPaths.splice(0)) {
            if (existsSync(path)) {
                rmSync(path, { force: true });
            }
        }
    });

    it("resolves transport-only principals from stored display names", async () => {
        const storagePath = join(tmpdir(), `identity-bindings-${Date.now()}-transport.json`);
        tempPaths.push(storagePath);

        const store = new IdentityBindingStore(storagePath);
        const service = new IdentityService(store, () => ({
            getName: async (pubkey: string) => pubkey,
            getNameSync: (pubkey: string) => pubkey,
            warmUserProfiles: async () => new Map(),
        }));

        service.rememberIdentity({
            principalId: "telegram:user:42",
            displayName: "Alice Telegram",
            username: "alice_tg",
            kind: "human",
        });

        expect(service.getDisplayNameSync({ principalId: "telegram:user:42" })).toBe("Alice Telegram");
        expect(await service.getDisplayName({ principalId: "telegram:user:42" })).toBe("Alice Telegram");
    });

    it("prefers linked pubkey naming over transport-native names", async () => {
        const storagePath = join(tmpdir(), `identity-bindings-${Date.now()}-linked.json`);
        tempPaths.push(storagePath);

        const store = new IdentityBindingStore(storagePath);
        const service = new IdentityService(store, () => ({
            getName: async () => "nostr-alice",
            getNameSync: () => "nostr-alice",
            warmUserProfiles: async () => new Map(),
        }));

        service.linkPrincipalToPubkey("telegram:user:99", "f".repeat(64), {
            displayName: "Alice Telegram",
            username: "alice_tg",
            kind: "human",
        });

        expect(service.getDisplayNameSync({ principalId: "telegram:user:99" })).toBe("nostr-alice");
        expect(await service.getDisplayName({ principalId: "telegram:user:99" })).toBe("nostr-alice");
    });

    it("falls back to transport-native names when linked pubkey resolution is unavailable", async () => {
        const storagePath = join(tmpdir(), `identity-bindings-${Date.now()}-fallback.json`);
        tempPaths.push(storagePath);

        const store = new IdentityBindingStore(storagePath);
        const linkedPubkey = "a".repeat(64);
        const service = new IdentityService(store, () => ({
            getName: async () => linkedPubkey.substring(0, PUBKEY_DISPLAY_LENGTH),
            warmUserProfiles: async () => new Map(),
        }));

        service.linkPrincipalToPubkey("telegram:user:100", linkedPubkey, {
            displayName: "Alice Telegram",
            username: "alice_tg",
            kind: "human",
        });

        expect(service.getDisplayNameSync({ principalId: "telegram:user:100" })).toBe("Alice Telegram");
        expect(await service.getDisplayName({ principalId: "telegram:user:100" })).toBe("Alice Telegram");
    });
});
