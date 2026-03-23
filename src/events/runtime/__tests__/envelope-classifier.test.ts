import {
    isDirectedToSystem,
    toNativeId,
} from "@/events/runtime/envelope-classifier";
import { createMockInboundEnvelope } from "@/test-utils/mock-factories";
import { describe, expect, it } from "bun:test";

describe("envelope-classifier", () => {
    it("treats the project manager pubkey as a system recipient without service-layer access", () => {
        const envelope = createMockInboundEnvelope({
            recipients: [
                {
                    id: "nostr:project-manager",
                    transport: "nostr",
                    linkedPubkey: "project-manager-pubkey",
                    kind: "human",
                },
            ],
        });

        expect(
            isDirectedToSystem(
                envelope,
                new Map<string, { pubkey: string }>(),
                "project-manager-pubkey"
            )
        ).toBe(true);
    });

    it("documents multi-segment ID normalization", () => {
        expect(toNativeId("telegram:12345:67")).toBe("12345:67");
    });
});
