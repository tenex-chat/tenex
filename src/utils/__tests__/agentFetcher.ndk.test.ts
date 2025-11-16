/**
 * agentFetcher tests using NDK test utilities
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import {
    TENEXTestFixture,
    getTestUserWithSigner,
    withTestEnvironment,
} from "@/test-utils/ndk-test-helpers";
import { NDKKind } from "@nostr-dev-kit/ndk";
import type { NDK } from "@nostr-dev-kit/ndk";
import { fetchAgent } from "../agentFetcher";

describe("fetchAgent with NDK utilities", () => {
    describe("agent fetching with properly signed events", () => {
        it("should fetch and return agent definition event", async () => {
            await withTestEnvironment(async (fixture) => {
                // Create agent definition event
                const { user: agentUser } = await getTestUserWithSigner("alice", fixture.ndk);

                const agentDefinition = await fixture.eventFactory.createSignedTextNote(
                    JSON.stringify({
                        name: "DataAnalyzer",
                        role: "Analyzes data and provides insights",
                        tools: ["search", "calculate", "visualize"],
                        capabilities: {
                            languages: ["python", "javascript"],
                            frameworks: ["pandas", "numpy"],
                        },
                    }),
                    "alice",
                    31970 // Agent definition kind
                );
                agentDefinition.tags.push(
                    ["d", "data-analyzer"],
                    ["name", "DataAnalyzer"],
                    ["role", "Data Analysis Agent"]
                );

                // Mock NDK
                const mockNdk: Partial<NDK> = {
                    fetchEvent: mock(() => Promise.resolve(agentDefinition)),
                };

                const result = await fetchAgent("naddr1agenttest", mockNdk as NDK);

                expect(result).toBe(agentDefinition);
                expect(result?.pubkey).toBe(agentUser.pubkey);
                expect(result?.kind).toBe(31970);
                expect(result?.tagValue("name")).toBe("DataAnalyzer");
            });
        });

        it("should handle agent not found", async () => {
            await withTestEnvironment(async (fixture) => {
                const mockNdk: Partial<NDK> = {
                    fetchEvent: mock(() => Promise.resolve(null)),
                };

                const result = await fetchAgent("naddr1nonexistent", mockNdk as NDK);

                expect(result).toBeNull();
                expect(mockNdk.fetchEvent).toHaveBeenCalledWith("naddr1nonexistent");
            });
        });

        it("should fetch agent with complete metadata", async () => {
            await withTestEnvironment(async (fixture) => {
                const agentEvent = await fixture.createAgentEvent(
                    "bob",
                    JSON.stringify({
                        name: "CodeReviewer",
                        description: "Reviews code for quality and security",
                        version: "1.0.0",
                        author: "bob",
                    }),
                    31970,
                    [
                        ["d", "code-reviewer"],
                        ["name", "CodeReviewer"],
                        ["description", "Code review agent"],
                        ["version", "1.0.0"],
                        ["tool", "lint"],
                        ["tool", "security-scan"],
                        ["tool", "complexity-analysis"],
                        ["model", "gpt-4"],
                        ["language", "en"],
                    ]
                );

                const mockNdk: Partial<NDK> = {
                    fetchEvent: mock(() => Promise.resolve(agentEvent)),
                };

                const result = await fetchAgent("naddr1reviewer", mockNdk as NDK);

                expect(result).toBeDefined();
                expect(result?.tagValue("name")).toBe("CodeReviewer");
                expect(result?.tagValue("version")).toBe("1.0.0");

                // Check tools are properly tagged
                const toolTags = result?.getMatchingTags("tool") || [];
                expect(toolTags).toHaveLength(3);
                expect(toolTags.map((t) => t[1])).toContain("lint");
                expect(toolTags.map((t) => t[1])).toContain("security-scan");
            });
        });

        it("should fetch agent with relay hints", async () => {
            await withTestEnvironment(async (fixture) => {
                const agentEvent = await fixture.createAgentEvent(
                    "carol",
                    JSON.stringify({ name: "RelayAgent" }),
                    31970,
                    [
                        ["d", "relay-agent"],
                        ["relay", "wss://relay1.example.com"],
                        ["relay", "wss://relay2.example.com"],
                    ]
                );

                // Simulate relay interaction
                const relay = fixture.createMockRelay("wss://relay1.example.com");
                await relay.connect();
                await relay.publish(agentEvent);

                const mockNdk: Partial<NDK> = {
                    fetchEvent: mock(async () => {
                        // Simulate fetching from relay
                        await relay.simulateEvent(agentEvent);
                        return agentEvent;
                    }),
                };

                const result = await fetchAgent("naddr1relayagent", mockNdk as NDK);

                expect(result).toBeDefined();
                expect(result?.id).toBe(agentEvent.id);

                // Verify relay was used
                expect(relay.messageLog).toContainEqual(
                    expect.objectContaining({
                        direction: "out",
                        message: expect.stringContaining("EVENT"),
                    })
                );
            });
        });

        it("should handle multiple agent versions", async () => {
            await withTestEnvironment(async (fixture) => {
                // Create multiple versions of the same agent
                const v1 = await fixture.createAgentEvent(
                    "dave",
                    JSON.stringify({ name: "VersionedAgent", version: "1.0.0" }),
                    31970,
                    [
                        ["d", "versioned-agent"],
                        ["version", "1.0.0"],
                        ["deprecated", "true"],
                    ]
                );
                v1.created_at = 1000;

                const v2 = await fixture.createAgentEvent(
                    "dave",
                    JSON.stringify({ name: "VersionedAgent", version: "2.0.0" }),
                    31970,
                    [
                        ["d", "versioned-agent"],
                        ["version", "2.0.0"],
                        ["latest", "true"],
                    ]
                );
                v2.created_at = 2000;

                // Mock NDK to return the latest version
                const mockNdk: Partial<NDK> = {
                    fetchEvent: mock(() => Promise.resolve(v2)),
                };

                const result = await fetchAgent("naddr1versioned", mockNdk as NDK);

                expect(result).toBeDefined();
                expect(result?.tagValue("version")).toBe("2.0.0");
                expect(result?.tagValue("latest")).toBe("true");
                expect(result?.created_at).toBe(2000);
            });
        });

        it("should handle agent with delegation", async () => {
            await withTestEnvironment(async (fixture) => {
                const { user: owner } = await getTestUserWithSigner("eve", fixture.ndk);
                const { user: delegate } = await getTestUserWithSigner("alice", fixture.ndk);

                // Create agent event with delegation tag
                const agentEvent = await fixture.createAgentEvent(
                    "alice", // Delegate publishes
                    JSON.stringify({ name: "DelegatedAgent" }),
                    31970,
                    [
                        ["d", "delegated-agent"],
                        ["delegation", owner.pubkey, "conditions", "sig"], // Delegation from owner
                        ["name", "DelegatedAgent"],
                    ]
                );

                const mockNdk: Partial<NDK> = {
                    fetchEvent: mock(() => Promise.resolve(agentEvent)),
                };

                const result = await fetchAgent("naddr1delegated", mockNdk as NDK);

                expect(result).toBeDefined();
                expect(result?.pubkey).toBe(delegate.pubkey); // Published by delegate
                expect(result?.tagValue("delegation")).toBe(owner.pubkey); // But delegated by owner
            });
        });

        it("should validate agent event signature", async () => {
            await withTestEnvironment(async (fixture) => {
                const { signer } = await getTestUserWithSigner("bob", fixture.ndk);

                // Set signer for proper signing
                fixture.ndk.signer = signer;

                const agentEvent = await fixture.createAgentEvent(
                    "bob",
                    JSON.stringify({ name: "SignedAgent" }),
                    31970,
                    [["d", "signed-agent"]]
                );

                // Event should have valid signature
                expect(agentEvent.sig).toBeDefined();
                expect(agentEvent.sig).not.toBe("");

                const mockNdk: Partial<NDK> = {
                    fetchEvent: mock(() => Promise.resolve(agentEvent)),
                };

                const result = await fetchAgent("naddr1signed", mockNdk as NDK);

                expect(result).toBeDefined();
                expect(result?.sig).toBe(agentEvent.sig);
            });
        });
    });
});
