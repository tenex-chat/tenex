import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { NDKEvent, NDKPrivateKeySigner, NDKProject } from "@nostr-dev-kit/ndk";
import { AgentProfilePublisher } from "../AgentProfilePublisher";
import { getNDK } from "../ndkClient";
import { config } from "@/services/ConfigService";

// Mock the NDK client
mock.module("../ndkClient", () => ({
    getNDK: mock(() => ({
        // Mock NDK instance
    })),
}));

// Mock logger
mock.module("@/utils/logger", () => ({
    logger: {
        debug: mock(),
        info: mock(),
        warn: mock(),
        error: mock(),
    },
}));

// Mock AgentsRegistryService
mock.module("@/services/AgentsRegistryService", () => ({
    agentsRegistryService: {
        getProjectsForAgent: mock(() => Promise.resolve([])),
        addAgent: mock(() => Promise.resolve()),
    },
}));

// Mock agentStorage
mock.module("@/agents/AgentStorage", () => ({
    agentStorage: {
        getAgentProjects: mock(() => Promise.resolve([])),
        getProjectAgents: mock(() => Promise.resolve([])),
    },
}));

describe("AgentProfilePublisher - Agent Metadata in Kind:0", () => {
    let mockPublish: any;
    let mockSign: any;
    let publishSpy: ReturnType<typeof spyOn>;
    let signSpy: ReturnType<typeof spyOn>;
    let getConfigSpy: ReturnType<typeof spyOn>;
    let getWhitelistedPubkeysSpy: ReturnType<typeof spyOn>;
    let ensureBackendPrivateKeySpy: ReturnType<typeof spyOn>;
    let capturedEvents: NDKEvent[] = [];

    beforeEach(() => {
        capturedEvents = [];

        // Mock NDKEvent to capture all published events
        mockPublish = mock();
        mockSign = mock();

        publishSpy = spyOn(NDKEvent.prototype, "publish").mockImplementation(function (this: NDKEvent) {
            capturedEvents.push(this);
            return mockPublish();
        });

        signSpy = spyOn(NDKEvent.prototype, "sign").mockImplementation(mockSign);

        getConfigSpy = spyOn(config, "getConfig").mockReturnValue({});
        getWhitelistedPubkeysSpy = spyOn(config, "getWhitelistedPubkeys").mockReturnValue([]);
        ensureBackendPrivateKeySpy = spyOn(config, "ensureBackendPrivateKey").mockResolvedValue("a".repeat(64));
    });

    afterEach(() => {
        publishSpy.mockRestore();
        signSpy.mockRestore();
        getConfigSpy.mockRestore();
        getWhitelistedPubkeysSpy.mockRestore();
        ensureBackendPrivateKeySpy.mockRestore();
    });

    // Helper to get the kind:0 event from captured events
    const getKind0Event = (): NDKEvent | undefined => capturedEvents.find(e => e.kind === 0);

    describe("publishAgentProfile", () => {
        it("should include metadata tags for agents without NDKAgentDefinition event ID", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const projectEvent = new NDKProject(getNDK());
            projectEvent.tagValue = mock(() => "Test Project");
            projectEvent.tagReference = mock(() => ["a", "31933:pubkey:d-tag"]);

            const agentMetadata = {
                description: "A test agent that does testing",
                instructions: "Follow these test instructions carefully",
                useCriteria: "Use when testing is needed",
            };

            await AgentProfilePublisher.publishAgentProfile(
                signer,
                "TestAgent",
                "Tester",
                "Test Project",
                projectEvent,
                undefined, // No NDKAgentDefinition event ID
                agentMetadata,
                [] // No whitelisted pubkeys for this test
            );

            expect(mockSign).toHaveBeenCalled();
            expect(mockPublish).toHaveBeenCalled();

            const capturedEvent = getKind0Event();
            expect(capturedEvent).toBeDefined();

            if (capturedEvent) {
                // Verify kind:0 event
                expect(capturedEvent.kind).toBe(0);

                // Verify metadata tags are included
                const tags = capturedEvent.tags;

                // Check description tag
                const descriptionTag = tags.find((tag) => tag[0] === "description");
                expect(descriptionTag).toBeDefined();
                expect(descriptionTag?.[1]).toBe("A test agent that does testing");

                // Check instructions tag
                const instructionsTag = tags.find((tag) => tag[0] === "instructions");
                expect(instructionsTag).toBeDefined();
                expect(instructionsTag?.[1]).toBe("Follow these test instructions carefully");

                // Check use-criteria tag
                const useCriteriaTag = tags.find((tag) => tag[0] === "use-criteria");
                expect(useCriteriaTag).toBeDefined();
                expect(useCriteriaTag?.[1]).toBe("Use when testing is needed");

                // Verify no phase tags (phases have been removed)
                const phaseTags = tags.filter((tag) => tag[0] === "phase" && tag.length === 3);
                expect(phaseTags.length).toBe(0);

                // Check bot tag is present
                const botTag = tags.find((tag) => tag[0] === "bot" && tag.length === 1);
                expect(botTag).toBeDefined();

                // Check tenex tag is present
                const tenexTag = tags.find((tag) => tag[0] === "t" && tag[1] === "tenex");
                expect(tenexTag).toBeDefined();
            }
        });

        it("should NOT include metadata tags for agents WITH NDKAgentDefinition event ID", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const projectEvent = new NDKProject(getNDK());
            projectEvent.tagValue = mock(() => "Test Project");
            projectEvent.tagReference = mock(() => ["a", "31933:pubkey:d-tag"]);

            const agentMetadata = {
                description: "A test agent that does testing",
                instructions: "Follow these test instructions carefully",
                useCriteria: "Use when testing is needed",
            };

            const ndkAgentEventId = "a".repeat(64); // Valid hex event ID

            await AgentProfilePublisher.publishAgentProfile(
                signer,
                "TestAgent",
                "Tester",
                "Test Project",
                projectEvent,
                ndkAgentEventId, // Has NDKAgentDefinition event ID
                agentMetadata,
                [] // No whitelisted pubkeys for this test
            );

            expect(mockSign).toHaveBeenCalled();
            expect(mockPublish).toHaveBeenCalled();

            const capturedEvent = getKind0Event();
            expect(capturedEvent).toBeDefined();

            if (capturedEvent) {
                // Verify kind:0 event
                expect(capturedEvent.kind).toBe(0);

                // Verify metadata tags are NOT included
                const tags = capturedEvent.tags;

                // Should have e-tag for the NDKAgentDefinition
                const eTag = tags.find((tag) => tag[0] === "e");
                expect(eTag).toBeDefined();
                expect(eTag?.[1]).toBe(ndkAgentEventId);

                // Should NOT have metadata tags
                const descriptionTag = tags.find((tag) => tag[0] === "description");
                expect(descriptionTag).toBeUndefined();

                const instructionsTag = tags.find((tag) => tag[0] === "instructions");
                expect(instructionsTag).toBeUndefined();

                const useCriteriaTag = tags.find((tag) => tag[0] === "use-criteria");
                expect(useCriteriaTag).toBeUndefined();

                // Verify no phase tags
                const phaseTags = tags.filter((tag) => tag[0] === "phase" && tag.length === 3);
                expect(phaseTags.length).toBe(0);

                // Check bot and tenex tags are still present even with NDKAgentDefinition
                const botTag = tags.find((tag) => tag[0] === "bot" && tag.length === 1);
                expect(botTag).toBeDefined();

                const tenexTag = tags.find((tag) => tag[0] === "t" && tag[1] === "tenex");
                expect(tenexTag).toBeDefined();
            }
        });

        it("should NOT include e-tag for empty string agentDefinitionEventId", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const projectEvent = new NDKProject(getNDK());
            projectEvent.tagValue = mock(() => "Test Project");
            projectEvent.tagReference = mock(() => ["a", "31933:pubkey:d-tag"]);

            await AgentProfilePublisher.publishAgentProfile(
                signer,
                "TestAgent",
                "Tester",
                "Test Project",
                projectEvent,
                "", // Empty string
                undefined,
                []
            );

            const capturedEvent = getKind0Event();
            expect(capturedEvent).toBeDefined();

            if (capturedEvent) {
                const tags = capturedEvent.tags;
                const eTag = tags.find((tag) => tag[0] === "e");
                expect(eTag).toBeUndefined();
            }
        });

        it("should NOT include e-tag for whitespace-only agentDefinitionEventId", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const projectEvent = new NDKProject(getNDK());
            projectEvent.tagValue = mock(() => "Test Project");
            projectEvent.tagReference = mock(() => ["a", "31933:pubkey:d-tag"]);

            await AgentProfilePublisher.publishAgentProfile(
                signer,
                "TestAgent",
                "Tester",
                "Test Project",
                projectEvent,
                "   ", // Whitespace only
                undefined,
                []
            );

            const capturedEvent = getKind0Event();
            expect(capturedEvent).toBeDefined();

            if (capturedEvent) {
                const tags = capturedEvent.tags;
                const eTag = tags.find((tag) => tag[0] === "e");
                expect(eTag).toBeUndefined();
            }
        });

        it("should include metadata tags when agentDefinitionEventId is whitespace-only", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const projectEvent = new NDKProject(getNDK());
            projectEvent.tagValue = mock(() => "Test Project");
            projectEvent.tagReference = mock(() => ["a", "31933:pubkey:d-tag"]);

            const agentMetadata = {
                description: "A test agent",
                instructions: "Test instructions",
                useCriteria: "When testing",
            };

            await AgentProfilePublisher.publishAgentProfile(
                signer,
                "TestAgent",
                "Tester",
                "Test Project",
                projectEvent,
                "   ", // Whitespace only - should fallback to metadata tags
                agentMetadata,
                []
            );

            const capturedEvent = getKind0Event();
            expect(capturedEvent).toBeDefined();

            if (capturedEvent) {
                const tags = capturedEvent.tags;

                // Should NOT have e-tag
                const eTag = tags.find((tag) => tag[0] === "e");
                expect(eTag).toBeUndefined();

                // SHOULD have metadata tags (this was the bug - they were being lost)
                const descriptionTag = tags.find((tag) => tag[0] === "description");
                expect(descriptionTag).toBeDefined();
                expect(descriptionTag?.[1]).toBe("A test agent");

                const instructionsTag = tags.find((tag) => tag[0] === "instructions");
                expect(instructionsTag).toBeDefined();
                expect(instructionsTag?.[1]).toBe("Test instructions");

                const useCriteriaTag = tags.find((tag) => tag[0] === "use-criteria");
                expect(useCriteriaTag).toBeDefined();
                expect(useCriteriaTag?.[1]).toBe("When testing");
            }
        });

        it("should NOT include e-tag for invalid hex event ID (too short)", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const projectEvent = new NDKProject(getNDK());
            projectEvent.tagValue = mock(() => "Test Project");
            projectEvent.tagReference = mock(() => ["a", "31933:pubkey:d-tag"]);

            await AgentProfilePublisher.publishAgentProfile(
                signer,
                "TestAgent",
                "Tester",
                "Test Project",
                projectEvent,
                "abc123", // Too short, not 64 characters
                undefined,
                []
            );

            const capturedEvent = getKind0Event();
            expect(capturedEvent).toBeDefined();

            if (capturedEvent) {
                const tags = capturedEvent.tags;
                const eTag = tags.find((tag) => tag[0] === "e");
                expect(eTag).toBeUndefined();
            }
        });

        it("should NOT include e-tag for invalid hex event ID (non-hex characters)", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const projectEvent = new NDKProject(getNDK());
            projectEvent.tagValue = mock(() => "Test Project");
            projectEvent.tagReference = mock(() => ["a", "31933:pubkey:d-tag"]);

            // 64 characters but contains invalid hex characters (g, h, etc.)
            const invalidHexId = "ghijklmnghijklmnghijklmnghijklmnghijklmnghijklmnghijklmnghijklmn";

            await AgentProfilePublisher.publishAgentProfile(
                signer,
                "TestAgent",
                "Tester",
                "Test Project",
                projectEvent,
                invalidHexId,
                undefined,
                []
            );

            const capturedEvent = getKind0Event();
            expect(capturedEvent).toBeDefined();

            if (capturedEvent) {
                const tags = capturedEvent.tags;
                const eTag = tags.find((tag) => tag[0] === "e");
                expect(eTag).toBeUndefined();
            }
        });

        it("should include metadata tags when agentDefinitionEventId is invalid hex (too short)", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const projectEvent = new NDKProject(getNDK());
            projectEvent.tagValue = mock(() => "Test Project");
            projectEvent.tagReference = mock(() => ["a", "31933:pubkey:d-tag"]);

            const agentMetadata = {
                description: "A test agent for invalid hex",
                instructions: "Test instructions for fallback",
                useCriteria: "When hex validation fails",
            };

            await AgentProfilePublisher.publishAgentProfile(
                signer,
                "TestAgent",
                "Tester",
                "Test Project",
                projectEvent,
                "abc123", // Too short - should fallback to metadata tags
                agentMetadata,
                []
            );

            const capturedEvent = getKind0Event();
            expect(capturedEvent).toBeDefined();

            if (capturedEvent) {
                const tags = capturedEvent.tags;

                // Should NOT have e-tag
                const eTag = tags.find((tag) => tag[0] === "e");
                expect(eTag).toBeUndefined();

                // SHOULD have metadata tags (fallback when ID is invalid)
                const descriptionTag = tags.find((tag) => tag[0] === "description");
                expect(descriptionTag).toBeDefined();
                expect(descriptionTag?.[1]).toBe("A test agent for invalid hex");

                const instructionsTag = tags.find((tag) => tag[0] === "instructions");
                expect(instructionsTag).toBeDefined();
                expect(instructionsTag?.[1]).toBe("Test instructions for fallback");

                const useCriteriaTag = tags.find((tag) => tag[0] === "use-criteria");
                expect(useCriteriaTag).toBeDefined();
                expect(useCriteriaTag?.[1]).toBe("When hex validation fails");
            }
        });

        it("should include metadata tags when agentDefinitionEventId has invalid characters", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const projectEvent = new NDKProject(getNDK());
            projectEvent.tagValue = mock(() => "Test Project");
            projectEvent.tagReference = mock(() => ["a", "31933:pubkey:d-tag"]);

            const agentMetadata = {
                description: "Agent with invalid chars in ID",
                instructions: "Should fallback gracefully",
            };

            // 64 characters but contains invalid hex characters
            const invalidHexId = "ghijklmnghijklmnghijklmnghijklmnghijklmnghijklmnghijklmnghijklmn";

            await AgentProfilePublisher.publishAgentProfile(
                signer,
                "TestAgent",
                "Tester",
                "Test Project",
                projectEvent,
                invalidHexId, // Invalid hex - should fallback to metadata tags
                agentMetadata,
                []
            );

            const capturedEvent = getKind0Event();
            expect(capturedEvent).toBeDefined();

            if (capturedEvent) {
                const tags = capturedEvent.tags;

                // Should NOT have e-tag
                const eTag = tags.find((tag) => tag[0] === "e");
                expect(eTag).toBeUndefined();

                // SHOULD have metadata tags (fallback when ID has invalid chars)
                const descriptionTag = tags.find((tag) => tag[0] === "description");
                expect(descriptionTag).toBeDefined();
                expect(descriptionTag?.[1]).toBe("Agent with invalid chars in ID");

                const instructionsTag = tags.find((tag) => tag[0] === "instructions");
                expect(instructionsTag).toBeDefined();
                expect(instructionsTag?.[1]).toBe("Should fallback gracefully");
            }
        });

        it("should trim whitespace from valid agentDefinitionEventId", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const projectEvent = new NDKProject(getNDK());
            projectEvent.tagValue = mock(() => "Test Project");
            projectEvent.tagReference = mock(() => ["a", "31933:pubkey:d-tag"]);

            const validEventId = "a".repeat(64);
            const eventIdWithWhitespace = `  ${validEventId}  `;

            await AgentProfilePublisher.publishAgentProfile(
                signer,
                "TestAgent",
                "Tester",
                "Test Project",
                projectEvent,
                eventIdWithWhitespace, // Valid ID with surrounding whitespace
                undefined,
                []
            );

            const capturedEvent = getKind0Event();
            expect(capturedEvent).toBeDefined();

            if (capturedEvent) {
                const tags = capturedEvent.tags;
                const eTag = tags.find((tag) => tag[0] === "e");
                expect(eTag).toBeDefined();
                expect(eTag?.[1]).toBe(validEventId); // Should be trimmed
            }
        });

        it("should handle partial metadata gracefully", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const projectEvent = new NDKProject(getNDK());
            projectEvent.tagValue = mock(() => "Test Project");
            projectEvent.tagReference = mock(() => ["a", "31933:pubkey:d-tag"]);

            const agentMetadata = {
                description: "A test agent that does testing",
                // No instructions or useCriteria
            };

            await AgentProfilePublisher.publishAgentProfile(
                signer,
                "TestAgent",
                "Tester",
                "Test Project",
                projectEvent,
                undefined, // No NDKAgentDefinition event ID
                agentMetadata,
                [] // No whitelisted pubkeys for this test
            );

            expect(mockSign).toHaveBeenCalled();
            expect(mockPublish).toHaveBeenCalled();

            const capturedEvent = getKind0Event();
            expect(capturedEvent).toBeDefined();

            if (capturedEvent) {
                const tags = capturedEvent.tags;

                // Check only description tag is included
                const descriptionTag = tags.find((tag) => tag[0] === "description");
                expect(descriptionTag).toBeDefined();
                expect(descriptionTag?.[1]).toBe("A test agent that does testing");

                // Other tags should not be present
                const instructionsTag = tags.find((tag) => tag[0] === "instructions");
                expect(instructionsTag).toBeUndefined();

                const useCriteriaTag = tags.find((tag) => tag[0] === "use-criteria");
                expect(useCriteriaTag).toBeUndefined();

                const phaseTags = tags.filter((tag) => tag[0] === "phase" && tag.length === 3);
                expect(phaseTags.length).toBe(0);
            }
        });
    });

    it("should include p-tags for whitelisted pubkeys", async () => {
        const signer = NDKPrivateKeySigner.generate();
        const projectEvent = new NDKProject(getNDK());
        projectEvent.tagValue = mock(() => "Test Project");
        projectEvent.tagReference = mock(() => ["a", "31933:pubkey:d-tag"]);

        const whitelistedPubkeys = [
            "pubkey1234567890abcdef",
            "pubkey0987654321fedcba",
            signer.pubkey, // This should be filtered out
        ];

        await AgentProfilePublisher.publishAgentProfile(
            signer,
            "TestAgent",
            "Tester",
            "Test Project",
            projectEvent,
            undefined,
            undefined,
            whitelistedPubkeys
        );

        expect(mockSign).toHaveBeenCalled();
        expect(mockPublish).toHaveBeenCalled();

        const capturedEvent = getKind0Event();
        expect(capturedEvent).toBeDefined();

        if (capturedEvent) {
            const tags = capturedEvent.tags;

            // Check p-tags for whitelisted pubkeys (excluding self)
            const pTags = tags.filter((tag) => tag[0] === "p");
            expect(pTags.length).toBe(2); // Should not include agent's own pubkey
            expect(pTags.some((tag) => tag[1] === "pubkey1234567890abcdef")).toBe(true);
            expect(pTags.some((tag) => tag[1] === "pubkey0987654321fedcba")).toBe(true);
            expect(pTags.some((tag) => tag[1] === signer.pubkey)).toBe(false); // Should not p-tag self

            // Check bot tag is present
            const botTag = tags.find((tag) => tag[0] === "bot" && tag.length === 1);
            expect(botTag).toBeDefined();

            // Check tenex tag is present
            const tenexTag = tags.find((tag) => tag[0] === "t" && tag[1] === "tenex");
            expect(tenexTag).toBeDefined();
        }
    });

    describe("a-tag handling", () => {
        it("should tag current project via tagReference", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const projectEvent = new NDKProject(getNDK());
            const ownerPubkey = "09d48a1a5dbe13404a729634f1d6ba722d40513468dd713c8ea38ca9b7b6f2c7";
            const currentDTag = "CurrentProject-abc123";

            projectEvent.tagValue = mock((key: string) => {
                if (key === "title") return "Test Project";
                if (key === "d") return currentDTag;
                return undefined;
            });
            projectEvent.dTag = currentDTag;
            projectEvent.pubkey = ownerPubkey;
            projectEvent.tagReference = mock(() => ["a", `31933:${ownerPubkey}:${currentDTag}`]);

            await AgentProfilePublisher.publishAgentProfile(
                signer,
                "TestAgent",
                "Tester",
                "Test Project",
                projectEvent,
                undefined,
                undefined,
                []
            );

            const capturedEvent = getKind0Event();
            expect(capturedEvent).toBeDefined();

            if (capturedEvent) {
                const aTags = capturedEvent.tags.filter((tag) => tag[0] === "a");

                // Should have exactly 1 a-tag (current project only)
                // Note: We only tag the CURRENT project. Multi-project agents
                // get their a-tags when profiles are republished in each project context.
                expect(aTags.length).toBe(1);

                // Verify proper NIP-01 addressable coordinate format
                const currentProjectTag = aTags[0];
                expect(currentProjectTag[1]).toBe(`31933:${ownerPubkey}:${currentDTag}`);

                // Verify NO invalid a-tags with just slug
                const invalidATags = aTags.filter((tag) =>
                    !tag[1].includes(":") // Valid a-tag values must contain colons
                );
                expect(invalidATags.length).toBe(0);
            }
        });

        it("should skip a-tag when projectEvent.pubkey is missing", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const projectEvent = new NDKProject(getNDK());
            const currentDTag = "TestProject";

            projectEvent.tagValue = mock((key: string) => {
                if (key === "title") return "Test Project";
                if (key === "d") return currentDTag;
                return undefined;
            });
            projectEvent.dTag = currentDTag;
            // Intentionally NOT setting projectEvent.pubkey
            projectEvent.pubkey = undefined as unknown as string;
            projectEvent.tagReference = mock(() => ["a", `31933:undefined:${currentDTag}`]);

            await AgentProfilePublisher.publishAgentProfile(
                signer,
                "TestAgent",
                "Tester",
                "Test Project",
                projectEvent,
                undefined,
                undefined,
                []
            );

            const capturedEvent = getKind0Event();
            expect(capturedEvent).toBeDefined();

            if (capturedEvent) {
                const aTags = capturedEvent.tags.filter((tag) => tag[0] === "a");

                // Should have NO a-tags when pubkey is missing
                expect(aTags.length).toBe(0);
            }
        });

        it("should skip a-tag when projectEvent.dTag is missing", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const projectEvent = new NDKProject(getNDK());
            const ownerPubkey = "09d48a1a5dbe13404a729634f1d6ba722d40513468dd713c8ea38ca9b7b6f2c7";

            projectEvent.tagValue = mock((key: string) => {
                if (key === "title") return "Test Project";
                return undefined; // No d-tag
            });
            // Intentionally NOT setting projectEvent.dTag
            projectEvent.dTag = undefined as unknown as string;
            projectEvent.pubkey = ownerPubkey;
            // tagReference would produce invalid a-tag like "31933:pubkey:" (empty d-tag)
            projectEvent.tagReference = mock(() => ["a", `31933:${ownerPubkey}:`]);

            await AgentProfilePublisher.publishAgentProfile(
                signer,
                "TestAgent",
                "Tester",
                "Test Project",
                projectEvent,
                undefined,
                undefined,
                []
            );

            const capturedEvent = getKind0Event();
            expect(capturedEvent).toBeDefined();

            if (capturedEvent) {
                const aTags = capturedEvent.tags.filter((tag) => tag[0] === "a");

                // Should have NO a-tags when d-tag is missing
                expect(aTags.length).toBe(0);
            }
        });

        it("should skip a-tag when projectEvent.dTag is empty string", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const projectEvent = new NDKProject(getNDK());
            const ownerPubkey = "09d48a1a5dbe13404a729634f1d6ba722d40513468dd713c8ea38ca9b7b6f2c7";

            projectEvent.tagValue = mock((key: string) => {
                if (key === "title") return "Test Project";
                if (key === "d") return "";
                return undefined;
            });
            // Empty string d-tag (falsy but different from undefined)
            projectEvent.dTag = "";
            projectEvent.pubkey = ownerPubkey;
            projectEvent.tagReference = mock(() => ["a", `31933:${ownerPubkey}:`]);

            await AgentProfilePublisher.publishAgentProfile(
                signer,
                "TestAgent",
                "Tester",
                "Test Project",
                projectEvent,
                undefined,
                undefined,
                []
            );

            const capturedEvent = getKind0Event();
            expect(capturedEvent).toBeDefined();

            if (capturedEvent) {
                const aTags = capturedEvent.tags.filter((tag) => tag[0] === "a");

                // Should have NO a-tags when d-tag is empty
                expect(aTags.length).toBe(0);
            }
        });

        it("should produce valid a-tag format with proper NIP-01 addressable coordinate", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const projectEvent = new NDKProject(getNDK());
            const ownerPubkey = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
            const currentDTag = "my-project-slug";

            projectEvent.tagValue = mock((key: string) => {
                if (key === "title") return "My Project";
                if (key === "d") return currentDTag;
                return undefined;
            });
            projectEvent.dTag = currentDTag;
            projectEvent.pubkey = ownerPubkey;
            // Simulate what NDKProject.tagReference would return
            projectEvent.tagReference = mock(() => ["a", `31933:${ownerPubkey}:${currentDTag}`]);

            await AgentProfilePublisher.publishAgentProfile(
                signer,
                "TestAgent",
                "Tester",
                "My Project",
                projectEvent,
                undefined,
                undefined,
                []
            );

            const capturedEvent = getKind0Event();
            expect(capturedEvent).toBeDefined();

            if (capturedEvent) {
                const aTags = capturedEvent.tags.filter((tag) => tag[0] === "a");
                expect(aTags.length).toBe(1);

                const aTag = aTags[0];
                // Verify format: ["a", "31933:<pubkey>:<d-tag>"]
                expect(aTag[0]).toBe("a");
                expect(aTag[1]).toMatch(/^31933:[a-f0-9]+:[a-z0-9-]+$/);
                expect(aTag[1]).toBe(`31933:${ownerPubkey}:${currentDTag}`);
            }
        });
    });
});
