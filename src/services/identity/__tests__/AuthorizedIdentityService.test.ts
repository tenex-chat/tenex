import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { config } from "@/services/ConfigService";
import { AuthorizedIdentityService } from "@/services/identity/AuthorizedIdentityService";

describe("AuthorizedIdentityService", () => {
    afterEach(() => {
        mock.restore();
    });

    it("authorizes explicitly whitelisted transport principals", () => {
        spyOn(config, "getWhitelistedIdentities").mockReturnValue(["telegram:user:42"]);
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
        spyOn(config, "getWhitelistedIdentities").mockReturnValue([`nostr:${linkedPubkey}`]);
        const service = new AuthorizedIdentityService();

        expect(
            service.isAuthorizedPrincipal({
                id: "telegram:user:99",
                linkedPubkey,
            })
        ).toBe(true);
    });

    it("does not authorize unlisted principals", () => {
        spyOn(config, "getConfig").mockReturnValue({} as ReturnType<typeof config.getConfig>);
        const service = new AuthorizedIdentityService();

        expect(
            service.isAuthorizedPrincipal({
                id: "telegram:user:77",
                linkedPubkey: undefined,
            })
        ).toBe(false);
    });
});
