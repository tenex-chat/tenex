import { afterEach, describe, expect, it } from "bun:test";
import { config } from "@/services/ConfigService";
import { AuthorizedIdentityService } from "@/services/identity/AuthorizedIdentityService";

describe("AuthorizedIdentityService", () => {
    const originalLoadedConfig = (config as any).loadedConfig;

    afterEach(() => {
        (config as any).loadedConfig = originalLoadedConfig;
    });

    it("authorizes explicitly whitelisted transport principals", () => {
        (config as any).loadedConfig = {
            config: {
                whitelistedIdentities: ["telegram:user:42"],
            },
        };
        const service = new AuthorizedIdentityService();

        expect(
            service.isAuthorizedPrincipal({
                id: "telegram:user:42",
                linkedPubkey: undefined,
            })
        ).toBe(true);
    });

    it("authorizes linked principals when the linked pubkey is whitelisted as a nostr principal", () => {
        const linkedPubkey = "f".repeat(64);
        (config as any).loadedConfig = {
            config: {
                whitelistedPubkeys: [linkedPubkey],
            },
        };
        const service = new AuthorizedIdentityService();

        expect(
            service.isAuthorizedPrincipal({
                id: "telegram:user:99",
                linkedPubkey,
            })
        ).toBe(true);
    });

    it("includes per-agent authorized identities in the authorization set", () => {
        (config as any).loadedConfig = {
            config: {},
        };
        const service = new AuthorizedIdentityService();

        expect(
            service.isAuthorizedPrincipal(
                {
                    id: "telegram:user:77",
                    linkedPubkey: undefined,
                },
                ["telegram:user:77"]
            )
        ).toBe(true);
    });
});
