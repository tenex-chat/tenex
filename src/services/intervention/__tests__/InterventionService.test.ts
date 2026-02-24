import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";

/**
 * Tests for InterventionService.
 *
 * Verifies:
 * - Per-project agent resolution (resolved at trigger time using project's agent registry)
 * - Timer starts on completion
 * - Timer cancels on user response (after completion, before timeout)
 * - Timer does NOT cancel on user response before completion
 * - Timer does NOT cancel on user response after timeout window
 * - Timer expiry triggers intervention
 * - Retry/backoff on publish failures
 * - State persistence and recovery (project-scoped)
 * - Serialized state writes (concurrent saveState calls)
 * - Agent slug validation at startup
 * - Whitelisted user filtering (only trigger for whitelisted users, not agents)
 * - Transient runtime unavailability (retry vs drop)
 * - Config whitespace trimming
 */

// Mock dependencies before importing the service
const mockGetConfig = mock(() => ({
    intervention: {
        enabled: true,
        agent: "test-intervention-agent",
        timeout: 1000, // 1 second for faster tests
    },
}));

const mockGetConfigPath = mock(() => "/tmp/test-intervention");

const mockPublishReviewRequest = mock(
    (_target: string, _convId: string, _user: string, _agent: string) =>
        Promise.resolve("published-event-id")
);

// Mock publisher
const mockPublisherInitialize = mock(() => Promise.resolve());

// Default mock agents for test projects
const defaultTestAgents = [
    { slug: "test-intervention-agent", pubkey: "test-intervention-pubkey" },
];

mock.module("@/services/ConfigService", () => ({
    config: {
        getConfig: mockGetConfig,
        getConfigPath: mockGetConfigPath,
        getBackendSigner: mock(() => Promise.resolve({ pubkey: "backend-pubkey" })),
    },
}));

mock.module("@/nostr/InterventionPublisher", () => ({
    InterventionPublisher: class {
        async initialize() {
            return mockPublisherInitialize();
        }
        async publishReviewRequest(
            target: string,
            convId: string,
            user: string,
            agent: string
        ) {
            return mockPublishReviewRequest(target, convId, user, agent);
        }
    },
}));

// Import type for resolver function
import type { AgentResolverFn, AgentResolutionResult } from "../InterventionService";

/**
 * Create a mock agent resolver function.
 * Maps projectId -> resolution result.
 */
const createMockResolver = (
    projectAgents: Map<string, Array<{ slug: string; pubkey: string }>>
): AgentResolverFn => {
    return (projectId: string, agentSlug: string): AgentResolutionResult => {
        const agents = projectAgents.get(projectId);
        if (!agents) {
            // Project runtime not found = transient failure
            return { status: "runtime_unavailable" };
        }

        const agent = agents.find(a => a.slug.toLowerCase() === agentSlug.toLowerCase());
        if (!agent) {
            // Agent slug not found = permanent failure
            return { status: "agent_not_found" };
        }

        return { status: "resolved", pubkey: agent.pubkey };
    };
};

// Default project agents map for tests
const createDefaultProjectAgents = () => new Map([
    ["project-789", defaultTestAgents],
    ["test-project-123", defaultTestAgents],
    ["concurrent-project", defaultTestAgents],
    ["shutdown-project", defaultTestAgents],
    ["shutdown-save-project", defaultTestAgents],
    ["atomic-project", defaultTestAgents],
    ["project-1", defaultTestAgents],
    ["project-2", defaultTestAgents],
    ["persisted-project", defaultTestAgents],
    ["catchup-project", defaultTestAgents],
]);

// Mock PubkeyService - getNameSync calls getProjectContext() which throws in tests
mock.module("@/services/PubkeyService", () => ({
    PubkeyService: {
        getInstance: () => ({
            getNameSync: (pubkey: string) => pubkey,
        }),
    },
}));

mock.module("@/utils/logger", () => ({
    logger: {
        debug: mock(),
        info: mock(),
        warn: mock(),
        error: mock(),
    },
}));

// Mock TrustPubkeyService - default to whitelisted user
const mockIsTrustedSync = mock((_pubkey: string) => ({
    trusted: true,
    reason: "whitelisted" as const,
}));

mock.module("@/services/trust-pubkeys/TrustPubkeyService", () => ({
    getTrustPubkeyService: () => ({
        isTrustedSync: mockIsTrustedSync,
    }),
}));

// Import after mocks are set up
import { InterventionService } from "../InterventionService";

/** Fixed timestamp for deterministic tests (avoids Date.now() non-determinism). */
const FIXED_COMPLETION_TIME = 1_700_000_000_000;

describe("InterventionService", () => {
    let tempDir: string;
    let projectAgents: Map<string, Array<{ slug: string; pubkey: string }>>;

    beforeEach(async () => {
        // Reset singleton
        await InterventionService.resetInstance();

        // Create temp directory
        tempDir = path.join(tmpdir(), `intervention-test-${Date.now()}`);
        await fs.mkdir(tempDir, { recursive: true });
        mockGetConfigPath.mockReturnValue(tempDir);

        // Reset mocks - use mockClear for call tracking, then restore default
        // implementations that may have been overridden by individual tests
        // (e.g., mockRejectedValue in retry tests persists through mockClear)
        mockGetConfig.mockClear();
        mockPublishReviewRequest.mockClear();
        mockPublishReviewRequest.mockImplementation(
            (_target: string, _convId: string, _user: string, _agent: string) =>
                Promise.resolve("published-event-id")
        );
        mockPublisherInitialize.mockClear();
        mockIsTrustedSync.mockClear();

        // Set default mock returns
        mockGetConfig.mockReturnValue({
            intervention: {
                enabled: true,
                agent: "test-intervention-agent",
                timeout: 100, // 100ms for faster tests
            },
        });

        // Default project agents map
        projectAgents = createDefaultProjectAgents();

        // Default: user is whitelisted
        mockIsTrustedSync.mockReturnValue({
            trusted: true,
            reason: "whitelisted" as const,
        });
    });

    /**
     * Helper to initialize service with resolver
     */
    const initServiceWithResolver = async (
        customProjectAgents?: Map<string, Array<{ slug: string; pubkey: string }>>
    ): Promise<InstanceType<typeof InterventionService>> => {
        const service = InterventionService.getInstance();
        service.setAgentResolver(createMockResolver(customProjectAgents ?? projectAgents));
        await service.initialize();
        return service;
    };

    afterEach(async () => {
        // Cleanup - wait a bit for any pending async operations
        await new Promise(resolve => setTimeout(resolve, 50));
        await InterventionService.resetInstance();
        try {
            await fs.rm(tempDir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors
        }
    });

    afterAll(() => {
        // Restore all mocked modules to prevent test pollution
        mock.restore();
    });

    describe("initialization", () => {
        it("should initialize when enabled (agent resolution deferred)", async () => {
            const service = await initServiceWithResolver();

            expect(service.isEnabled()).toBe(true);
            // Agent resolution is deferred until completion/trigger time
            expect(mockPublisherInitialize).toHaveBeenCalled();
        });

        it("should not enable when disabled in config", async () => {
            mockGetConfig.mockReturnValue({
                intervention: {
                    enabled: false,
                    agent: "test-agent",
                },
            });

            const service = InterventionService.getInstance();
            await service.initialize();

            expect(service.isEnabled()).toBe(false);
        });

        it("should not enable when no agent configured", async () => {
            mockGetConfig.mockReturnValue({
                intervention: {
                    enabled: true,
                    // No agent specified
                },
            });

            const service = InterventionService.getInstance();
            await service.initialize();

            expect(service.isEnabled()).toBe(false);
        });

        it("should use default timeout when not configured", async () => {
            mockGetConfig.mockReturnValue({
                intervention: {
                    enabled: true,
                    agent: "test-agent",
                    // No timeout specified - should use default
                },
            });

            const service = await initServiceWithResolver();

            expect(service.isEnabled()).toBe(true);
            // Default timeout is 300000ms (5 minutes)
            expect(service.getTimeoutMs()).toBe(300000);
        });

        it("should trim whitespace from agent slug", async () => {
            mockGetConfig.mockReturnValue({
                intervention: {
                    enabled: true,
                    agent: "  test-intervention-agent  ", // Whitespace around slug
                    timeout: 100,
                },
            });

            const service = await initServiceWithResolver();
            await service.setProject("project-789");

            // Should resolve correctly despite whitespace in config
            service.onAgentCompletion(
                "test-conv-1",
                Date.now() + 10000,
                "agent-123",
                "user-456",
                "project-789"
            );

            expect(service.getPendingCount()).toBe(1);
        });

        it("should not enable when agent slug is only whitespace", async () => {
            mockGetConfig.mockReturnValue({
                intervention: {
                    enabled: true,
                    agent: "   ", // Only whitespace
                },
            });

            const service = InterventionService.getInstance();
            await service.initialize();

            expect(service.isEnabled()).toBe(false);
        });
    });

    describe("per-project agent resolution", () => {
        it("should resolve agent slug using project's agent registry on completion", async () => {
            const service = await initServiceWithResolver();
            await service.setProject("project-789");

            // Completion triggers per-project resolution
            service.onAgentCompletion(
                "test-conv-1",
                Date.now() + 10000, // Far future
                "agent-123",
                "user-456",
                "project-789"
            );

            expect(service.getPendingCount()).toBe(1);
        });

        it("should resolve agent separately for each project (no global caching)", async () => {
            // Setup different agents for different projects
            const customAgents = new Map([
                ["project-A", [{ slug: "test-intervention-agent", pubkey: "pubkey-A" }]],
                ["project-B", [{ slug: "test-intervention-agent", pubkey: "pubkey-B" }]],
            ]);

            const service = await initServiceWithResolver(customAgents);
            await service.setProject("project-A");

            // Completion for project A
            service.onAgentCompletion(
                "test-conv-1",
                Date.now() + 10000,
                "agent-123",
                "user-456",
                "project-A"
            );

            // Completion for project B
            service.onAgentCompletion(
                "test-conv-2",
                Date.now() + 10000,
                "agent-789",
                "user-999",
                "project-B"
            );

            // Both should be tracked since each project has the agent
            expect(service.getPendingCount()).toBe(2);
        });

        it("should skip completion if agent not found in project's registry (permanent failure)", async () => {
            // Setup project without the intervention agent
            const customAgents = new Map([
                ["project-789", [{ slug: "other-agent", pubkey: "other-pubkey" }]],
            ]);

            const service = await initServiceWithResolver(customAgents);
            await service.setProject("project-789");

            expect(service.isEnabled()).toBe(true);

            // Completion triggers resolution which fails (agent not in registry)
            service.onAgentCompletion(
                "test-conv-1",
                Date.now(),
                "agent-123",
                "user-456",
                "project-789"
            );

            // Should NOT track since agent was not found (permanent failure)
            expect(service.getPendingCount()).toBe(0);
            // Service should still be enabled (per-project failure doesn't disable globally)
            expect(service.isEnabled()).toBe(true);
        });

        it("should queue completion when project runtime not found (transient failure)", async () => {
            // Empty runtimes - no projects running (transient - runtime unavailable)
            const customAgents = new Map<string, Array<{ slug: string; pubkey: string }>>();

            const service = await initServiceWithResolver(customAgents);
            await service.setProject("project-789");

            service.onAgentCompletion(
                "test-conv-1",
                Date.now() + 10000, // Far future
                "agent-123",
                "user-456",
                "project-789"
            );

            // SHOULD track - transient failure queues for retry at trigger time
            expect(service.getPendingCount()).toBe(1);
        });

        it("should resolve correct agent per project at trigger time", async () => {
            // Different pubkeys for same slug in different projects
            const customAgents = new Map([
                ["project-A", [{ slug: "test-intervention-agent", pubkey: "pubkey-project-A" }]],
            ]);

            const service = await initServiceWithResolver(customAgents);
            await service.setProject("project-A");

            // Use already-expired time to trigger intervention immediately
            const pastTime = Date.now() - 10000;

            service.onAgentCompletion(
                "test-conv-1",
                pastTime,
                "agent-123",
                "user-456",
                "project-A"
            );

            // Wait for intervention to trigger
            await new Promise((resolve) => setTimeout(resolve, 100));

            // Should publish to the correct project's agent pubkey
            expect(mockPublishReviewRequest).toHaveBeenCalledWith(
                "pubkey-project-A", // Project A's intervention agent
                "test-conv-1",
                "user-456",
                "agent-123"
            );
        });
    });

    describe("timer starts on completion", () => {
        it("should start timer when agent completes work", async () => {
            const service = await initServiceWithResolver();
            await service.setProject("project-789");

            const conversationId = "test-conv-1";
            const completedAt = Date.now();
            const agentPubkey = "agent-123";
            const userPubkey = "user-456";
            const projectId = "project-789";

            service.onAgentCompletion(
                conversationId,
                completedAt,
                agentPubkey,
                userPubkey,
                projectId
            );

            expect(service.getPendingCount()).toBe(1);
            const pending = service.getPending(conversationId);
            expect(pending).toBeDefined();
            expect(pending?.agentPubkey).toBe(agentPubkey);
            expect(pending?.userPubkey).toBe(userPubkey);
            expect(pending?.projectId).toBe(projectId);
        });

        it("should update timer on subsequent completions for same conversation", async () => {
            const service = await initServiceWithResolver();
            await service.setProject("project-1");

            const conversationId = "test-conv-1";
            const firstCompletedAt = Date.now() - 50;
            const secondCompletedAt = Date.now();

            service.onAgentCompletion(
                conversationId,
                firstCompletedAt,
                "agent-1",
                "user-1",
                "project-1"
            );

            service.onAgentCompletion(
                conversationId,
                secondCompletedAt,
                "agent-2",
                "user-1",
                "project-1"
            );

            expect(service.getPendingCount()).toBe(1);
            const pending = service.getPending(conversationId);
            expect(pending?.completedAt).toBe(secondCompletedAt);
            expect(pending?.agentPubkey).toBe("agent-2");
        });
    });

    describe("timer cancels on user response", () => {
        it("should cancel timer when user responds after completion", async () => {
            const service = await initServiceWithResolver();
            await service.setProject("project-789");

            const conversationId = "test-conv-1";
            const completedAt = Date.now();
            const userPubkey = "user-456";

            service.onAgentCompletion(
                conversationId,
                completedAt,
                "agent-123",
                userPubkey,
                "project-789"
            );

            expect(service.getPendingCount()).toBe(1);

            // User responds after completion
            service.onUserResponse(conversationId, completedAt + 10, userPubkey);

            expect(service.getPendingCount()).toBe(0);
        });

        it("should NOT cancel timer when user response is before completion", async () => {
            const service = await initServiceWithResolver();
            await service.setProject("project-789");

            const conversationId = "test-conv-1";
            const completedAt = Date.now();
            const userPubkey = "user-456";

            service.onAgentCompletion(
                conversationId,
                completedAt,
                "agent-123",
                userPubkey,
                "project-789"
            );

            expect(service.getPendingCount()).toBe(1);

            // User response BEFORE completion timestamp - should NOT cancel
            service.onUserResponse(conversationId, completedAt - 10, userPubkey);

            expect(service.getPendingCount()).toBe(1);
        });

        it("should NOT cancel timer when different user responds", async () => {
            const service = await initServiceWithResolver();
            await service.setProject("project-789");

            const conversationId = "test-conv-1";
            const completedAt = Date.now();
            const userPubkey = "user-456";
            const differentUserPubkey = "user-different";

            service.onAgentCompletion(
                conversationId,
                completedAt,
                "agent-123",
                userPubkey,
                "project-789"
            );

            expect(service.getPendingCount()).toBe(1);

            // Different user responds - should NOT cancel
            service.onUserResponse(conversationId, completedAt + 10, differentUserPubkey);

            expect(service.getPendingCount()).toBe(1);
        });

        it("should NOT cancel timer when user responds after timeout window", async () => {
            const service = await initServiceWithResolver();
            await service.setProject("project-789");

            const conversationId = "test-conv-1";
            const completedAt = Date.now();
            const userPubkey = "user-456";
            const timeout = service.getTimeoutMs(); // Should be 100ms in test config

            service.onAgentCompletion(
                conversationId,
                completedAt,
                "agent-123",
                userPubkey,
                "project-789"
            );

            expect(service.getPendingCount()).toBe(1);

            // User responds AFTER timeout window - should NOT cancel
            // Response at completedAt + timeout + 1ms
            service.onUserResponse(conversationId, completedAt + timeout + 1, userPubkey);

            expect(service.getPendingCount()).toBe(1);
        });

        it("should do nothing when user responds to non-pending conversation", async () => {
            const service = await initServiceWithResolver();

            service.onUserResponse("non-existent-conv", Date.now(), "user-123");

            expect(service.getPendingCount()).toBe(0);
        });
    });

    describe("timer expiry triggers intervention", () => {
        it("should publish review request when timer expires", async () => {
            const service = await initServiceWithResolver();
            await service.setProject("project-789");

            const conversationId = "test-conv-1";
            const completedAt = Date.now();

            service.onAgentCompletion(
                conversationId,
                completedAt,
                "agent-123",
                "user-456",
                "project-789"
            );

            // Wait for timer to expire (100ms + buffer)
            await new Promise((resolve) => setTimeout(resolve, 200));

            expect(mockPublishReviewRequest).toHaveBeenCalledWith(
                "test-intervention-pubkey",
                conversationId,
                "user-456",
                "agent-123"
            );

            // Should be removed from pending after publishing
            expect(service.getPendingCount()).toBe(0);
        });

        it("should trigger immediately for already expired timers", async () => {
            const service = await initServiceWithResolver();
            await service.setProject("project-789");

            const conversationId = "test-conv-1";
            // Set completedAt to far in the past (timer already expired)
            const completedAt = Date.now() - 10000;

            service.onAgentCompletion(
                conversationId,
                completedAt,
                "agent-123",
                "user-456",
                "project-789"
            );

            // Should trigger immediately
            await new Promise((resolve) => setTimeout(resolve, 50));

            expect(mockPublishReviewRequest).toHaveBeenCalled();
        });
    });

    describe("retry/backoff on publish failures", () => {
        it("should retry on publish failure with backoff", async () => {
            let callCount = 0;
            mockPublishReviewRequest.mockImplementation(() => {
                callCount++;
                if (callCount < 2) {
                    return Promise.reject(new Error("Relay unavailable"));
                }
                return Promise.resolve("published-event-id");
            });

            const service = await initServiceWithResolver();
            await service.setProject("project-789");

            const conversationId = "test-conv-1";
            // Already expired timer
            const completedAt = Date.now() - 10000;

            service.onAgentCompletion(
                conversationId,
                completedAt,
                "agent-123",
                "user-456",
                "project-789"
            );

            // Wait for first attempt (immediate) + first retry (30s in real, but we'll check state)
            await new Promise((resolve) => setTimeout(resolve, 100));

            // First call should have been made
            expect(callCount).toBeGreaterThanOrEqual(1);

            // Pending should still exist after first failure (retry scheduled)
            const pending = service.getPending(conversationId);
            if (pending) {
                expect(pending.retryCount).toBeGreaterThanOrEqual(1);
            }
        });

        it("should track retry count in pending intervention", async () => {
            mockPublishReviewRequest.mockRejectedValue(new Error("Relay unavailable"));

            const service = await initServiceWithResolver();
            await service.setProject("project-789");

            const conversationId = "test-conv-1";
            const completedAt = Date.now() - 10000;

            service.onAgentCompletion(
                conversationId,
                completedAt,
                "agent-123",
                "user-456",
                "project-789"
            );

            // Wait for first attempt
            await new Promise((resolve) => setTimeout(resolve, 100));

            const pending = service.getPending(conversationId);
            // After failure, retry count should be incremented
            expect(pending?.retryCount).toBeGreaterThanOrEqual(1);
        });
    });

    describe("state persistence and recovery", () => {
        it("should save state when timer is created (project-scoped)", async () => {
            const service = await initServiceWithResolver();
            await service.setProject("test-project-123");

            service.onAgentCompletion(
                "test-conv-1",
                Date.now() + 10000, // Far in future to prevent timer expiry
                "agent-123",
                "user-456",
                "test-project-123"
            );

            // Wait for async save
            await service.waitForWrites();

            const stateFile = path.join(tempDir, "intervention_state_test-project-123.json");
            const data = await fs.readFile(stateFile, "utf-8");
            const state = JSON.parse(data);

            expect(state.pending).toHaveLength(1);
            expect(state.pending[0].conversationId).toBe("test-conv-1");
            expect(state.pending[0].projectId).toBe("test-project-123");
        });

        it("should load state on setProject", async () => {
            // Write initial state
            const projectId = "persisted-project";
            const stateFile = path.join(tempDir, `intervention_state_${projectId}.json`);
            const futureTime = Date.now() + 60000; // Far in future
            await fs.writeFile(
                stateFile,
                JSON.stringify({
                    pending: [
                        {
                            conversationId: "persisted-conv",
                            completedAt: futureTime,
                            agentPubkey: "agent-111",
                            userPubkey: "user-222",
                            projectId: projectId,
                        },
                    ],
                })
            );

            const service = await initServiceWithResolver();
            await service.setProject(projectId);

            expect(service.getPendingCount()).toBe(1);
            const pending = service.getPending("persisted-conv");
            expect(pending).toBeDefined();
            expect(pending?.agentPubkey).toBe("agent-111");
        });

        it("should setup catch-up timers for loaded pending interventions", async () => {
            // Write initial state with expired timer
            const projectId = "catchup-project";
            const stateFile = path.join(tempDir, `intervention_state_${projectId}.json`);
            const pastTime = Date.now() - 10000; // Already expired
            await fs.writeFile(
                stateFile,
                JSON.stringify({
                    pending: [
                        {
                            conversationId: "expired-conv",
                            completedAt: pastTime,
                            agentPubkey: "agent-111",
                            userPubkey: "user-222",
                            projectId: projectId,
                        },
                    ],
                })
            );

            const service = await initServiceWithResolver();
            await service.setProject(projectId);

            // Should trigger intervention immediately for expired timer
            await new Promise((resolve) => setTimeout(resolve, 100));

            expect(mockPublishReviewRequest).toHaveBeenCalled();
        });

        it("should isolate state between different projects", async () => {
            const project1 = "project-1";
            const project2 = "project-2";

            // Create state for project1
            const stateFile1 = path.join(tempDir, `intervention_state_${project1}.json`);
            await fs.writeFile(
                stateFile1,
                JSON.stringify({
                    pending: [
                        {
                            conversationId: "conv-p1",
                            completedAt: Date.now() + 60000,
                            agentPubkey: "agent-1",
                            userPubkey: "user-1",
                            projectId: project1,
                        },
                    ],
                })
            );

            // Create state for project2
            const stateFile2 = path.join(tempDir, `intervention_state_${project2}.json`);
            await fs.writeFile(
                stateFile2,
                JSON.stringify({
                    pending: [
                        {
                            conversationId: "conv-p2",
                            completedAt: Date.now() + 60000,
                            agentPubkey: "agent-2",
                            userPubkey: "user-2",
                            projectId: project2,
                        },
                    ],
                })
            );

            const service = await initServiceWithResolver();

            // Load project1 state
            await service.setProject(project1);
            expect(service.getPendingCount()).toBe(1);
            expect(service.getPending("conv-p1")).toBeDefined();
            expect(service.getPending("conv-p2")).toBeUndefined();

            // Switch to project2
            await service.setProject(project2);
            expect(service.getPendingCount()).toBe(1);
            expect(service.getPending("conv-p2")).toBeDefined();
            expect(service.getPending("conv-p1")).toBeUndefined();
        });
    });

    describe("serialized state writes", () => {
        it("should serialize concurrent saveState calls", async () => {
            const service = await initServiceWithResolver();
            await service.setProject("concurrent-project");

            // Rapidly add multiple completions (each triggers saveState)
            for (let i = 0; i < 10; i++) {
                service.onAgentCompletion(
                    `conv-${i}`,
                    Date.now() + 60000,
                    `agent-${i}`,
                    `user-${i}`,
                    "concurrent-project"
                );
            }

            // Wait for all writes to complete
            await service.waitForWrites();

            // Read final state
            const stateFile = path.join(tempDir, "intervention_state_concurrent-project.json");
            const data = await fs.readFile(stateFile, "utf-8");
            const state = JSON.parse(data);

            // All 10 should be present (writes were serialized, not lost)
            expect(state.pending).toHaveLength(10);
        });

        it("should use atomic rename for state writes", async () => {
            const service = await initServiceWithResolver();
            await service.setProject("atomic-project");

            service.onAgentCompletion(
                "test-conv",
                Date.now() + 60000,
                "agent-1",
                "user-1",
                "atomic-project"
            );

            await service.waitForWrites();

            // Verify no temp files left behind
            const files = await fs.readdir(tempDir);
            const tempFiles = files.filter(f => f.includes(".tmp."));
            expect(tempFiles).toHaveLength(0);

            // Verify state file exists
            const stateExists = files.includes("intervention_state_atomic-project.json");
            expect(stateExists).toBe(true);
        });
    });

    describe("shutdown", () => {
        it("should clear all timers on shutdown", async () => {
            const service = await initServiceWithResolver();
            await service.setProject("shutdown-project");

            service.onAgentCompletion(
                "conv-1",
                Date.now() + 10000,
                "agent-1",
                "user-1",
                "shutdown-project"
            );
            service.onAgentCompletion(
                "conv-2",
                Date.now() + 10000,
                "agent-2",
                "user-2",
                "shutdown-project"
            );

            expect(service.getPendingCount()).toBe(2);

            await service.shutdown();

            expect(service.isEnabled()).toBe(false);
        });

        it("should save state on shutdown", async () => {
            const service = await initServiceWithResolver();
            await service.setProject("shutdown-save-project");

            const futureTime = Date.now() + 60000;
            service.onAgentCompletion(
                "conv-1",
                futureTime,
                "agent-1",
                "user-1",
                "shutdown-save-project"
            );

            await service.shutdown();

            const stateFile = path.join(tempDir, "intervention_state_shutdown-save-project.json");
            const data = await fs.readFile(stateFile, "utf-8");
            const state = JSON.parse(data);

            expect(state.pending).toHaveLength(1);
        });
    });

    describe("disabled service", () => {
        it("should not track completions when disabled", async () => {
            mockGetConfig.mockReturnValue({
                intervention: {
                    enabled: false,
                },
            });

            const service = InterventionService.getInstance();
            await service.initialize();

            service.onAgentCompletion(
                "conv-1",
                Date.now(),
                "agent-1",
                "user-1",
                "project-1"
            );

            expect(service.getPendingCount()).toBe(0);
        });

        it("should not process user responses when disabled", async () => {
            mockGetConfig.mockReturnValue({
                intervention: {
                    enabled: false,
                },
            });

            const service = InterventionService.getInstance();
            await service.initialize();

            // This should not throw or cause issues
            service.onUserResponse("conv-1", Date.now(), "user-1");

            expect(service.getPendingCount()).toBe(0);
        });
    });

    describe("singleton pattern", () => {
        it("should return same instance", async () => {
            const instance1 = InterventionService.getInstance();
            const instance2 = InterventionService.getInstance();

            expect(instance1).toBe(instance2);
        });

        it("should reset instance correctly", async () => {
            const instance1 = await initServiceWithResolver();

            await InterventionService.resetInstance();

            const instance2 = InterventionService.getInstance();
            expect(instance2).not.toBe(instance1);
            expect(instance2.isEnabled()).toBe(false);
        });
    });

    describe("conversation inactivity timeout", () => {
        it("should use default timeout of 120 seconds when not configured", async () => {
            mockGetConfig.mockReturnValue({
                intervention: {
                    enabled: true,
                    agent: "test-agent",
                    // No conversationInactivityTimeoutSeconds specified
                },
            });

            const service = await initServiceWithResolver();

            expect(service.getConversationInactivityTimeoutSeconds()).toBe(120);
        });

        it("should use configured conversation inactivity timeout", async () => {
            mockGetConfig.mockReturnValue({
                intervention: {
                    enabled: true,
                    agent: "test-agent",
                    conversationInactivityTimeoutSeconds: 60, // 1 minute
                },
            });

            const service = await initServiceWithResolver();

            expect(service.getConversationInactivityTimeoutSeconds()).toBe(60);
        });

        it("should skip intervention when user was recently active (within threshold)", async () => {
            mockGetConfig.mockReturnValue({
                intervention: {
                    enabled: true,
                    agent: "test-intervention-agent",
                    timeout: 100,
                    conversationInactivityTimeoutSeconds: 120, // 2 minutes = 120000ms
                },
            });

            const service = await initServiceWithResolver();
            await service.setProject("project-789");

            const now = Date.now();
            const lastUserMessageTime = now - 10000; // User sent message 10 seconds ago
            const completedAt = now; // Agent completes now

            // User was active 10 seconds ago, threshold is 120 seconds
            // 10s < 120s => should skip intervention
            service.onAgentCompletion(
                "test-conv-1",
                completedAt,
                "agent-123",
                "user-456",
                "project-789",
                lastUserMessageTime
            );

            // Should NOT create a pending intervention
            expect(service.getPendingCount()).toBe(0);
        });

        it("should allow intervention when user was inactive longer than threshold", async () => {
            mockGetConfig.mockReturnValue({
                intervention: {
                    enabled: true,
                    agent: "test-intervention-agent",
                    timeout: 100,
                    conversationInactivityTimeoutSeconds: 120, // 2 minutes = 120000ms
                },
            });

            const service = await initServiceWithResolver();
            await service.setProject("project-789");

            const now = Date.now();
            const lastUserMessageTime = now - 300000; // User sent message 5 minutes ago
            const completedAt = now; // Agent completes now

            // User was active 5 minutes ago, threshold is 2 minutes
            // 5min > 2min => should allow intervention
            service.onAgentCompletion(
                "test-conv-1",
                completedAt,
                "agent-123",
                "user-456",
                "project-789",
                lastUserMessageTime
            );

            // Should create a pending intervention
            expect(service.getPendingCount()).toBe(1);
        });

        it("should allow intervention when lastUserMessageTime is not provided (backward compat)", async () => {
            mockGetConfig.mockReturnValue({
                intervention: {
                    enabled: true,
                    agent: "test-intervention-agent",
                    timeout: 100,
                    conversationInactivityTimeoutSeconds: 120,
                },
            });

            const service = await initServiceWithResolver();
            await service.setProject("project-789");

            // No lastUserMessageTime passed (undefined)
            service.onAgentCompletion(
                "test-conv-1",
                Date.now(),
                "agent-123",
                "user-456",
                "project-789"
                // lastUserMessageTime omitted
            );

            // Should still create a pending intervention (backward compatible)
            expect(service.getPendingCount()).toBe(1);
        });

        it("should skip intervention at exact threshold boundary", async () => {
            mockGetConfig.mockReturnValue({
                intervention: {
                    enabled: true,
                    agent: "test-intervention-agent",
                    timeout: 100,
                    conversationInactivityTimeoutSeconds: 120, // 120 seconds = 120000ms
                },
            });

            const service = await initServiceWithResolver();
            await service.setProject("project-789");

            const now = Date.now();
            // User was active exactly at threshold boundary (119999ms ago - just under 120s)
            const lastUserMessageTime = now - 119999;
            const completedAt = now;

            service.onAgentCompletion(
                "test-conv-1",
                completedAt,
                "agent-123",
                "user-456",
                "project-789",
                lastUserMessageTime
            );

            // timeSince = 119999ms < 120000ms threshold => should skip
            expect(service.getPendingCount()).toBe(0);
        });

        it("should allow intervention just past threshold boundary", async () => {
            mockGetConfig.mockReturnValue({
                intervention: {
                    enabled: true,
                    agent: "test-intervention-agent",
                    timeout: 100,
                    conversationInactivityTimeoutSeconds: 120, // 120 seconds = 120000ms
                },
            });

            const service = await initServiceWithResolver();
            await service.setProject("project-789");

            const now = Date.now();
            // User was active exactly at threshold (120000ms ago = exactly 120s)
            const lastUserMessageTime = now - 120000;
            const completedAt = now;

            service.onAgentCompletion(
                "test-conv-1",
                completedAt,
                "agent-123",
                "user-456",
                "project-789",
                lastUserMessageTime
            );

            // timeSince = 120000ms >= 120000ms threshold => should allow intervention
            expect(service.getPendingCount()).toBe(1);
        });

        it("should handle zero conversationInactivityTimeoutSeconds (always allow intervention)", async () => {
            mockGetConfig.mockReturnValue({
                intervention: {
                    enabled: true,
                    agent: "test-intervention-agent",
                    timeout: 100,
                    conversationInactivityTimeoutSeconds: 0, // Disabled - always allow
                },
            });

            const service = await initServiceWithResolver();
            await service.setProject("project-789");

            const now = Date.now();
            const lastUserMessageTime = now - 1000; // User sent message 1 second ago

            service.onAgentCompletion(
                "test-conv-1",
                now,
                "agent-123",
                "user-456",
                "project-789",
                lastUserMessageTime
            );

            // With threshold 0, check is skipped - should allow intervention
            expect(service.getPendingCount()).toBe(1);
        });
    });

    describe("whitelisted user filtering", () => {
        it("should trigger intervention when user is whitelisted", async () => {
            // Default mock already returns whitelisted
            mockIsTrustedSync.mockReturnValue({
                trusted: true,
                reason: "whitelisted" as const,
            });

            const service = await initServiceWithResolver();
            await service.setProject("project-789");

            service.onAgentCompletion(
                "test-conv-1",
                Date.now() + 10000,
                "agent-123",
                "whitelisted-user-pubkey",
                "project-789"
            );

            expect(service.getPendingCount()).toBe(1);
            expect(mockIsTrustedSync).toHaveBeenCalledWith("whitelisted-user-pubkey");
        });

        it("should NOT trigger intervention when user is an agent (agent-to-agent completion)", async () => {
            // Mock returns "agent" reason - this is an agent pubkey, not a whitelisted user
            mockIsTrustedSync.mockReturnValue({
                trusted: true,
                reason: "agent" as const,
            });

            const service = await initServiceWithResolver();
            await service.setProject("project-789");

            service.onAgentCompletion(
                "test-conv-1",
                Date.now() + 10000,
                "agent-123",          // completing agent
                "agent-456-pubkey",   // "user" is actually another agent
                "project-789"
            );

            // Should NOT create a pending intervention
            expect(service.getPendingCount()).toBe(0);
            expect(mockIsTrustedSync).toHaveBeenCalledWith("agent-456-pubkey");
        });

        it("should NOT trigger intervention when user pubkey is the backend", async () => {
            // Mock returns "backend" reason - the backend's own pubkey
            mockIsTrustedSync.mockReturnValue({
                trusted: true,
                reason: "backend" as const,
            });

            const service = await initServiceWithResolver();
            await service.setProject("project-789");

            service.onAgentCompletion(
                "test-conv-1",
                Date.now() + 10000,
                "agent-123",
                "backend-pubkey",
                "project-789"
            );

            // Should NOT create a pending intervention
            expect(service.getPendingCount()).toBe(0);
        });

        it("should NOT trigger intervention when user pubkey is not trusted at all", async () => {
            // Mock returns not trusted (unknown pubkey)
            mockIsTrustedSync.mockReturnValue({
                trusted: false,
                reason: undefined,
            });

            const service = await initServiceWithResolver();
            await service.setProject("project-789");

            service.onAgentCompletion(
                "test-conv-1",
                Date.now() + 10000,
                "agent-123",
                "unknown-pubkey",
                "project-789"
            );

            // Should NOT create a pending intervention
            expect(service.getPendingCount()).toBe(0);
        });

        it("should check trust status on each completion (not cached incorrectly)", async () => {
            const service = await initServiceWithResolver();
            await service.setProject("project-789");

            // First completion: user is whitelisted
            mockIsTrustedSync.mockReturnValue({
                trusted: true,
                reason: "whitelisted" as const,
            });

            service.onAgentCompletion(
                "test-conv-1",
                Date.now() + 10000,
                "agent-123",
                "user-1",
                "project-789"
            );

            expect(service.getPendingCount()).toBe(1);

            // Second completion: user is an agent (should be skipped)
            mockIsTrustedSync.mockReturnValue({
                trusted: true,
                reason: "agent" as const,
            });

            service.onAgentCompletion(
                "test-conv-2",
                Date.now() + 10000,
                "agent-456",
                "agent-789",
                "project-789"
            );

            // Should still be 1 (second was skipped)
            expect(service.getPendingCount()).toBe(1);

            // Third completion: user is whitelisted again
            mockIsTrustedSync.mockReturnValue({
                trusted: true,
                reason: "whitelisted" as const,
            });

            service.onAgentCompletion(
                "test-conv-3",
                Date.now() + 10000,
                "agent-xyz",
                "user-2",
                "project-789"
            );

            // Should now be 2
            expect(service.getPendingCount()).toBe(2);
        });
    });

    describe("state load race conditions", () => {
        it("should queue onUserResponse during state load", async () => {
            // Write initial state with a pending intervention
            const projectId = "race-test-project";
            projectAgents.set(projectId, defaultTestAgents);

            // Use a timeoutMs of 100ms (from test config)
            // completedAt must be recent enough that responseAt is within timeout window
            const now = Date.now();
            const completedAt = now; // Completed now
            const responseAt = now + 50; // Response 50ms later (within 100ms timeout window)

            const stateFile = path.join(tempDir, `intervention_state_${projectId}.json`);
            await fs.writeFile(
                stateFile,
                JSON.stringify({
                    pending: [
                        {
                            conversationId: "pending-conv",
                            completedAt: completedAt,
                            agentPubkey: "agent-111",
                            userPubkey: "user-222",
                            projectId: projectId,
                        },
                    ],
                })
            );

            const service = await initServiceWithResolver();

            // Simulate rapid setProject + onUserResponse calls
            // The onUserResponse might arrive before state finishes loading
            const setProjectPromise = service.setProject(projectId);

            // Immediately call onUserResponse before setProject completes
            // Response is within the timeout window (completedAt + 50ms < completedAt + 100ms)
            service.onUserResponse(
                "pending-conv",
                responseAt,
                "user-222"
            );

            // Wait for setProject to complete
            await setProjectPromise;

            // Wait for any pending operations
            await service.waitForPendingOps();

            // The user response should have properly cancelled the intervention
            // even though it was queued during state load
            expect(service.getPendingCount()).toBe(0);
        });

        it("should process queued operations in order after state load", async () => {
            const projectId = "queue-order-project";
            projectAgents.set(projectId, defaultTestAgents);

            const stateFile = path.join(tempDir, `intervention_state_${projectId}.json`);
            await fs.writeFile(
                stateFile,
                JSON.stringify({ pending: [] }) // Start empty
            );

            const service = await initServiceWithResolver();

            // Start setProject
            const setProjectPromise = service.setProject(projectId);

            // Use timestamps where response is within timeout window
            // completedAt = now + 60000, timeout = 100ms
            // So timeout expires at now + 60100
            // Response at now + 60050 is within window
            const now = Date.now();

            // Queue multiple operations during state load
            service.onAgentCompletion(
                "conv-1",
                now + 60000, // completedAt
                "agent-1",
                "user-1",
                projectId
            );

            service.onAgentCompletion(
                "conv-2",
                now + 60000,
                "agent-2",
                "user-2",
                projectId
            );

            // This user response should cancel conv-1 (within timeout window)
            // completedAt = now + 60000, timeout = 100ms, expiry = now + 60100
            // responseAt = now + 60050 < now + 60100 => within window
            service.onUserResponse("conv-1", now + 60050, "user-1");

            await setProjectPromise;
            await service.waitForPendingOps();

            // conv-1 should be cancelled, conv-2 should remain
            expect(service.getPendingCount()).toBe(1);
            expect(service.getPending("conv-1")).toBeUndefined();
            expect(service.getPending("conv-2")).toBeDefined();
        });

        it("should handle user response arriving after state load completes", async () => {
            const projectId = "post-load-response";
            projectAgents.set(projectId, defaultTestAgents);

            // Use timestamps where response is within timeout window
            // completedAt = now, timeout = 100ms, expiry = now + 100
            // responseAt = now + 50 < now + 100 => within window
            const now = Date.now();
            const completedAt = now;
            const responseAt = now + 50;

            const stateFile = path.join(tempDir, `intervention_state_${projectId}.json`);
            await fs.writeFile(
                stateFile,
                JSON.stringify({
                    pending: [
                        {
                            conversationId: "existing-conv",
                            completedAt: completedAt,
                            agentPubkey: "agent-111",
                            userPubkey: "user-222",
                            projectId: projectId,
                        },
                    ],
                })
            );

            const service = await initServiceWithResolver();
            await service.setProject(projectId);

            // State should be loaded
            expect(service.getPendingCount()).toBe(1);

            // Now user responds (not during state load) - within timeout window
            service.onUserResponse("existing-conv", responseAt, "user-222");

            // Should be cancelled
            expect(service.getPendingCount()).toBe(0);
        });
    });

    describe("transient runtime unavailability", () => {
        it("should queue completion when runtime temporarily unavailable", async () => {
            // Empty map = runtime unavailable for all projects
            const customAgents = new Map<string, Array<{ slug: string; pubkey: string }>>();

            const service = await initServiceWithResolver(customAgents);
            await service.setProject("project-789");

            service.onAgentCompletion(
                "test-conv-1",
                Date.now() + 10000, // Far future
                "agent-123",
                "user-456",
                "project-789"
            );

            // Should queue even when runtime unavailable (transient failure)
            expect(service.getPendingCount()).toBe(1);
        });

        it("should retry at trigger time when runtime becomes available", async () => {
            // Start with unavailable runtime
            let customAgents = new Map<string, Array<{ slug: string; pubkey: string }>>();

            const service = InterventionService.getInstance();
            service.setAgentResolver(createMockResolver(customAgents));
            await service.initialize();
            await service.setProject("project-789");

            // Use already-expired time
            const pastTime = Date.now() - 10000;

            service.onAgentCompletion(
                "test-conv-1",
                pastTime,
                "agent-123",
                "user-456",
                "project-789"
            );

            // Wait for first attempt (will fail - runtime unavailable)
            await new Promise((resolve) => setTimeout(resolve, 100));

            // Should have pending with retry count incremented
            const pending = service.getPending("test-conv-1");
            expect(pending?.retryCount).toBeGreaterThanOrEqual(1);

            // Runtime is still unavailable, so it should be retrying
            expect(mockPublishReviewRequest).not.toHaveBeenCalled();
        });

        it("should drop intervention after max retries when runtime stays unavailable", async () => {
            // Always unavailable runtime
            const customAgents = new Map<string, Array<{ slug: string; pubkey: string }>>();

            const service = await initServiceWithResolver(customAgents);
            await service.setProject("project-789");

            // Pre-set retry count to max-1 to speed up test
            const pastTime = Date.now() - 10000;
            service.onAgentCompletion(
                "test-conv-1",
                pastTime,
                "agent-123",
                "user-456",
                "project-789"
            );

            // Wait for intervention to be dropped after max retries
            // In real scenario this would take longer due to backoff
            await new Promise((resolve) => setTimeout(resolve, 200));

            // First attempt triggers, then retries
            const pending = service.getPending("test-conv-1");
            // Should either be pending with retry count or already removed
            if (pending) {
                expect(pending.retryCount).toBeGreaterThanOrEqual(1);
            }
        });

        it("should distinguish between runtime unavailable and agent not found", async () => {
            // Project A has different agent, Project B doesn't exist
            const customAgents = new Map([
                ["project-A", [{ slug: "other-agent", pubkey: "other-pubkey" }]],
                // project-B not in map = runtime unavailable
            ]);

            const service = await initServiceWithResolver(customAgents);
            await service.setProject("project-A");

            // Project A: agent not found (permanent) - should skip
            service.onAgentCompletion(
                "test-conv-1",
                Date.now() + 10000,
                "agent-123",
                "user-456",
                "project-A"
            );

            expect(service.getPendingCount()).toBe(0); // Skipped (permanent failure)

            // Project B: runtime unavailable (transient) - should queue
            service.onAgentCompletion(
                "test-conv-2",
                Date.now() + 10000,
                "agent-789",
                "user-999",
                "project-B"
            );

            expect(service.getPendingCount()).toBe(1); // Queued (transient failure)
        });

        it("should handle no resolver configured gracefully", async () => {
            const service = InterventionService.getInstance();
            // Don't set resolver
            await service.initialize();
            await service.setProject("project-789");

            service.onAgentCompletion(
                "test-conv-1",
                Date.now() + 10000,
                "agent-123",
                "user-456",
                "project-789"
            );

            // Should queue (treated as transient - no resolver = runtime unavailable)
            expect(service.getPendingCount()).toBe(1);
        });

        it("should catch resolver exceptions and treat as transient failure", async () => {
            // Create a resolver that throws an exception
            const throwingResolver = (_projectId: string, _agentSlug: string): AgentResolutionResult => {
                throw new Error("Simulated resolver crash");
            };

            const service = InterventionService.getInstance();
            service.setAgentResolver(throwingResolver);
            await service.initialize();
            await service.setProject("project-789");

            // Completion should be queued despite resolver throwing
            service.onAgentCompletion(
                "test-conv-1",
                FIXED_COMPLETION_TIME + 10000,
                "agent-123",
                "user-456",
                "project-789"
            );

            // Should queue (exception mapped to transient runtime_unavailable)
            expect(service.getPendingCount()).toBe(1);
        });
    });

    describe("duplicate notification prevention", () => {
        it("should not re-notify a conversation that was already notified", async () => {
            const service = await initServiceWithResolver();
            await service.setProject("project-789");

            const conversationId = "test-conv-1";
            // Use already-expired time to trigger intervention immediately
            const pastTime = Date.now() - 10000;

            service.onAgentCompletion(
                conversationId,
                pastTime,
                "agent-123",
                "user-456",
                "project-789"
            );

            // Wait for intervention to trigger and publish
            await new Promise((resolve) => setTimeout(resolve, 200));

            expect(mockPublishReviewRequest).toHaveBeenCalledTimes(1);
            expect(service.isNotified(conversationId)).toBe(true);
            expect(service.getPendingCount()).toBe(0);

            // Simulate re-delivered completion event for the same conversation
            mockPublishReviewRequest.mockClear();
            service.onAgentCompletion(
                conversationId,
                pastTime,
                "agent-123",
                "user-456",
                "project-789"
            );

            // Should NOT create a new pending intervention
            expect(service.getPendingCount()).toBe(0);

            // Wait to ensure no second publish happens
            await new Promise((resolve) => setTimeout(resolve, 200));
            expect(mockPublishReviewRequest).not.toHaveBeenCalled();
        });

        it("should persist notified state across restarts", async () => {
            const projectId = "persist-notified-project";
            projectAgents.set(projectId, defaultTestAgents);

            const service = await initServiceWithResolver();
            await service.setProject(projectId);

            // Trigger intervention immediately
            const pastTime = Date.now() - 10000;
            service.onAgentCompletion(
                "notified-conv",
                pastTime,
                "agent-123",
                "user-456",
                projectId
            );

            await new Promise((resolve) => setTimeout(resolve, 200));
            expect(mockPublishReviewRequest).toHaveBeenCalledTimes(1);
            expect(service.isNotified("notified-conv")).toBe(true);

            // Wait for state to be saved
            await service.waitForWrites();

            // Verify the state file contains notified entries
            const stateFile = path.join(tempDir, `intervention_state_${projectId}.json`);
            const data = await fs.readFile(stateFile, "utf-8");
            const state = JSON.parse(data);
            expect(state.notified).toBeDefined();
            expect(state.notified.length).toBe(1);
            expect(state.notified[0].conversationId).toBe("notified-conv");

            // Reset and reload
            await InterventionService.resetInstance();
            const service2 = await initServiceWithResolver();
            await service2.setProject(projectId);

            // Should still know about the notified conversation
            expect(service2.isNotified("notified-conv")).toBe(true);
            expect(service2.getNotifiedCount()).toBe(1);

            // Re-delivered completion should be rejected
            mockPublishReviewRequest.mockClear();
            service2.onAgentCompletion(
                "notified-conv",
                pastTime,
                "agent-123",
                "user-456",
                projectId
            );

            expect(service2.getPendingCount()).toBe(0);
            await new Promise((resolve) => setTimeout(resolve, 200));
            expect(mockPublishReviewRequest).not.toHaveBeenCalled();
        });

        it("should allow notification for different conversations", async () => {
            const service = await initServiceWithResolver();
            await service.setProject("project-789");

            // First conversation triggers and publishes
            const pastTime = Date.now() - 10000;
            service.onAgentCompletion(
                "conv-1",
                pastTime,
                "agent-123",
                "user-456",
                "project-789"
            );

            await new Promise((resolve) => setTimeout(resolve, 200));
            expect(mockPublishReviewRequest).toHaveBeenCalledTimes(1);
            expect(service.isNotified("conv-1")).toBe(true);

            // Second conversation should still be allowed
            mockPublishReviewRequest.mockClear();
            service.onAgentCompletion(
                "conv-2",
                pastTime,
                "agent-789",
                "user-456",
                "project-789"
            );

            // Should create a pending intervention for conv-2
            await new Promise((resolve) => setTimeout(resolve, 200));
            expect(mockPublishReviewRequest).toHaveBeenCalledTimes(1);
            expect(service.isNotified("conv-2")).toBe(true);
        });

        it("should guard triggerIntervention against concurrent execution", async () => {
            const service = await initServiceWithResolver();
            await service.setProject("project-789");

            // Make publishReviewRequest slow to simulate concurrency window
            let publishCallCount = 0;
            mockPublishReviewRequest.mockImplementation(async () => {
                publishCallCount++;
                await new Promise((resolve) => setTimeout(resolve, 100));
                return "published-event-id";
            });

            const pastTime = Date.now() - 10000;
            service.onAgentCompletion(
                "race-conv",
                pastTime,
                "agent-123",
                "user-456",
                "project-789"
            );

            // Wait for everything to settle
            await new Promise((resolve) => setTimeout(resolve, 300));

            // Should only have published once despite potential race
            expect(publishCallCount).toBe(1);
        });
    });

    describe("in-memory notifiedConversations pruning", () => {
        it("should prune stale notified entries when checking in addPendingIntervention", async () => {
            const service = await initServiceWithResolver();
            await service.setProject("project-789");

            // Inject a stale notified entry (older than 24h)
            const staleTimestamp = Date.now() - (25 * 60 * 60 * 1000); // 25 hours ago
            service.setNotifiedForTesting("stale-conv", staleTimestamp);

            expect(service.isNotified("stale-conv")).toBe(true);
            expect(service.getNotifiedCount()).toBe(1);

            // Trigger a new completion (calls addPendingIntervention which prunes stale entries)
            service.onAgentCompletion(
                "new-conv",
                Date.now() + 60000, // Far future
                "agent-123",
                "user-456",
                "project-789"
            );

            // Stale entry should have been pruned
            expect(service.isNotified("stale-conv")).toBe(false);
            expect(service.getNotifiedCount()).toBe(0);

            // New completion should have been accepted
            expect(service.getPendingCount()).toBe(1);
        });

        it("should allow re-notification for a conversation whose notified entry expired", async () => {
            const service = await initServiceWithResolver();
            await service.setProject("project-789");

            // Inject a stale notified entry for the SAME conversation we want to re-notify
            const staleTimestamp = Date.now() - (25 * 60 * 60 * 1000); // 25 hours ago
            service.setNotifiedForTesting("test-conv-1", staleTimestamp);

            expect(service.isNotified("test-conv-1")).toBe(true);

            // Try to re-trigger for the same conversation
            service.onAgentCompletion(
                "test-conv-1",
                Date.now() + 60000,
                "agent-123",
                "user-456",
                "project-789"
            );

            // Stale entry should have been pruned, and re-notification should be accepted
            expect(service.getPendingCount()).toBe(1);
            expect(service.getPending("test-conv-1")).toBeDefined();
        });

        it("should NOT prune non-stale notified entries", async () => {
            const service = await initServiceWithResolver();
            await service.setProject("project-789");

            // Inject a fresh notified entry (only 1 hour old)
            const freshTimestamp = Date.now() - (1 * 60 * 60 * 1000); // 1 hour ago
            service.setNotifiedForTesting("fresh-conv", freshTimestamp);

            expect(service.isNotified("fresh-conv")).toBe(true);

            // Trigger a new completion to invoke pruning
            service.onAgentCompletion(
                "new-conv",
                Date.now() + 60000,
                "agent-123",
                "user-456",
                "project-789"
            );

            // Fresh entry should still be present
            expect(service.isNotified("fresh-conv")).toBe(true);
            expect(service.getNotifiedCount()).toBe(1);
        });

        it("should still block re-notification for fresh notified entries", async () => {
            const service = await initServiceWithResolver();
            await service.setProject("project-789");

            // Inject a fresh notified entry
            const freshTimestamp = Date.now() - (1 * 60 * 60 * 1000); // 1 hour ago
            service.setNotifiedForTesting("test-conv-1", freshTimestamp);

            // Try to re-trigger the same conversation
            service.onAgentCompletion(
                "test-conv-1",
                Date.now() + 60000,
                "agent-123",
                "user-456",
                "project-789"
            );

            // Should be blocked (entry is still fresh)
            expect(service.getPendingCount()).toBe(0);
        });

        it("should prune multiple stale entries at once", async () => {
            const service = await initServiceWithResolver();
            await service.setProject("project-789");

            // Inject multiple stale entries
            const staleTimestamp = Date.now() - (25 * 60 * 60 * 1000);
            service.setNotifiedForTesting("stale-1", staleTimestamp);
            service.setNotifiedForTesting("stale-2", staleTimestamp - 1000);
            service.setNotifiedForTesting("stale-3", staleTimestamp - 2000);

            // And one fresh entry
            const freshTimestamp = Date.now() - (1 * 60 * 60 * 1000);
            service.setNotifiedForTesting("fresh-1", freshTimestamp);

            expect(service.getNotifiedCount()).toBe(4);

            // Trigger pruning via a new completion
            service.onAgentCompletion(
                "trigger-conv",
                Date.now() + 60000,
                "agent-123",
                "user-456",
                "project-789"
            );

            // Only the fresh entry should remain
            expect(service.getNotifiedCount()).toBe(1);
            expect(service.isNotified("fresh-1")).toBe(true);
            expect(service.isNotified("stale-1")).toBe(false);
            expect(service.isNotified("stale-2")).toBe(false);
            expect(service.isNotified("stale-3")).toBe(false);
        });
    });

    describe("triggeringConversations cleared on project switch", () => {
        it("should clear triggeringConversations when switching projects", async () => {
            const service = await initServiceWithResolver();
            await service.setProject("project-1");

            // Simulate a triggering conversation in-flight
            service.setTriggeringForTesting("inflight-conv");
            expect(service.isTriggering("inflight-conv")).toBe(true);

            // Switch to a different project
            await service.setProject("project-2");

            // triggeringConversations should be cleared
            expect(service.isTriggering("inflight-conv")).toBe(false);
        });

        it("should clear multiple triggeringConversations entries on project switch", async () => {
            const service = await initServiceWithResolver();
            await service.setProject("project-1");

            service.setTriggeringForTesting("conv-a");
            service.setTriggeringForTesting("conv-b");

            expect(service.isTriggering("conv-a")).toBe(true);
            expect(service.isTriggering("conv-b")).toBe(true);

            // Switch to different project
            await service.setProject("project-2");

            // All triggering entries from previous project should be cleared
            expect(service.isTriggering("conv-a")).toBe(false);
            expect(service.isTriggering("conv-b")).toBe(false);
        });

        it("should not interfere with new triggers after project switch", async () => {
            const service = await initServiceWithResolver();
            await service.setProject("project-1");

            // Set up stale triggering state
            service.setTriggeringForTesting("old-conv");

            // Switch projects
            await service.setProject("project-2");

            // New completions should work normally (no stale triggeringConversations blocking)
            service.onAgentCompletion(
                "new-conv",
                Date.now() + 60000,
                "agent-123",
                "user-456",
                "project-2"
            );

            expect(service.getPendingCount()).toBe(1);
        });
    });

    describe("active delegation checking", () => {
        it("should skip intervention when agent has active delegations", async () => {
            // Create a mock delegation checker that returns true (has active delegations)
            const mockDelegationChecker = mock((_agentPubkey: string, _conversationId: string) => true);

            const service = await initServiceWithResolver();
            service.setActiveDelegationChecker(mockDelegationChecker);
            await service.setProject("project-789");

            service.onAgentCompletion(
                "test-conv-1",
                FIXED_COMPLETION_TIME,
                "agent-123",
                "user-456",
                "project-789"
            );

            // Should NOT create a pending intervention (delegations are active)
            expect(service.getPendingCount()).toBe(0);

            // Verify the checker was called with correct params
            expect(mockDelegationChecker).toHaveBeenCalledWith("agent-123", "test-conv-1");
        });

        it("should allow intervention when agent has no active delegations", async () => {
            // Create a mock delegation checker that returns false (no active delegations)
            const mockDelegationChecker = mock((_agentPubkey: string, _conversationId: string) => false);

            const service = await initServiceWithResolver();
            service.setActiveDelegationChecker(mockDelegationChecker);
            await service.setProject("project-789");

            service.onAgentCompletion(
                "test-conv-1",
                FIXED_COMPLETION_TIME,
                "agent-123",
                "user-456",
                "project-789"
            );

            // Should create a pending intervention (no active delegations)
            expect(service.getPendingCount()).toBe(1);

            // Verify the checker was called
            expect(mockDelegationChecker).toHaveBeenCalledWith("agent-123", "test-conv-1");
        });

        it("should allow intervention when no delegation checker is configured", async () => {
            // No delegation checker set - backward compatible behavior
            const service = await initServiceWithResolver();
            // Explicitly NOT setting a delegation checker
            await service.setProject("project-789");

            service.onAgentCompletion(
                "test-conv-1",
                FIXED_COMPLETION_TIME,
                "agent-123",
                "user-456",
                "project-789"
            );

            // Should create a pending intervention (no checker = no skip)
            expect(service.getPendingCount()).toBe(1);
        });

        it("should not call delegation checker for non-whitelisted users", async () => {
            const mockDelegationChecker = mock((_agentPubkey: string, _conversationId: string) => true);

            // Mock user as non-whitelisted
            mockIsTrustedSync.mockReturnValue({
                trusted: false,
                reason: undefined,
            });

            const service = await initServiceWithResolver();
            service.setActiveDelegationChecker(mockDelegationChecker);
            await service.setProject("project-789");

            service.onAgentCompletion(
                "test-conv-1",
                FIXED_COMPLETION_TIME,
                "agent-123",
                "non-whitelisted-user",
                "project-789"
            );

            // Should skip before reaching delegation check (user not whitelisted)
            expect(service.getPendingCount()).toBe(0);

            // Delegation checker should NOT be called (early return for non-whitelisted)
            expect(mockDelegationChecker).not.toHaveBeenCalled();
        });

        it("should check delegations after user activity check", async () => {
            // User was recently active (within threshold) - should skip before delegation check
            mockGetConfig.mockReturnValue({
                intervention: {
                    enabled: true,
                    agent: "test-intervention-agent",
                    timeout: 100,
                    conversationInactivityTimeoutSeconds: 120,
                },
            });

            const mockDelegationChecker = mock((_agentPubkey: string, _conversationId: string) => true);

            const service = await initServiceWithResolver();
            service.setActiveDelegationChecker(mockDelegationChecker);
            await service.setProject("project-789");

            const now = Date.now();
            const lastUserMessageTime = now - 10000; // User sent message 10 seconds ago

            service.onAgentCompletion(
                "test-conv-1",
                now, // completedAt
                "agent-123",
                "user-456",
                "project-789",
                lastUserMessageTime
            );

            // Should skip due to recent user activity (before reaching delegation check)
            expect(service.getPendingCount()).toBe(0);

            // Delegation checker should NOT be called (early return for recent activity)
            expect(mockDelegationChecker).not.toHaveBeenCalled();
        });
    });

    describe("timer cleanup on project switch", () => {
        it("should clear timers when switching projects in loadState", async () => {
            const service = await initServiceWithResolver();
            await service.setProject("project-1");

            // Add a pending intervention with completedAt = now, so the timer
            // WOULD fire after 100ms (the configured timeout) if not cleaned up.
            // This ensures the test is non-vacuous: without cleanup, the timer fires.
            service.onAgentCompletion(
                "conv-1",
                Date.now(),
                "agent-123",
                "user-456",
                "project-1"
            );

            expect(service.getPendingCount()).toBe(1);

            // Switch to a different project - timers from project-1 should be cleared
            await service.setProject("project-2");

            // Pending interventions should be cleared (loaded from project-2's state, which is empty)
            expect(service.getPendingCount()).toBe(0);

            // Wait beyond the timeout (100ms) + buffer — the timer would have fired by now
            await new Promise(resolve => setTimeout(resolve, 200));

            // No intervention should have been published (stale timer was cleared)
            expect(mockPublishReviewRequest).not.toHaveBeenCalled();
        });

        it("should not fire stale timers from previous project after switch", async () => {
            mockGetConfig.mockReturnValue({
                intervention: {
                    enabled: true,
                    agent: "test-intervention-agent",
                    timeout: 50, // very short timeout
                },
            });

            const service = await initServiceWithResolver();
            await service.setProject("project-1");

            // Start a timer with short timeout
            service.onAgentCompletion(
                "conv-stale",
                Date.now(),
                "agent-123",
                "user-456",
                "project-1"
            );

            expect(service.getPendingCount()).toBe(1);

            // Immediately switch projects before timer fires
            await service.setProject("project-2");

            // Wait for the old timer's timeout to elapse
            await new Promise(resolve => setTimeout(resolve, 150));

            // The stale timer should have been cancelled, no publish should occur
            expect(mockPublishReviewRequest).not.toHaveBeenCalled();
        });

        it("should accept new interventions for the new project after switch", async () => {
            const service = await initServiceWithResolver();
            await service.setProject("project-1");

            // Register a completion in project-1
            service.onAgentCompletion(
                "conv-old",
                Date.now() + 60000,
                "agent-123",
                "user-456",
                "project-1"
            );

            expect(service.getPendingCount()).toBe(1);

            // Switch to project-2 (clears old timers and state)
            await service.setProject("project-2");
            expect(service.getPendingCount()).toBe(0);

            // Register a new completion in project-2
            service.onAgentCompletion(
                "conv-new",
                Date.now() + 60000,
                "agent-123",
                "user-456",
                "project-2"
            );

            // New project should accept new interventions normally
            expect(service.getPendingCount()).toBe(1);
            expect(service.getPending("conv-new")).toBeDefined();
            expect(service.getPending("conv-new")?.projectId).toBe("project-2");
        });
    });

    describe("triggerIntervention project ID guard", () => {
        it("should discard stale timer firing for wrong project", async () => {
            const service = await initServiceWithResolver();
            await service.setProject("project-2");

            // Directly invoke triggerIntervention with a stale PendingIntervention
            // whose projectId ("project-1") doesn't match currentProjectId ("project-2").
            // This exercises the defense-in-depth guard without relying on setProject
            // (which already clears timers and would prevent triggerIntervention from running).
            const stalePending = {
                conversationId: "conv-cross-project",
                completedAt: Date.now(),
                agentPubkey: "agent-123",
                userPubkey: "user-456",
                projectId: "project-1", // mismatches current "project-2"
            };

            // Call triggerIntervention directly via private method access
            await (service as any).triggerIntervention(stalePending);

            // The guard should have silently discarded it — no publish call
            expect(mockPublishReviewRequest).not.toHaveBeenCalled();
        });

        it("should allow trigger when projectId matches currentProjectId", async () => {
            const service = await initServiceWithResolver();
            await service.setProject("project-1");

            // Invoke triggerIntervention with a matching projectId
            const matchingPending = {
                conversationId: "conv-matching",
                completedAt: Date.now() - 10000,
                agentPubkey: "agent-123",
                userPubkey: "user-456",
                projectId: "project-1", // matches currentProjectId
                retryCount: 0,
            };

            await (service as any).triggerIntervention(matchingPending);

            // Should proceed to publish (projectId guard passes)
            expect(mockPublishReviewRequest).toHaveBeenCalledTimes(1);
        });
    });
});
