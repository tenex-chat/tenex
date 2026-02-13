import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import type { StoredAgent } from "@/agents/AgentStorage";

/**
 * Integration tests for EscalationService.
 *
 * These tests verify the complete escalation agent resolution and auto-add flow,
 * including:
 * - Config reading
 * - Project membership checks via resolveRecipientToPubkey
 * - Auto-adding from global storage
 * - Registry and daemon notification integration
 */

// Create mock functions for all dependencies
const mockGetConfig = mock(() => ({ escalation: { agent: "test-escalation-agent" } }));
const mockResolveRecipientToPubkey = mock((_slug: string) => null as string | null);
const mockIsProjectContextInitialized = mock(() => true);

// Mock registry and project context
const mockAddAgent = mock(() => {});
const mockNotifyAgentAdded = mock(() => {});
const mockGetProjectDTag = mock(() => "test-project-dtag" as string | undefined);
const mockGetBasePath = mock(() => "/test/path");
const mockGetMetadataPath = mock(() => "/test/metadata");

const mockAgentRegistry = {
    addAgent: mockAddAgent,
    getProjectDTag: mockGetProjectDTag,
    getBasePath: mockGetBasePath,
    getMetadataPath: mockGetMetadataPath,
};

const mockProjectContext = {
    agentRegistry: mockAgentRegistry,
    notifyAgentAdded: mockNotifyAgentAdded,
};

const mockGetProjectContext = mock(() => mockProjectContext);

// Mock AgentStorage
const mockGetAgentBySlug = mock((_slug: string) => null as StoredAgent | null);
const mockAddAgentToProject = mock((_pubkey: string, _projectDTag: string) => Promise.resolve());
const mockLoadAgent = mock((_pubkey: string) => null as StoredAgent | null);

const mockAgentStorage = {
    getAgentBySlug: mockGetAgentBySlug,
    addAgentToProject: mockAddAgentToProject,
    loadAgent: mockLoadAgent,
};

// Mock createAgentInstance
const mockCreateAgentInstance = mock((storedAgent: StoredAgent, _registry: unknown) => ({
    slug: storedAgent.slug,
    name: storedAgent.name,
    pubkey: "mock-pubkey",
    role: storedAgent.role,
}));

// Set up module mocks before importing EscalationService
mock.module("@/services/ConfigService", () => ({
    config: {
        getConfig: mockGetConfig,
        getConfigPath: () => "/tmp/test",
    },
}));

mock.module("@/services/agents/AgentResolution", () => ({
    resolveRecipientToPubkey: mockResolveRecipientToPubkey,
}));

mock.module("@/services/projects", () => ({
    getProjectContext: mockGetProjectContext,
    isProjectContextInitialized: mockIsProjectContextInitialized,
}));

mock.module("@/agents/AgentStorage", () => ({
    agentStorage: mockAgentStorage,
}));

mock.module("@/agents/agent-loader", () => ({
    createAgentInstance: mockCreateAgentInstance,
}));

mock.module("@/utils/logger", () => ({
    logger: {
        debug: mock(),
        info: mock(),
        warn: mock(),
        error: mock(),
    },
}));

// Now import the service after mocks are set up
import { resolveEscalationTarget, getConfiguredEscalationAgent, loadEscalationAgentIntoRegistry } from "../EscalationService";

describe("EscalationService", () => {
    let testSigner: NDKPrivateKeySigner;
    let testStoredAgent: StoredAgent;

    beforeEach(() => {
        // Create a test signer for the escalation agent
        testSigner = NDKPrivateKeySigner.generate();

        // Create a test stored agent
        testStoredAgent = {
            nsec: testSigner.nsec,
            slug: "test-escalation-agent",
            name: "Test Escalation Agent",
            role: "escalation",
            projects: [],
        };

        // Reset all mocks
        mockGetConfig.mockClear();
        mockResolveRecipientToPubkey.mockClear();
        mockIsProjectContextInitialized.mockClear();
        mockAddAgent.mockClear();
        mockNotifyAgentAdded.mockClear();
        mockGetProjectDTag.mockClear();
        mockGetProjectContext.mockClear();
        mockGetAgentBySlug.mockClear();
        mockAddAgentToProject.mockClear();
        mockLoadAgent.mockClear();
        mockCreateAgentInstance.mockClear();

        // Set up default mock returns
        mockGetConfig.mockReturnValue({ escalation: { agent: "test-escalation-agent" } });
        mockResolveRecipientToPubkey.mockReturnValue(null);
        mockIsProjectContextInitialized.mockReturnValue(true);
        mockGetProjectDTag.mockReturnValue("test-project-dtag");
        mockGetAgentBySlug.mockReturnValue(null);
        mockLoadAgent.mockReturnValue(null);
    });

    afterEach(() => {
        // Clean up
    });

    describe("getConfiguredEscalationAgent", () => {
        it("should return escalation agent slug when configured", () => {
            mockGetConfig.mockReturnValue({ escalation: { agent: "my-escalation-agent" } });

            const result = getConfiguredEscalationAgent();

            expect(result).toBe("my-escalation-agent");
        });

        it("should return null when no escalation config", () => {
            mockGetConfig.mockReturnValue({});

            const result = getConfiguredEscalationAgent();

            expect(result).toBeNull();
        });

        it("should return null when escalation.agent is not set", () => {
            mockGetConfig.mockReturnValue({ escalation: {} });

            const result = getConfiguredEscalationAgent();

            expect(result).toBeNull();
        });

        it("should return null when config throws", () => {
            mockGetConfig.mockImplementation(() => {
                throw new Error("Config not loaded");
            });

            const result = getConfiguredEscalationAgent();

            expect(result).toBeNull();
        });
    });

    describe("resolveEscalationTarget", () => {
        describe("when no escalation agent configured", () => {
            it("should return null when escalation.agent is not set", async () => {
                mockGetConfig.mockReturnValue({});

                const result = await resolveEscalationTarget();

                expect(result).toBeNull();
            });

            it("should return null when escalation config is missing", async () => {
                mockGetConfig.mockReturnValue({ someOtherConfig: true });

                const result = await resolveEscalationTarget();

                expect(result).toBeNull();
            });
        });

        describe("when escalation agent already in project (fast path)", () => {
            it("should return slug without auto-add when agent exists in project", async () => {
                const existingPubkey = "existing-agent-pubkey";
                mockGetConfig.mockReturnValue({ escalation: { agent: "existing-escalation-agent" } });
                mockResolveRecipientToPubkey.mockReturnValue(existingPubkey);

                const result = await resolveEscalationTarget();

                expect(result).toEqual({
                    slug: "existing-escalation-agent",
                    wasAutoAdded: false,
                });
                // Should not have called addAgent since agent already exists
                expect(mockAddAgent).not.toHaveBeenCalled();
                expect(mockNotifyAgentAdded).not.toHaveBeenCalled();
            });

            it("should not query storage when agent is already in project", async () => {
                mockResolveRecipientToPubkey.mockReturnValue("existing-pubkey");

                await resolveEscalationTarget();

                // Storage should not be queried when agent is in project
                expect(mockGetAgentBySlug).not.toHaveBeenCalled();
            });
        });

        describe("when escalation agent needs auto-add", () => {
            beforeEach(() => {
                // Set up: agent exists in global storage but NOT in current project
                mockResolveRecipientToPubkey.mockReturnValue(null); // Not in project
                mockGetAgentBySlug.mockReturnValue(testStoredAgent);
                mockLoadAgent.mockReturnValue({
                    ...testStoredAgent,
                    projects: ["test-project-dtag"], // After being added to project
                });
            });

            it("should auto-add agent when found in storage but not in project", async () => {
                const result = await resolveEscalationTarget();

                expect(result).toEqual({
                    slug: "test-escalation-agent",
                    wasAutoAdded: true,
                });
            });

            it("should query storage by slug when agent not in project", async () => {
                await resolveEscalationTarget();

                expect(mockGetAgentBySlug).toHaveBeenCalledWith("test-escalation-agent");
            });

            it("should add agent to project in storage when auto-added", async () => {
                await resolveEscalationTarget();

                expect(mockAddAgentToProject).toHaveBeenCalledTimes(1);
                expect(mockAddAgentToProject).toHaveBeenCalledWith(
                    testSigner.pubkey,
                    "test-project-dtag"
                );
            });

            it("should reload agent after adding to project", async () => {
                await resolveEscalationTarget();

                expect(mockLoadAgent).toHaveBeenCalledTimes(1);
                expect(mockLoadAgent).toHaveBeenCalledWith(testSigner.pubkey);
            });

            it("should create agent instance with correct data", async () => {
                await resolveEscalationTarget();

                expect(mockCreateAgentInstance).toHaveBeenCalledTimes(1);
                const [storedAgent, registry] = mockCreateAgentInstance.mock.calls[0];
                expect(storedAgent.slug).toBe("test-escalation-agent");
                expect(registry).toBe(mockAgentRegistry);
            });

            it("should add agent to registry when auto-added", async () => {
                await resolveEscalationTarget();

                expect(mockAddAgent).toHaveBeenCalledTimes(1);
                // Verify the agent instance was created with correct slug
                const addedAgent = mockAddAgent.mock.calls[0][0];
                expect(addedAgent.slug).toBe("test-escalation-agent");
            });

            it("should notify daemon when agent is auto-added", async () => {
                await resolveEscalationTarget();

                expect(mockNotifyAgentAdded).toHaveBeenCalledTimes(1);
                const notifiedAgent = mockNotifyAgentAdded.mock.calls[0][0];
                expect(notifiedAgent.slug).toBe("test-escalation-agent");
            });
        });

        describe("when escalation agent does not exist anywhere", () => {
            it("should return null when agent not found in storage", async () => {
                mockGetConfig.mockReturnValue({ escalation: { agent: "nonexistent-agent" } });
                mockResolveRecipientToPubkey.mockReturnValue(null);
                mockGetAgentBySlug.mockReturnValue(null);

                const result = await resolveEscalationTarget();

                expect(result).toBeNull();
                expect(mockAddAgent).not.toHaveBeenCalled();
            });
        });

        describe("edge cases", () => {
            it("should return null when project context is not initialized", async () => {
                mockResolveRecipientToPubkey.mockReturnValue(null);
                mockIsProjectContextInitialized.mockReturnValue(false);
                mockGetAgentBySlug.mockReturnValue(testStoredAgent);

                const result = await resolveEscalationTarget();

                expect(result).toBeNull();
                expect(mockAddAgent).not.toHaveBeenCalled();
            });

            it("should return null when no project dTag available", async () => {
                mockResolveRecipientToPubkey.mockReturnValue(null);
                mockGetProjectDTag.mockReturnValue(undefined);
                mockGetAgentBySlug.mockReturnValue(testStoredAgent);

                const result = await resolveEscalationTarget();

                expect(result).toBeNull();
                expect(mockAddAgent).not.toHaveBeenCalled();
            });

            it("should return null when agent reload fails after adding to project", async () => {
                mockResolveRecipientToPubkey.mockReturnValue(null);
                mockGetAgentBySlug.mockReturnValue(testStoredAgent);
                mockLoadAgent.mockReturnValue(null); // Reload fails

                const result = await resolveEscalationTarget();

                expect(result).toBeNull();
                // addAgentToProject should have been called
                expect(mockAddAgentToProject).toHaveBeenCalled();
                // But registry should not have been updated
                expect(mockAddAgent).not.toHaveBeenCalled();
            });

            it("should handle config.getConfig throwing gracefully", async () => {
                mockGetConfig.mockImplementation(() => {
                    throw new Error("Config not loaded");
                });

                const result = await resolveEscalationTarget();

                expect(result).toBeNull();
            });

            it("should handle unexpected errors gracefully", async () => {
                mockGetConfig.mockImplementation(() => {
                    throw new Error("Some unexpected error");
                });

                const result = await resolveEscalationTarget();

                expect(result).toBeNull();
            });
        });
    });

    describe("multi-project scenarios", () => {
        it("should add escalation agent only to the current project", async () => {
            mockResolveRecipientToPubkey.mockReturnValue(null);
            mockGetProjectDTag.mockReturnValue("project-b");
            mockGetAgentBySlug.mockReturnValue({
                ...testStoredAgent,
                projects: ["project-a"], // Already in project-a
            });
            mockLoadAgent.mockReturnValue({
                ...testStoredAgent,
                projects: ["project-a", "project-b"],
            });

            await resolveEscalationTarget();

            // Should add to project-b (current project)
            expect(mockAddAgentToProject).toHaveBeenCalledWith(
                testSigner.pubkey,
                "project-b"
            );
        });

        it("should be idempotent - second call should not duplicate work when agent already in project", async () => {
            // First call - agent not in project
            mockResolveRecipientToPubkey.mockReturnValue(null);
            mockGetAgentBySlug.mockReturnValue(testStoredAgent);
            mockLoadAgent.mockReturnValue({
                ...testStoredAgent,
                projects: ["test-project-dtag"],
            });

            await resolveEscalationTarget();

            // Verify first call did the work
            expect(mockAddAgentToProject).toHaveBeenCalledTimes(1);
            expect(mockAddAgent).toHaveBeenCalledTimes(1);

            // Reset mocks for second call
            mockAddAgentToProject.mockClear();
            mockAddAgent.mockClear();
            mockNotifyAgentAdded.mockClear();

            // Now simulate agent being in project (after first auto-add)
            mockResolveRecipientToPubkey.mockReturnValue(testSigner.pubkey);

            // Second call - should find agent already in project
            const result = await resolveEscalationTarget();

            expect(result).toEqual({
                slug: "test-escalation-agent",
                wasAutoAdded: false,
            });
            // Should not call addAgentToProject or addAgent again
            expect(mockAddAgentToProject).not.toHaveBeenCalled();
            expect(mockAddAgent).not.toHaveBeenCalled();
        });
    });
});

describe("loadEscalationAgentIntoRegistry", () => {
    let testSigner: NDKPrivateKeySigner;
    let testStoredAgent: StoredAgent;
    // Use partial mock that's cast to AgentRegistry for testing
    const mockGetAgent = mock(() => null as unknown);
    const mockAddAgentLocal = mock(() => {});
    const mockGetBasePathLocal = mock(() => "/test/path");
    const mockGetMetadataPathLocal = mock(() => "/test/metadata");

    // Cast to AgentRegistry for function calls - the mock has the required methods
    const mockRegistry = {
        getAgent: mockGetAgent,
        addAgent: mockAddAgentLocal,
        getBasePath: mockGetBasePathLocal,
        getMetadataPath: mockGetMetadataPathLocal,
    } as unknown as Parameters<typeof loadEscalationAgentIntoRegistry>[0];

    beforeEach(() => {
        // Create a test signer for the escalation agent
        testSigner = NDKPrivateKeySigner.generate();

        // Create a test stored agent
        testStoredAgent = {
            nsec: testSigner.nsec,
            slug: "test-escalation-agent",
            name: "Test Escalation Agent",
            role: "escalation",
            projects: [],
        };

        // Reset local mocks
        mockGetAgent.mockClear();
        mockAddAgentLocal.mockClear();
        mockGetBasePathLocal.mockClear();
        mockGetMetadataPathLocal.mockClear();

        // Set default returns
        mockGetAgent.mockReturnValue(null);

        // Reset all mocks
        mockGetConfig.mockClear();
        mockGetAgentBySlug.mockClear();
        mockAddAgentToProject.mockClear();
        mockLoadAgent.mockClear();
        mockCreateAgentInstance.mockClear();

        // Set up default mock returns
        mockGetConfig.mockReturnValue({ escalation: { agent: "test-escalation-agent" } });
        mockGetAgentBySlug.mockReturnValue(null);
        mockLoadAgent.mockReturnValue(null);
    });

    describe("when no escalation agent configured", () => {
        it("should return false when escalation.agent is not set", async () => {
            mockGetConfig.mockReturnValue({});

            const result = await loadEscalationAgentIntoRegistry(mockRegistry, "test-project");

            expect(result).toBe(false);
            expect(mockAddAgentLocal).not.toHaveBeenCalled();
        });

        it("should return false when escalation config is missing", async () => {
            mockGetConfig.mockReturnValue({ someOtherConfig: true });

            const result = await loadEscalationAgentIntoRegistry(mockRegistry, "test-project");

            expect(result).toBe(false);
        });
    });

    describe("when escalation agent already in registry (fast path)", () => {
        it("should return true without loading when agent exists in registry", async () => {
            mockGetAgent.mockReturnValue({ slug: "test-escalation-agent" });

            const result = await loadEscalationAgentIntoRegistry(mockRegistry, "test-project");

            expect(result).toBe(true);
            expect(mockGetAgentBySlug).not.toHaveBeenCalled();
            expect(mockAddAgentLocal).not.toHaveBeenCalled();
        });
    });

    describe("when escalation agent needs loading", () => {
        beforeEach(() => {
            mockGetAgent.mockReturnValue(null); // Not in registry
            mockGetAgentBySlug.mockReturnValue(testStoredAgent);
            mockLoadAgent.mockReturnValue({
                ...testStoredAgent,
                projects: ["test-project"],
            });
        });

        it("should load agent when found in storage but not in registry", async () => {
            const result = await loadEscalationAgentIntoRegistry(mockRegistry, "test-project");

            expect(result).toBe(true);
        });

        it("should query storage by slug when agent not in registry", async () => {
            await loadEscalationAgentIntoRegistry(mockRegistry, "test-project");

            expect(mockGetAgentBySlug).toHaveBeenCalledWith("test-escalation-agent");
        });

        it("should add agent to project in storage", async () => {
            await loadEscalationAgentIntoRegistry(mockRegistry, "test-project");

            expect(mockAddAgentToProject).toHaveBeenCalledWith(
                testSigner.pubkey,
                "test-project"
            );
        });

        it("should reload agent after adding to project", async () => {
            await loadEscalationAgentIntoRegistry(mockRegistry, "test-project");

            expect(mockLoadAgent).toHaveBeenCalledWith(testSigner.pubkey);
        });

        it("should create agent instance with correct data", async () => {
            await loadEscalationAgentIntoRegistry(mockRegistry, "test-project");

            expect(mockCreateAgentInstance).toHaveBeenCalledTimes(1);
            const [storedAgent, registry] = mockCreateAgentInstance.mock.calls[0];
            expect(storedAgent.slug).toBe("test-escalation-agent");
            expect(registry).toBe(mockRegistry);
        });

        it("should add agent to registry", async () => {
            await loadEscalationAgentIntoRegistry(mockRegistry, "test-project");

            expect(mockAddAgentLocal).toHaveBeenCalledTimes(1);
            const addedAgent = mockAddAgentLocal.mock.calls[0][0];
            expect(addedAgent.slug).toBe("test-escalation-agent");
        });
    });

    describe("when escalation agent does not exist in storage", () => {
        it("should return false when agent not found in storage", async () => {
            mockGetAgent.mockReturnValue(null);
            mockGetAgentBySlug.mockReturnValue(null);

            const result = await loadEscalationAgentIntoRegistry(mockRegistry, "test-project");

            expect(result).toBe(false);
            expect(mockAddAgentLocal).not.toHaveBeenCalled();
        });
    });

    describe("edge cases", () => {
        it("should return false when agent reload fails after adding to project", async () => {
            mockGetAgent.mockReturnValue(null);
            mockGetAgentBySlug.mockReturnValue(testStoredAgent);
            mockLoadAgent.mockReturnValue(null); // Reload fails

            const result = await loadEscalationAgentIntoRegistry(mockRegistry, "test-project");

            expect(result).toBe(false);
            expect(mockAddAgentToProject).toHaveBeenCalled();
            expect(mockAddAgentLocal).not.toHaveBeenCalled();
        });

        it("should handle config.getConfig throwing gracefully", async () => {
            mockGetConfig.mockImplementation(() => {
                throw new Error("Config not loaded");
            });

            const result = await loadEscalationAgentIntoRegistry(mockRegistry, "test-project");

            expect(result).toBe(false);
        });

        it("should handle unexpected errors gracefully", async () => {
            mockGetConfig.mockImplementation(() => {
                throw new Error("Some unexpected error");
            });

            const result = await loadEscalationAgentIntoRegistry(mockRegistry, "test-project");

            expect(result).toBe(false);
        });
    });

    describe("idempotency", () => {
        it("should be idempotent - storage add is idempotent", async () => {
            mockGetAgent.mockReturnValue(null);
            mockGetAgentBySlug.mockReturnValue(testStoredAgent);
            mockLoadAgent.mockReturnValue({
                ...testStoredAgent,
                projects: ["test-project"],
            });

            // First call
            await loadEscalationAgentIntoRegistry(mockRegistry, "test-project");

            expect(mockAddAgentToProject).toHaveBeenCalledTimes(1);

            // Reset mocks
            mockAddAgentToProject.mockClear();
            mockAddAgentLocal.mockClear();

            // Simulate agent now being in registry
            mockGetAgent.mockReturnValue({ slug: "test-escalation-agent" });

            // Second call - should skip loading since agent is in registry
            const result = await loadEscalationAgentIntoRegistry(mockRegistry, "test-project");

            expect(result).toBe(true);
            expect(mockAddAgentToProject).not.toHaveBeenCalled();
            expect(mockAddAgentLocal).not.toHaveBeenCalled();
        });
    });
});
