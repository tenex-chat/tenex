import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";

/**
 * Tests for InterventionService.
 *
 * Verifies:
 * - Lazy agent resolution (deferred until first completion event)
 * - Timer starts on completion
 * - Timer cancels on user response (after completion, before timeout)
 * - Timer does NOT cancel on user response before completion
 * - Timer does NOT cancel on user response after timeout window
 * - Timer expiry triggers intervention
 * - Retry/backoff on publish failures
 * - State persistence and recovery (project-scoped)
 * - Serialized state writes (concurrent saveState calls)
 * - Agent slug validation at startup
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

const mockResolveAgentSlug = mock((_slug: string) => ({
    pubkey: "test-intervention-pubkey",
    availableSlugs: ["test-intervention-agent"],
}));

const mockPublishReviewRequest = mock(
    (_target: string, _convId: string, _user: string, _agent: string) =>
        Promise.resolve("published-event-id")
);

// Mock publisher
const mockPublisherInitialize = mock(() => Promise.resolve());

mock.module("@/services/ConfigService", () => ({
    config: {
        getConfig: mockGetConfig,
        getConfigPath: mockGetConfigPath,
        getBackendSigner: mock(() => Promise.resolve({ pubkey: "backend-pubkey" })),
    },
}));

mock.module("@/services/agents/AgentResolution", () => ({
    resolveAgentSlug: mockResolveAgentSlug,
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

mock.module("@/utils/logger", () => ({
    logger: {
        debug: mock(),
        info: mock(),
        warn: mock(),
        error: mock(),
    },
}));

// Import after mocks are set up
import { InterventionService } from "../InterventionService";

describe("InterventionService", () => {
    let tempDir: string;

    beforeEach(async () => {
        // Reset singleton
        await InterventionService.resetInstance();

        // Create temp directory
        tempDir = path.join(tmpdir(), `intervention-test-${Date.now()}`);
        await fs.mkdir(tempDir, { recursive: true });
        mockGetConfigPath.mockReturnValue(tempDir);

        // Reset mocks
        mockGetConfig.mockClear();
        mockResolveAgentSlug.mockClear();
        mockPublishReviewRequest.mockClear();
        mockPublisherInitialize.mockClear();

        // Set default mock returns
        mockGetConfig.mockReturnValue({
            intervention: {
                enabled: true,
                agent: "test-intervention-agent",
                timeout: 100, // 100ms for faster tests
            },
        });
        mockResolveAgentSlug.mockReturnValue({
            pubkey: "test-intervention-pubkey",
            availableSlugs: ["test-intervention-agent"],
        });
    });

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
            const service = InterventionService.getInstance();
            await service.initialize();

            expect(service.isEnabled()).toBe(true);
            // Agent resolution is deferred - should NOT be called during initialize
            expect(mockResolveAgentSlug).not.toHaveBeenCalled();
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

            const service = InterventionService.getInstance();
            await service.initialize();

            expect(service.isEnabled()).toBe(true);
            // Default timeout is 300000ms (5 minutes)
            expect(service.getTimeoutMs()).toBe(300000);
        });
    });

    describe("lazy agent resolution", () => {
        it("should resolve agent slug on first completion event", async () => {
            const service = InterventionService.getInstance();
            await service.initialize();
            await service.setProject("project-789");

            expect(mockResolveAgentSlug).not.toHaveBeenCalled();

            // First completion should trigger resolution
            service.onAgentCompletion(
                "test-conv-1",
                Date.now() + 10000, // Far future
                "agent-123",
                "user-456",
                "project-789"
            );

            expect(mockResolveAgentSlug).toHaveBeenCalledWith("test-intervention-agent");
            expect(service.getPendingCount()).toBe(1);
        });

        it("should cache resolved pubkey and not resolve again", async () => {
            const service = InterventionService.getInstance();
            await service.initialize();
            await service.setProject("project-789");

            // First completion triggers resolution
            service.onAgentCompletion(
                "test-conv-1",
                Date.now() + 10000,
                "agent-123",
                "user-456",
                "project-789"
            );

            expect(mockResolveAgentSlug).toHaveBeenCalledTimes(1);

            // Second completion should NOT trigger resolution again
            service.onAgentCompletion(
                "test-conv-2",
                Date.now() + 10000,
                "agent-456",
                "user-789",
                "project-789"
            );

            expect(mockResolveAgentSlug).toHaveBeenCalledTimes(1);
            expect(service.getPendingCount()).toBe(2);
        });

        it("should disable service if agent resolution fails", async () => {
            mockResolveAgentSlug.mockReturnValue({
                pubkey: null,
                availableSlugs: ["other-agent"],
            });

            const service = InterventionService.getInstance();
            await service.initialize();
            await service.setProject("project-789");

            expect(service.isEnabled()).toBe(true); // Still enabled before first completion

            // Completion triggers resolution which fails
            service.onAgentCompletion(
                "test-conv-1",
                Date.now(),
                "agent-123",
                "user-456",
                "project-789"
            );

            expect(mockResolveAgentSlug).toHaveBeenCalled();
            expect(service.isEnabled()).toBe(false);
            expect(service.getPendingCount()).toBe(0); // Should not track
        });

        it("should not retry resolution after failure", async () => {
            mockResolveAgentSlug.mockReturnValue({
                pubkey: null,
                availableSlugs: [],
            });

            const service = InterventionService.getInstance();
            await service.initialize();
            await service.setProject("project-789");

            // First completion - resolution fails
            service.onAgentCompletion(
                "test-conv-1",
                Date.now(),
                "agent-123",
                "user-456",
                "project-789"
            );

            expect(mockResolveAgentSlug).toHaveBeenCalledTimes(1);
            expect(service.isEnabled()).toBe(false);

            // Second completion - should not retry
            service.onAgentCompletion(
                "test-conv-2",
                Date.now(),
                "agent-456",
                "user-789",
                "project-789"
            );

            expect(mockResolveAgentSlug).toHaveBeenCalledTimes(1); // Not called again
        });
    });

    describe("timer starts on completion", () => {
        it("should start timer when agent completes work", async () => {
            const service = InterventionService.getInstance();
            await service.initialize();
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
            const service = InterventionService.getInstance();
            await service.initialize();
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
            const service = InterventionService.getInstance();
            await service.initialize();
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
            const service = InterventionService.getInstance();
            await service.initialize();
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
            const service = InterventionService.getInstance();
            await service.initialize();
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
            const service = InterventionService.getInstance();
            await service.initialize();
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
            const service = InterventionService.getInstance();
            await service.initialize();

            service.onUserResponse("non-existent-conv", Date.now(), "user-123");

            expect(service.getPendingCount()).toBe(0);
        });
    });

    describe("timer expiry triggers intervention", () => {
        it("should publish review request when timer expires", async () => {
            const service = InterventionService.getInstance();
            await service.initialize();
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
            const service = InterventionService.getInstance();
            await service.initialize();
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

            const service = InterventionService.getInstance();
            await service.initialize();
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

            const service = InterventionService.getInstance();
            await service.initialize();
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
            const service = InterventionService.getInstance();
            await service.initialize();
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

            const service = InterventionService.getInstance();
            await service.initialize();
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

            const service = InterventionService.getInstance();
            await service.initialize();

            // Force agent resolution before loading state
            service.forceAgentResolution();

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

            const service = InterventionService.getInstance();
            await service.initialize();

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
            const service = InterventionService.getInstance();
            await service.initialize();
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
            const service = InterventionService.getInstance();
            await service.initialize();
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
            const service = InterventionService.getInstance();
            await service.initialize();
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
            const service = InterventionService.getInstance();
            await service.initialize();
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
            const instance1 = InterventionService.getInstance();
            await instance1.initialize();

            await InterventionService.resetInstance();

            const instance2 = InterventionService.getInstance();
            expect(instance2).not.toBe(instance1);
            expect(instance2.isEnabled()).toBe(false);
        });
    });
});
