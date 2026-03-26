import { describe, expect, it } from "bun:test";
import { channelBindingsFragment } from "../34-channel-bindings";

describe("channelBindingsFragment", () => {
    it("renders remembered Telegram group bindings", () => {
        const result = channelBindingsFragment.template({
            bindings: [{
                channelId: "telegram:group:5104033799:topic:55",
                description: 'Telegram topic in "Pablo & transparent"',
            }],
        });

        expect(result).toContain("## Your Channel Bindings");
        expect(result).toContain(
            'telegram:group:5104033799:topic:55 — Telegram topic in "Pablo & transparent"'
        );
    });

    it("renders remembered Telegram DM bindings", () => {
        const result = channelBindingsFragment.template({
            bindings: [{
                channelId: "telegram:chat:599309204",
                description: "Telegram DM with Pablo F7z (@pablof7z)",
            }],
        });

        expect(result).toContain("telegram:chat:599309204 — Telegram DM with Pablo F7z (@pablof7z)");
    });
});
