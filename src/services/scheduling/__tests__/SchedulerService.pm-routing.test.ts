import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SchedulerService, type ScheduledTask } from "@/services/scheduling/SchedulerService";

/**
 * Tests for the PM routing feature in SchedulerService.
 *
 * When a scheduled task runs, if the target agent (toPubkey) is not in the
 * task's project, the event should be routed to the Project Manager (PM)
 * of that project instead.
 */

// Mock the daemon module
vi.mock("@/daemon", () => ({
    getDaemon: vi.fn(),
}));

// Mock logger to avoid noisy output
vi.mock("@/utils/logger", () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
    },
}));

// Import after mocking
import { getDaemon } from "@/daemon";

/**
 * Testable subclass that exposes the protected resolveTargetPubkey method.
 * This allows us to test the actual implementation logic directly.
 */
class TestableSchedulerService extends SchedulerService {
    /**
     * Public wrapper to test the protected resolveTargetPubkey method.
     * This actually exercises the real implementation code.
     */
    public testResolveTargetPubkey(task: ScheduledTask): string {
        return this.resolveTargetPubkey(task);
    }
}

/**
 * Helper to get a testable instance of SchedulerService.
 * We replace the singleton's prototype to add testability while preserving singleton state.
 */
function getTestableInstance(): TestableSchedulerService {
    // Get the singleton instance
    const instance = SchedulerService.getInstance();

    // Extend its prototype to add the test method
    // biome-ignore lint/suspicious/noExplicitAny: Testing requires prototype manipulation
    (instance as any).testResolveTargetPubkey = function(task: ScheduledTask): string {
        return TestableSchedulerService.prototype.testResolveTargetPubkey.call(this, task);
    };

    return instance as TestableSchedulerService;
}

describe("SchedulerService PM Routing", () => {
    const mockGetDaemon = getDaemon as ReturnType<typeof vi.fn>;

    // Test task fixture factory
    const createTask = (overrides?: Partial<ScheduledTask>): ScheduledTask => ({
        id: "task-123",
        schedule: "0 9 * * *",
        prompt: "Test prompt",
        fromPubkey: "sender-pubkey-12345678",
        toPubkey: "target-pubkey-12345678",
        projectId: "31933:owner:test-project",
        ...overrides,
    });

    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("resolveTargetPubkey", () => {
        let service: TestableSchedulerService;

        beforeEach(() => {
            service = getTestableInstance();
        });

        it("should return original toPubkey when project is not running", () => {
            // Setup: daemon returns empty runtimes map (project not running)
            const mockDaemon = {
                getActiveRuntimes: vi.fn().mockReturnValue(new Map()),
            };
            mockGetDaemon.mockReturnValue(mockDaemon);

            const task = createTask();

            // Execute: call the actual resolveTargetPubkey implementation
            const result = service.testResolveTargetPubkey(task);

            // Assert: should return original toPubkey since project isn't running
            expect(result).toBe(task.toPubkey);
            expect(mockDaemon.getActiveRuntimes).toHaveBeenCalled();
        });

        it("should return original toPubkey when target agent IS in project", () => {
            const targetPubkey = "target-agent-pubkey";
            const pmPubkey = "pm-agent-pubkey";
            const projectId = "31933:owner:test-project";

            // Setup: context finds the target agent in the project
            const mockContext = {
                getAgentByPubkey: vi.fn().mockImplementation((pubkey: string) => {
                    if (pubkey === targetPubkey) {
                        return { pubkey: targetPubkey, slug: "target-agent" };
                    }
                    return undefined;
                }),
                projectManager: { pubkey: pmPubkey, slug: "pm-agent" },
            };

            const mockRuntime = {
                getContext: vi.fn().mockReturnValue(mockContext),
            };

            const mockDaemon = {
                getActiveRuntimes: vi.fn().mockReturnValue(
                    new Map([[projectId, mockRuntime]])
                ),
            };
            mockGetDaemon.mockReturnValue(mockDaemon);

            const task = createTask({ toPubkey: targetPubkey, projectId });

            // Execute: call the actual resolveTargetPubkey implementation
            const result = service.testResolveTargetPubkey(task);

            // Assert: should return original target since agent is in project
            expect(result).toBe(targetPubkey);
            expect(mockContext.getAgentByPubkey).toHaveBeenCalledWith(targetPubkey);
        });

        it("should return PM pubkey when target agent is NOT in project", () => {
            const externalAgentPubkey = "external-agent-pubkey";
            const pmPubkey = "pm-agent-pubkey";
            const projectId = "31933:owner:test-project";

            // Setup: context does NOT find the target agent (returns undefined)
            const mockContext = {
                getAgentByPubkey: vi.fn().mockReturnValue(undefined), // Agent not found
                projectManager: { pubkey: pmPubkey, slug: "pm-agent" },
            };

            const mockRuntime = {
                getContext: vi.fn().mockReturnValue(mockContext),
            };

            const mockDaemon = {
                getActiveRuntimes: vi.fn().mockReturnValue(
                    new Map([[projectId, mockRuntime]])
                ),
            };
            mockGetDaemon.mockReturnValue(mockDaemon);

            const task = createTask({ toPubkey: externalAgentPubkey, projectId });

            // Execute: call the actual resolveTargetPubkey implementation
            const result = service.testResolveTargetPubkey(task);

            // Assert: should return PM pubkey since target is not in project
            expect(result).toBe(pmPubkey);
            expect(mockContext.getAgentByPubkey).toHaveBeenCalledWith(externalAgentPubkey);
        });

        it("should return original toPubkey when target not in project AND no PM available", () => {
            const externalAgentPubkey = "external-agent-pubkey";
            const projectId = "31933:owner:test-project";

            // Setup: context doesn't find agent AND has no PM
            const mockContext = {
                getAgentByPubkey: vi.fn().mockReturnValue(undefined), // Agent not found
                projectManager: undefined, // No PM configured
            };

            const mockRuntime = {
                getContext: vi.fn().mockReturnValue(mockContext),
            };

            const mockDaemon = {
                getActiveRuntimes: vi.fn().mockReturnValue(
                    new Map([[projectId, mockRuntime]])
                ),
            };
            mockGetDaemon.mockReturnValue(mockDaemon);

            const task = createTask({ toPubkey: externalAgentPubkey, projectId });

            // Execute: call the actual resolveTargetPubkey implementation
            const result = service.testResolveTargetPubkey(task);

            // Assert: should fall back to original target when no PM
            expect(result).toBe(externalAgentPubkey);
        });

        it("should return original toPubkey when context is not available", () => {
            const projectId = "31933:owner:test-project";

            // Setup: runtime exists but context is null
            const mockRuntime = {
                getContext: vi.fn().mockReturnValue(null), // No context
            };

            const mockDaemon = {
                getActiveRuntimes: vi.fn().mockReturnValue(
                    new Map([[projectId, mockRuntime]])
                ),
            };
            mockGetDaemon.mockReturnValue(mockDaemon);

            const task = createTask({ projectId });

            // Execute: call the actual resolveTargetPubkey implementation
            const result = service.testResolveTargetPubkey(task);

            // Assert: should fall back to original target when no context
            expect(result).toBe(task.toPubkey);
        });

        it("should return original toPubkey when daemon throws an error", () => {
            // Setup: getDaemon throws an error
            mockGetDaemon.mockImplementation(() => {
                throw new Error("Daemon not initialized");
            });

            const task = createTask();

            // Execute: call the actual resolveTargetPubkey implementation
            const result = service.testResolveTargetPubkey(task);

            // Assert: should fall back to original target on error (graceful degradation)
            expect(result).toBe(task.toPubkey);
        });

        it("should handle PM with same pubkey as target (edge case)", () => {
            const samePubkey = "same-pubkey-for-both";
            const projectId = "31933:owner:test-project";

            // Setup: agent not found in project, but PM happens to have same pubkey
            const mockContext = {
                getAgentByPubkey: vi.fn().mockReturnValue(undefined), // Agent not found as agent
                projectManager: { pubkey: samePubkey, slug: "pm-agent" },
            };

            const mockRuntime = {
                getContext: vi.fn().mockReturnValue(mockContext),
            };

            const mockDaemon = {
                getActiveRuntimes: vi.fn().mockReturnValue(
                    new Map([[projectId, mockRuntime]])
                ),
            };
            mockGetDaemon.mockReturnValue(mockDaemon);

            const task = createTask({ toPubkey: samePubkey, projectId });

            // Execute: call the actual resolveTargetPubkey implementation
            const result = service.testResolveTargetPubkey(task);

            // Assert: even though target matches PM, if agent isn't found we route to PM
            // (which happens to be the same pubkey - net result is same destination)
            expect(result).toBe(samePubkey);
        });

        it("should correctly route different tasks to different targets based on project membership", () => {
            const projectId = "31933:owner:test-project";
            const inProjectAgentPubkey = "in-project-agent";
            const outsideProjectAgentPubkey = "outside-project-agent";
            const pmPubkey = "pm-agent-pubkey";

            // Setup: context that knows about one agent but not the other
            const mockContext = {
                getAgentByPubkey: vi.fn().mockImplementation((pubkey: string) => {
                    if (pubkey === inProjectAgentPubkey) {
                        return { pubkey: inProjectAgentPubkey, slug: "in-project-agent" };
                    }
                    return undefined; // outsideProjectAgentPubkey not found
                }),
                projectManager: { pubkey: pmPubkey, slug: "pm-agent" },
            };

            const mockRuntime = {
                getContext: vi.fn().mockReturnValue(mockContext),
            };

            const mockDaemon = {
                getActiveRuntimes: vi.fn().mockReturnValue(
                    new Map([[projectId, mockRuntime]])
                ),
            };
            mockGetDaemon.mockReturnValue(mockDaemon);

            // Task 1: target agent IS in project
            const taskInProject = createTask({ toPubkey: inProjectAgentPubkey, projectId });
            const result1 = service.testResolveTargetPubkey(taskInProject);
            expect(result1).toBe(inProjectAgentPubkey);

            // Task 2: target agent is NOT in project
            const taskOutsideProject = createTask({ toPubkey: outsideProjectAgentPubkey, projectId });
            const result2 = service.testResolveTargetPubkey(taskOutsideProject);
            expect(result2).toBe(pmPubkey);

            // Verify the context was queried correctly for both
            expect(mockContext.getAgentByPubkey).toHaveBeenCalledWith(inProjectAgentPubkey);
            expect(mockContext.getAgentByPubkey).toHaveBeenCalledWith(outsideProjectAgentPubkey);
        });
    });

    describe("ScheduledTask structure", () => {
        it("should have all required fields for PM routing", () => {
            const task: ScheduledTask = {
                id: "task-123",
                schedule: "0 9 * * *",
                prompt: "Test prompt",
                fromPubkey: "sender-pubkey",
                toPubkey: "target-pubkey",
                projectId: "31933:owner:test-project",
            };

            // These fields are required for PM routing logic
            expect(task.toPubkey).toBeDefined();
            expect(task.projectId).toBeDefined();
        });

        it("should preserve title for tasks", () => {
            const task: ScheduledTask = {
                id: "task-123",
                title: "Daily standup reminder",
                schedule: "0 9 * * *",
                prompt: "Run daily standup",
                fromPubkey: "sender-pubkey",
                toPubkey: "target-pubkey",
                projectId: "31933:owner:test-project",
            };

            expect(task.title).toBe("Daily standup reminder");
        });
    });
});
