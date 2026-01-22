import { describe, expect, it, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { resolveRecipientToPubkey } from "../AgentResolution";
import * as projectsModule from "@/services/projects";
import { prefixKVStore } from "@/services/storage";

describe("AgentResolution", () => {
    describe("resolveRecipientToPubkey", () => {
        const mockAgentPubkey = "82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2";
        const mockAgentPubkey2 = "feb842e2e624cb58e364f8f7cb363c03407be9519ad48326f518f976b3551059";
        const mockEventId = "1111111111111111111111111111111111111111111111111111111111111111";

        let getProjectContextSpy: ReturnType<typeof spyOn>;
        let prefixLookupSpy: ReturnType<typeof spyOn>;
        let prefixIsInitializedSpy: ReturnType<typeof spyOn>;

        beforeEach(() => {
            // Setup default mock for project context
            getProjectContextSpy = spyOn(projectsModule, "getProjectContext").mockReturnValue({
                agentRegistry: {
                    getAllAgentsMap: () => new Map([
                        ["test-agent", { name: "Test Agent", pubkey: mockAgentPubkey }],
                        ["other-agent", { name: "Other Agent", pubkey: mockAgentPubkey2 }],
                    ]),
                },
            } as any);

            // Setup default mock for prefix store
            prefixIsInitializedSpy = spyOn(prefixKVStore, "isInitialized").mockReturnValue(false);
            prefixLookupSpy = spyOn(prefixKVStore, "lookup").mockReturnValue(null);
        });

        afterEach(() => {
            getProjectContextSpy.mockRestore();
            prefixLookupSpy.mockRestore();
            prefixIsInitializedSpy.mockRestore();
        });

        describe("Nostr identifier parsing (64-char hex, npub, nprofile)", () => {
            it("should resolve full 64-char hex pubkey", () => {
                const result = resolveRecipientToPubkey(mockAgentPubkey);
                expect(result).toBe(mockAgentPubkey);
            });

            it("should resolve npub to pubkey", () => {
                const npub = "npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m";
                const result = resolveRecipientToPubkey(npub);
                expect(result).toBe(mockAgentPubkey);
            });

            it("should resolve nostr: prefixed npub", () => {
                const npub = "nostr:npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m";
                const result = resolveRecipientToPubkey(npub);
                expect(result).toBe(mockAgentPubkey);
            });

            it("should trim whitespace from input", () => {
                const result = resolveRecipientToPubkey(`  ${mockAgentPubkey}  `);
                expect(result).toBe(mockAgentPubkey);
            });
        });

        describe("Agent slug/name resolution (BEFORE prefix lookup)", () => {
            it("should resolve agent by slug", () => {
                const result = resolveRecipientToPubkey("test-agent");
                expect(result).toBe(mockAgentPubkey);
            });

            it("should resolve agent by name (case-insensitive)", () => {
                const result = resolveRecipientToPubkey("Test Agent");
                expect(result).toBe(mockAgentPubkey);
            });

            it("should resolve agent by name lowercase", () => {
                const result = resolveRecipientToPubkey("test agent");
                expect(result).toBe(mockAgentPubkey);
            });

            it("should resolve agent slug case-insensitively", () => {
                const result = resolveRecipientToPubkey("TEST-AGENT");
                expect(result).toBe(mockAgentPubkey);
            });

            it("should return null for unknown slug when context available", () => {
                const result = resolveRecipientToPubkey("unknown-agent");
                expect(result).toBe(null);
            });

            it("should handle getProjectContext throwing error", () => {
                getProjectContextSpy.mockImplementation(() => {
                    throw new Error("No project context");
                });

                // Should return null gracefully, not throw
                const result = resolveRecipientToPubkey("test-agent");
                expect(result).toBe(null);
            });
        });

        describe("12-char hex prefix resolution", () => {
            const agentPrefix = mockAgentPubkey.substring(0, 12); // "82341f882b6e"

            it("should resolve 12-char prefix when it matches a known agent pubkey", () => {
                prefixIsInitializedSpy.mockReturnValue(true);
                prefixLookupSpy.mockReturnValue(mockAgentPubkey);

                const result = resolveRecipientToPubkey(agentPrefix);
                expect(result).toBe(mockAgentPubkey);
            });

            it("should NOT resolve prefix if it maps to an event ID (not agent pubkey)", () => {
                prefixIsInitializedSpy.mockReturnValue(true);
                // Return an ID that's NOT in the agent registry
                prefixLookupSpy.mockReturnValue(mockEventId);

                const result = resolveRecipientToPubkey("111111111111");
                // Should return null because mockEventId is not a known agent pubkey
                expect(result).toBe(null);
            });

            it("should return null when prefix store not initialized", () => {
                prefixIsInitializedSpy.mockReturnValue(false);

                const result = resolveRecipientToPubkey(agentPrefix);
                expect(result).toBe(null);
            });

            it("should return null when prefix not found in store", () => {
                prefixIsInitializedSpy.mockReturnValue(true);
                prefixLookupSpy.mockReturnValue(null);

                const result = resolveRecipientToPubkey("abcdef123456");
                expect(result).toBe(null);
            });

            it("should handle LMDB lookup throwing error gracefully", () => {
                prefixIsInitializedSpy.mockReturnValue(true);
                prefixLookupSpy.mockImplementation(() => {
                    throw new Error("LMDB read error");
                });

                // Should return null gracefully, not throw
                const result = resolveRecipientToPubkey(agentPrefix);
                expect(result).toBe(null);
            });
        });

        describe("Resolution precedence", () => {
            it("should prefer slug over prefix when both would match", () => {
                // Create an agent with a 12-char hex slug
                const hexSlug = "abcdef123456";
                const differentPubkey = "aaaaaaaaaaaabbbbbbbbbbbbccccccccccccddddddddddddeeeeeeeeeeeeeeee";

                getProjectContextSpy.mockReturnValue({
                    agentRegistry: {
                        getAllAgentsMap: () => new Map([
                            [hexSlug, { name: "Hex Agent", pubkey: differentPubkey }],
                        ]),
                    },
                } as any);

                // Even if prefix store would return something else
                prefixIsInitializedSpy.mockReturnValue(true);
                prefixLookupSpy.mockReturnValue(mockAgentPubkey);

                // Should resolve to the agent's pubkey via slug, NOT via prefix lookup
                const result = resolveRecipientToPubkey(hexSlug);
                expect(result).toBe(differentPubkey);
                // Prefix lookup should not even be called since slug matched
                expect(prefixLookupSpy).not.toHaveBeenCalled();
            });

            it("should fall back to prefix when slug/name not found", () => {
                prefixIsInitializedSpy.mockReturnValue(true);
                prefixLookupSpy.mockReturnValue(mockAgentPubkey);

                // This prefix doesn't match any slug
                const result = resolveRecipientToPubkey("82341f882b6e");
                expect(result).toBe(mockAgentPubkey);
                expect(prefixLookupSpy).toHaveBeenCalledWith("82341f882b6e");
            });
        });
    });
});
