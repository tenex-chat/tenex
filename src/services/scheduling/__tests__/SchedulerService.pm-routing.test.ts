import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
    SchedulerService,
    type ScheduledTask,
    type ProjectBootHandler,
    type ProjectStateResolver,
    type TargetPubkeyResolver,
} from "@/services/scheduling/SchedulerService";

/**
 * Tests for the PM routing feature in SchedulerService.
 *
 * When a scheduled task runs, if the target agent (toPubkey) is not in the
 * task's project, the event should be routed to the Project Manager (PM)
 * of that project instead.
 *
 * Architecture: SchedulerService uses dependency injection (callbacks)
 * to interact with the daemon layer, avoiding Layer 3 → Layer 4 imports.
 * The target resolution logic is implemented in the daemon layer and injected
 * as a callback to SchedulerService.
 */

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
import { logger } from "@/utils/logger";

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

    /**
     * Public wrapper to set callbacks directly
     */
    public setCallbacks(
        bootHandler: ProjectBootHandler,
        stateResolver: ProjectStateResolver,
        targetResolver: TargetPubkeyResolver
    ): void {
        this.setProjectCallbacks(bootHandler, stateResolver, targetResolver);
    }

    /**
     * Clear all callbacks (for test isolation)
     */
    public clearCallbacks(): void {
        // biome-ignore lint/suspicious/noExplicitAny: Testing requires private access
        (this as any).projectBootHandler = null;
        // biome-ignore lint/suspicious/noExplicitAny: Testing requires private access
        (this as any).projectStateResolver = null;
        // biome-ignore lint/suspicious/noExplicitAny: Testing requires private access
        (this as any).targetPubkeyResolver = null;
    }
}

/**
 * Helper to get a testable instance of SchedulerService.
 * We replace the singleton's prototype to add testability while preserving singleton state.
 */
function getTestableInstance(): TestableSchedulerService {
    // Get the singleton instance
    const instance = SchedulerService.getInstance();

    // Extend its prototype to add the test methods
    // biome-ignore lint/suspicious/noExplicitAny: Testing requires prototype manipulation
    (instance as any).testResolveTargetPubkey = function(task: ScheduledTask): string {
        return TestableSchedulerService.prototype.testResolveTargetPubkey.call(this, task);
    };

    // biome-ignore lint/suspicious/noExplicitAny: Testing requires prototype manipulation
    (instance as any).setCallbacks = function(
        bootHandler: ProjectBootHandler,
        stateResolver: ProjectStateResolver,
        targetResolver: TargetPubkeyResolver
    ): void {
        this.setProjectCallbacks(bootHandler, stateResolver, targetResolver);
    };

    // biome-ignore lint/suspicious/noExplicitAny: Testing requires prototype manipulation
    (instance as any).clearCallbacks = function(): void {
        TestableSchedulerService.prototype.clearCallbacks.call(this);
    };

    return instance as TestableSchedulerService;
}

describe("SchedulerService PM Routing", () => {
    const mockLogger = logger as {
        info: ReturnType<typeof vi.fn>;
        warn: ReturnType<typeof vi.fn>;
        debug: ReturnType<typeof vi.fn>;
        error: ReturnType<typeof vi.fn>;
    };

    let service: TestableSchedulerService;

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
        service = getTestableInstance();
        service.clearCallbacks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("resolveTargetPubkey with injected callbacks", () => {
        it("should return original toPubkey when no resolver is registered", () => {
            // Setup: no callbacks registered (simulating standalone/CLI mode)
            const task = createTask();

            // Execute: call the actual resolveTargetPubkey implementation
            const result = service.testResolveTargetPubkey(task);

            // Assert: should return original toPubkey since no resolver is available
            expect(result).toBe(task.toPubkey);
            expect(mockLogger.debug).toHaveBeenCalledWith(
                "Target pubkey resolver not registered, using original target",
                expect.objectContaining({
                    taskId: task.id,
                    projectId: task.projectId,
                })
            );
        });

        it("should return original toPubkey when resolver returns same pubkey (agent in project)", () => {
            const targetPubkey = "target-agent-pubkey";
            const projectId = "31933:owner:test-project";

            // Setup: resolver returns the same pubkey (agent found in project)
            const mockTargetResolver: TargetPubkeyResolver = vi.fn().mockReturnValue(targetPubkey);

            service.setCallbacks(
                vi.fn(), // bootHandler
                vi.fn(), // stateResolver
                mockTargetResolver
            );

            const task = createTask({ toPubkey: targetPubkey, projectId });

            // Execute
            const result = service.testResolveTargetPubkey(task);

            // Assert: should return original target
            expect(result).toBe(targetPubkey);
            expect(mockTargetResolver).toHaveBeenCalledWith(projectId, targetPubkey);
            // No info log when pubkey is unchanged
            expect(mockLogger.info).not.toHaveBeenCalled();
        });

        it("should return PM pubkey when resolver reroutes (target agent NOT in project)", () => {
            const externalAgentPubkey = "external-agent-pubkey";
            const pmPubkey = "pm-agent-pubkey";
            const projectId = "31933:owner:test-project";

            // Setup: resolver returns PM pubkey (agent not in project)
            const mockTargetResolver: TargetPubkeyResolver = vi.fn().mockReturnValue(pmPubkey);

            service.setCallbacks(
                vi.fn(),
                vi.fn(),
                mockTargetResolver
            );

            const task = createTask({ toPubkey: externalAgentPubkey, projectId });

            // Execute
            const result = service.testResolveTargetPubkey(task);

            // Assert: should return PM pubkey
            expect(result).toBe(pmPubkey);
            expect(mockTargetResolver).toHaveBeenCalledWith(projectId, externalAgentPubkey);
            // Should log rerouting info when pubkey changes
            expect(mockLogger.info).toHaveBeenCalledWith(
                "Scheduled task target resolved by daemon",
                expect.objectContaining({
                    taskId: task.id,
                    projectId,
                })
            );
        });

        it("should return original toPubkey when resolver throws (graceful degradation)", () => {
            const task = createTask();

            // Setup: resolver throws an error
            const mockTargetResolver: TargetPubkeyResolver = vi.fn().mockImplementation(() => {
                throw new Error("Resolver failed");
            });

            service.setCallbacks(
                vi.fn(),
                vi.fn(),
                mockTargetResolver
            );

            // Execute
            const result = service.testResolveTargetPubkey(task);

            // Assert: should fall back to original target on error
            expect(result).toBe(task.toPubkey);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                "Failed to resolve target pubkey, using original",
                expect.objectContaining({
                    taskId: task.id,
                    error: "Resolver failed",
                })
            );
        });

        it("should correctly route different tasks based on resolver response", () => {
            const projectId = "31933:owner:test-project";
            const inProjectAgentPubkey = "in-project-agent";
            const outsideProjectAgentPubkey = "outside-project-agent";
            const pmPubkey = "pm-agent-pubkey";

            // Setup: resolver that routes based on agent membership
            const mockTargetResolver: TargetPubkeyResolver = vi.fn().mockImplementation(
                (_projId: string, originalPubkey: string) => {
                    if (originalPubkey === inProjectAgentPubkey) {
                        // Agent in project - return original
                        return inProjectAgentPubkey;
                    }
                    // Agent not in project - return PM
                    return pmPubkey;
                }
            );

            service.setCallbacks(
                vi.fn(),
                vi.fn(),
                mockTargetResolver
            );

            // Task 1: target agent IS in project
            const taskInProject = createTask({ toPubkey: inProjectAgentPubkey, projectId });
            const result1 = service.testResolveTargetPubkey(taskInProject);
            expect(result1).toBe(inProjectAgentPubkey);

            // Task 2: target agent is NOT in project
            const taskOutsideProject = createTask({ toPubkey: outsideProjectAgentPubkey, projectId });
            const result2 = service.testResolveTargetPubkey(taskOutsideProject);
            expect(result2).toBe(pmPubkey);

            // Verify resolver was called for both
            expect(mockTargetResolver).toHaveBeenCalledWith(projectId, inProjectAgentPubkey);
            expect(mockTargetResolver).toHaveBeenCalledWith(projectId, outsideProjectAgentPubkey);
        });
    });

    describe("Daemon-layer resolver logic (simulated)", () => {
        /**
         * These tests simulate the resolver logic that the daemon layer provides.
         * They verify that the expected resolver behavior correctly handles
         * different project states.
         */

        it("should simulate resolver returning original pubkey when project is not running", () => {
            const projectId = "31933:owner:test-project";
            const targetPubkey = "target-agent-pubkey";

            // Simulate daemon resolver: project not running -> return original
            const mockTargetResolver: TargetPubkeyResolver = vi.fn().mockImplementation(
                (_projId: string, originalPubkey: string) => {
                    // Project not running - return original
                    return originalPubkey;
                }
            );

            service.setCallbacks(
                vi.fn(),
                vi.fn(),
                mockTargetResolver
            );

            const task = createTask({ toPubkey: targetPubkey, projectId });
            const result = service.testResolveTargetPubkey(task);

            expect(result).toBe(targetPubkey);
        });

        it("should simulate resolver returning original pubkey when context is not available", () => {
            const projectId = "31933:owner:test-project";
            const targetPubkey = "target-agent-pubkey";

            // Simulate daemon resolver: no context -> return original
            const mockTargetResolver: TargetPubkeyResolver = vi.fn().mockImplementation(
                (_projId: string, originalPubkey: string) => {
                    // No context available - return original
                    return originalPubkey;
                }
            );

            service.setCallbacks(
                vi.fn(),
                vi.fn(),
                mockTargetResolver
            );

            const task = createTask({ toPubkey: targetPubkey, projectId });
            const result = service.testResolveTargetPubkey(task);

            expect(result).toBe(targetPubkey);
        });

        it("should simulate resolver returning original pubkey when no PM available", () => {
            const projectId = "31933:owner:test-project";
            const externalAgentPubkey = "external-agent-pubkey";

            // Simulate daemon resolver: agent not found AND no PM -> return original
            const mockTargetResolver: TargetPubkeyResolver = vi.fn().mockImplementation(
                (_projId: string, originalPubkey: string) => {
                    // No PM to fallback to - return original
                    return originalPubkey;
                }
            );

            service.setCallbacks(
                vi.fn(),
                vi.fn(),
                mockTargetResolver
            );

            const task = createTask({ toPubkey: externalAgentPubkey, projectId });
            const result = service.testResolveTargetPubkey(task);

            expect(result).toBe(externalAgentPubkey);
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
