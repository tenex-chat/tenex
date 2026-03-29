import { describe, expect, it } from "bun:test";
import { noResponseGuidanceFragment } from "../18-no-response-guidance";

describe("noResponseGuidanceFragment", () => {
    it("renders guidance for Telegram-triggered turns", () => {
        const result = noResponseGuidanceFragment.template({
            triggeringEnvelope: {
                transport: "telegram",
            } as any,
        });

        expect(result).toContain("## Silent Completion");
        expect(result).toContain("call `no_response()`");
    });

    it("renders nothing outside Telegram", () => {
        expect(noResponseGuidanceFragment.template({})).toBe("");
        expect(
            noResponseGuidanceFragment.template({
                triggeringEnvelope: {
                    transport: "nostr",
                } as any,
            })
        ).toBe("");
    });
});
