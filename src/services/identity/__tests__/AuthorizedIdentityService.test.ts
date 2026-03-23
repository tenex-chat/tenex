import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { config } from "@/services/ConfigService";
import { AuthorizedIdentityService } from "@/services/identity/AuthorizedIdentityService";

describe("AuthorizedIdentityService", () => {
    afterEach(() => {
        mock.restore();
    });

    it("authorizes explicitly whitelisted transport principals", () => {
        spyOn(config, "getConfig").mockReturnValue({
            whitelistedIdentities: ["telegram:user:42"],
        } as ReturnType<typeof config.getConfig>);
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
        spyOn(config, "getConfig").mockReturnValue({
            whitelistedPubkeys: [linkedPubkey],
        } as ReturnType<typeof config.getConfig>);
        const service = new AuthorizedIdentityService();

        expect(
            service.isAuthorizedPrincipal({
                id: "telegram:user:99",
                linkedPubkey,
            })
        ).toBe(true);
    });

    it("includes per-agent authorized identities in the authorization set", () => {
        spyOn(config, "getConfig").mockReturnValue({} as ReturnType<typeof config.getConfig>);
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
