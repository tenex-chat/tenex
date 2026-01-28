import { describe, expect, it, beforeEach, afterEach, spyOn } from "bun:test";
import { resolveAgentSlug, resolveRecipientToPubkey } from "../AgentResolution";
import * as projectsModule from "@/services/projects";

describe("AgentResolution", () => {
    describe("resolveAgentSlug", () => {
        const mockAgentPubkey = "82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2";
        const mockAgentPubkey2 = "feb842e2e624cb58e364f8f7cb363c03407be9519ad48326f518f976b3551059";

        let getProjectContextSpy: ReturnType<typeof spyOn>;

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
        });

        afterEach(() => {
            getProjectContextSpy.mockRestore();
        });

        describe("Slug resolution (ONLY supported format)", () => {
            it("should resolve agent by slug", () => {
                const result = resolveAgentSlug("test-agent");
                expect(result.pubkey).toBe(mockAgentPubkey);
                expect(result.availableSlugs).toContain("test-agent");
                expect(result.availableSlugs).toContain("other-agent");
            });

            it("should resolve agent slug case-insensitively", () => {
                const result = resolveAgentSlug("TEST-AGENT");
                expect(result.pubkey).toBe(mockAgentPubkey);
            });

            it("should trim whitespace from input", () => {
                const result = resolveAgentSlug("  test-agent  ");
                expect(result.pubkey).toBe(mockAgentPubkey);
            });

            it("should return null for unknown slug with available slugs list", () => {
                const result = resolveAgentSlug("unknown-agent");
                expect(result.pubkey).toBe(null);
                expect(result.availableSlugs).toContain("test-agent");
                expect(result.availableSlugs).toContain("other-agent");
            });

            it("should handle getProjectContext throwing error", () => {
                getProjectContextSpy.mockImplementation(() => {
                    throw new Error("No project context");
                });

                // Should return null gracefully with empty availableSlugs
                const result = resolveAgentSlug("test-agent");
                expect(result.pubkey).toBe(null);
                expect(result.availableSlugs).toEqual([]);
            });
        });

        describe("Non-slug inputs (no format validation, just no match found)", () => {
            // NOTE: resolveAgentSlug does NOT perform explicit format validation.
            // It only performs slug lookup - if the input doesn't match a registered
            // slug, it returns null. These tests verify that non-slug inputs don't
            // accidentally match any registered agent slugs.

            it("should return null for 64-char hex pubkey (not a registered slug)", () => {
                const result = resolveAgentSlug(mockAgentPubkey);
                expect(result.pubkey).toBe(null);
                expect(result.availableSlugs.length).toBeGreaterThan(0);
            });

            it("should return null for npub (not a registered slug)", () => {
                const npub = "npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m";
                const result = resolveAgentSlug(npub);
                expect(result.pubkey).toBe(null);
            });

            it("should return null for nostr: prefixed npub (not a registered slug)", () => {
                const npub = "nostr:npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m";
                const result = resolveAgentSlug(npub);
                expect(result.pubkey).toBe(null);
            });

            it("should return null for 12-char hex prefix (not a registered slug)", () => {
                const prefix = mockAgentPubkey.substring(0, 12);
                const result = resolveAgentSlug(prefix);
                expect(result.pubkey).toBe(null);
            });

            it("should return null for agent name (names are not slugs)", () => {
                // Agent names like "Test Agent" are not the same as slugs like "test-agent"
                const result = resolveAgentSlug("Test Agent");
                expect(result.pubkey).toBe(null);
            });
        });
    });

    describe("resolveRecipientToPubkey (deprecated)", () => {
        const mockAgentPubkey = "82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2";

        let getProjectContextSpy: ReturnType<typeof spyOn>;

        beforeEach(() => {
            getProjectContextSpy = spyOn(projectsModule, "getProjectContext").mockReturnValue({
                agentRegistry: {
                    getAllAgentsMap: () => new Map([
                        ["test-agent", { name: "Test Agent", pubkey: mockAgentPubkey }],
                    ]),
                },
            } as any);
        });

        afterEach(() => {
            getProjectContextSpy.mockRestore();
        });

        it("should work as legacy wrapper returning just pubkey", () => {
            const result = resolveRecipientToPubkey("test-agent");
            expect(result).toBe(mockAgentPubkey);
        });

        it("should return null for unknown slug", () => {
            const result = resolveRecipientToPubkey("unknown-agent");
            expect(result).toBe(null);
        });
    });
});
