import { describe, expect, it, beforeEach, afterEach, spyOn } from "bun:test";
import { resolveAgentId } from "../AgentResolution";
import * as projectsModule from "@/services/projects";
import { prefixKVStore } from "@/services/storage";
import { shortenPubkey } from "@/utils/conversation-id";

describe("AgentResolution", () => {
    const mockAgentPubkey = "82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2";
    const mockAgentPubkey2 = "feb842e2e624cb58e364f8f7cb363c03407be9519ad48326f518f976b3551059";

    let getProjectContextSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        getProjectContextSpy = spyOn(projectsModule, "getProjectContext").mockReturnValue({
            agentRegistry: {
                getAllAgentsMap: () => new Map([
                    ["test-agent", { slug: "test-agent", name: "Test Agent", pubkey: mockAgentPubkey }],
                    ["other-agent", { slug: "other-agent", name: "Other Agent", pubkey: mockAgentPubkey2 }],
                ]),
            },
        } as any);
    });

    afterEach(() => {
        getProjectContextSpy.mockRestore();
    });

    it("resolves agent ids by slug", () => {
        const result = resolveAgentId("test-agent");
        expect(result.pubkey).toBe(mockAgentPubkey);
        expect(result.slug).toBe("test-agent");
        expect(result.availableIds).toContain("test-agent");
        expect(result.availableIds).toContain("other-agent");
    });

    it("resolves slugs case-insensitively", () => {
        const result = resolveAgentId("TEST-AGENT");
        expect(result.pubkey).toBe(mockAgentPubkey);
        expect(result.slug).toBe("test-agent");
    });

    it("trims whitespace from input", () => {
        const result = resolveAgentId("  test-agent  ");
        expect(result.pubkey).toBe(mockAgentPubkey);
    });

    it("resolves exact full pubkeys", () => {
        const result = resolveAgentId(mockAgentPubkey);
        expect(result.pubkey).toBe(mockAgentPubkey);
        expect(result.slug).toBe("test-agent");
    });

    it("resolves short pubkey ids", () => {
        const result = resolveAgentId(shortenPubkey(mockAgentPubkey));
        expect(result.pubkey).toBe(mockAgentPubkey);
        expect(result.slug).toBe("test-agent");
    });

    it("resolves short pubkey ids through the centralized prefix store", () => {
        const isInitializedSpy = spyOn(prefixKVStore, "isInitialized").mockReturnValue(true);
        const lookupUniquePrefixSpy = spyOn(prefixKVStore, "lookupUniquePrefix").mockReturnValue(mockAgentPubkey);

        try {
            const result = resolveAgentId("aaaaaa");
            expect(result.pubkey).toBe(mockAgentPubkey);
            expect(result.slug).toBe("test-agent");
            expect(lookupUniquePrefixSpy).toHaveBeenCalledWith("aaaaaa");
        } finally {
            lookupUniquePrefixSpy.mockRestore();
            isInitializedSpy.mockRestore();
        }
    });

    it("resolves npub ids", () => {
        const npub = "npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m";
        const result = resolveAgentId(npub);
        expect(result.pubkey).toBe(mockAgentPubkey);
        expect(result.slug).toBe("test-agent");
    });

    it("resolves nostr-prefixed npub ids", () => {
        const npub = "nostr:npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m";
        const result = resolveAgentId(npub);
        expect(result.pubkey).toBe(mockAgentPubkey);
        expect(result.slug).toBe("test-agent");
    });

    it("returns null for unknown ids with available ids", () => {
        const result = resolveAgentId("unknown-agent");
        expect(result.pubkey).toBe(null);
        expect(result.slug).toBe(null);
        expect(result.failureReason).toBe("not_found");
        expect(result.availableIds).toContain("test-agent");
        expect(result.availableIds).toContain("other-agent");
    });

    it("returns ambiguous for short ids matching multiple agents", () => {
        getProjectContextSpy.mockReturnValue({
            agentRegistry: {
                getAllAgentsMap: () => new Map([
                    ["first-agent", {
                        slug: "first-agent",
                        pubkey: "abcdef123456abcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2",
                    }],
                    ["second-agent", {
                        slug: "second-agent",
                        pubkey: "abcdef999999cb58e364f8f7cb363c03407be9519ad48326f518f976b3551059",
                    }],
                ]),
            },
        } as any);

        const result = resolveAgentId("abcdef");
        expect(result.pubkey).toBe(null);
        expect(result.failureReason).toBe("ambiguous");
    });

    it("handles missing project context", () => {
        getProjectContextSpy.mockImplementation(() => {
            throw new Error("No project context");
        });

        const result = resolveAgentId("test-agent");
        expect(result.pubkey).toBe(null);
        expect(result.availableIds).toEqual([]);
    });
});
