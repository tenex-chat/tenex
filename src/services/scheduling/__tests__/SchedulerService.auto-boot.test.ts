import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { ProjectAlreadyRunningError } from "../errors";
import {
    SchedulerService,
    type ScheduledTask,
    type ProjectBootHandler,
    type ProjectStateResolver,
    type TargetPubkeyResolver,
} from "../SchedulerService";

vi.mock("node:fs/promises", () => ({
    readFile: vi.fn().mockResolvedValue("[]"),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
}));

/**
 * Tests for the auto-boot feature in SchedulerService.
 *
 * When a scheduled task fires but the target project is not running,
 * the service should boot up the project before executing the task.
 *
 * Architecture: SchedulerService uses dependency injection (callbacks)
 * to interact with the daemon layer, avoiding Layer 3 → Layer 4 imports.
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

// Mock getNDK to avoid NDK initialization errors
vi.mock("@/nostr/ndkClient", () => ({
    getNDK: vi.fn().mockReturnValue({
        // Minimal mock of NDK interface
        pool: {
            relays: new Map(),
        },
    }),
}));

// Import after mocking
import { logger } from "@/utils/logger";

/**
 * Testable subclass that exposes private methods for testing.
 */
class TestableSchedulerService extends SchedulerService {
    /**
     * Public wrapper to test the private ensureProjectRunning method.
     */
    public async testEnsureProjectRunning(projectId: string): Promise<boolean> {
        // biome-ignore lint/suspicious/noExplicitAny: Testing requires private access
        return (this as any).ensureProjectRunning(projectId);
    }

    /**
     * Public wrapper to test the private executeTask method.
     */
    public async testExecuteTask(task: ScheduledTask): Promise<void> {
        // biome-ignore lint/suspicious/noExplicitAny: Testing requires private access
        return (this as any).executeTask(task);
    }

    /**
     * Public wrapper to spy on ensureProjectRunning by replacing it.
     */
    public spyOnEnsureProjectRunning(spy: Mock): void {
        // biome-ignore lint/suspicious/noExplicitAny: Testing requires private access
        (this as any).ensureProjectRunning = spy;
    }

    /**
     * Public wrapper to spy on publishAgentTriggerEvent by replacing it.
     */
    public spyOnPublishAgentTriggerEvent(spy: Mock): void {
        // biome-ignore lint/suspicious/noExplicitAny: Testing requires private access
        (this as any).publishAgentTriggerEvent = spy;
    }

    /**
     * Public wrapper to set callbacks directly (uses the actual setProjectCallbacks method)
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
 */
function getTestableInstance(): TestableSchedulerService {
    const instance = SchedulerService.getInstance();

    // Add testable methods to the singleton
    // biome-ignore lint/suspicious/noExplicitAny: Testing requires prototype manipulation
    (instance as any).testEnsureProjectRunning = async function(projectId: string): Promise<boolean> {
        return TestableSchedulerService.prototype.testEnsureProjectRunning.call(this, projectId);
    };

    // biome-ignore lint/suspicious/noExplicitAny: Testing requires prototype manipulation
    (instance as any).testExecuteTask = async function(task: ScheduledTask): Promise<void> {
        return TestableSchedulerService.prototype.testExecuteTask.call(this, task);
    };

    // biome-ignore lint/suspicious/noExplicitAny: Testing requires prototype manipulation
    (instance as any).spyOnEnsureProjectRunning = function(spy: Mock): void {
        TestableSchedulerService.prototype.spyOnEnsureProjectRunning.call(this, spy);
    };

    // biome-ignore lint/suspicious/noExplicitAny: Testing requires prototype manipulation
    (instance as any).spyOnPublishAgentTriggerEvent = function(spy: Mock): void {
        TestableSchedulerService.prototype.spyOnPublishAgentTriggerEvent.call(this, spy);
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

describe("SchedulerService Auto-Boot", () => {
    const mockLogger = logger as {
        info: ReturnType<typeof vi.fn>;
        warn: ReturnType<typeof vi.fn>;
        debug: ReturnType<typeof vi.fn>;
        error: ReturnType<typeof vi.fn>;
    };

    // Reference to service for clearing callbacks
    let testService: TestableSchedulerService;

    beforeEach(() => {
        vi.clearAllMocks();
        // Clear callbacks before each test to ensure test isolation
        testService = getTestableInstance();
        testService.clearCallbacks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("ensureProjectRunning", () => {
        let service: TestableSchedulerService;

        beforeEach(() => {
            service = getTestableInstance();
        });

        it("should skip auto-boot when callbacks are not registered", async () => {
            const projectId = "31933:owner:test-project";

            // Don't register any callbacks
            const result = await service.testEnsureProjectRunning(projectId);

            expect(result).toBe(true);

            // Should log debug message about callbacks not being registered
            expect(mockLogger.debug).toHaveBeenCalledWith(
                "Project callbacks not registered, skipping auto-boot",
                { projectId }
            );
        });

        it("should not start runtime when project is already running", async () => {
            const projectId = "31933:owner:test-project";
            const mockBootHandler = vi.fn();
            const mockStateResolver = vi.fn().mockReturnValue(true); // Project running
            const mockTargetResolver = vi.fn();

            service.setCallbacks(mockBootHandler, mockStateResolver, mockTargetResolver);

            const result = await service.testEnsureProjectRunning(projectId);

            expect(result).toBe(true);
            // State was checked but boot was NOT called
            expect(mockStateResolver).toHaveBeenCalledWith(projectId);
            expect(mockBootHandler).not.toHaveBeenCalled();
            expect(mockLogger.info).not.toHaveBeenCalledWith(
                "Project not running, booting for scheduled task",
                expect.anything()
            );
        });

        it("should start runtime when project is NOT running", async () => {
            const projectId = "31933:owner:test-project";
            const mockBootHandler = vi.fn().mockResolvedValue(undefined);
            const mockStateResolver = vi.fn().mockReturnValue(false); // Project NOT running
            const mockTargetResolver = vi.fn();

            service.setCallbacks(mockBootHandler, mockStateResolver, mockTargetResolver);

            const result = await service.testEnsureProjectRunning(projectId);

            expect(result).toBe(true);
            // Both state check and boot should be called
            expect(mockStateResolver).toHaveBeenCalledWith(projectId);
            expect(mockBootHandler).toHaveBeenCalledWith(projectId);
            expect(mockLogger.info).toHaveBeenCalledWith(
                "Project not running, booting for scheduled task",
                { projectId }
            );
            expect(mockLogger.info).toHaveBeenCalledWith(
                "Project booted successfully for scheduled task",
                { projectId }
            );
        });

        it("should return false and log warning when boot handler fails and project still not running", async () => {
            const projectId = "31933:owner:test-project";
            const mockError = new Error("Failed to start runtime");
            const mockBootHandler = vi.fn().mockRejectedValue(mockError);
            const mockStateResolver = vi.fn().mockReturnValue(false);
            const mockTargetResolver = vi.fn();

            service.setCallbacks(mockBootHandler, mockStateResolver, mockTargetResolver);

            // Execute - should NOT throw, but should return false
            const result = await service.testEnsureProjectRunning(projectId);

            expect(result).toBe(false);
            expect(mockBootHandler).toHaveBeenCalledWith(projectId);
            // Warning logged without "continuing anyway" - task will be skipped by caller
            expect(mockLogger.warn).toHaveBeenCalledWith(
                "Failed to auto-boot project for scheduled task",
                {
                    projectId,
                    error: "Failed to start runtime",
                }
            );
            // State checked twice: initial check + final check after error
            expect(mockStateResolver).toHaveBeenCalledTimes(2);
        });

        it("should treat ProjectAlreadyRunningError as benign (race condition)", async () => {
            const projectId = "31933:owner:test-project";
            const mockError = new ProjectAlreadyRunningError(projectId);
            const mockBootHandler = vi.fn().mockRejectedValue(mockError);
            // First call: not running; second call (after error): running
            const mockStateResolver = vi.fn()
                .mockReturnValueOnce(false)
                .mockReturnValueOnce(true);
            const mockTargetResolver = vi.fn();

            service.setCallbacks(mockBootHandler, mockStateResolver, mockTargetResolver);

            // Execute - should NOT throw, and should succeed since project is now running
            const result = await service.testEnsureProjectRunning(projectId);

            expect(result).toBe(true);
            // Should re-check state after "already running" error
            expect(mockStateResolver).toHaveBeenCalledTimes(2);
            // Should log debug (not warn) for race condition
            expect(mockLogger.debug).toHaveBeenCalledWith(
                "Project was already running (race condition, benign)",
                { projectId }
            );
            // Should NOT log warning for this benign case
            expect(mockLogger.warn).not.toHaveBeenCalled();
        });

        it("should return false if ProjectAlreadyRunningError but project still not running after all checks", async () => {
            const projectId = "31933:owner:test-project";
            const mockError = new ProjectAlreadyRunningError(projectId);
            const mockBootHandler = vi.fn().mockRejectedValue(mockError);
            // All calls: not running (edge case - error but project not actually running)
            const mockStateResolver = vi.fn().mockReturnValue(false);
            const mockTargetResolver = vi.fn();

            service.setCallbacks(mockBootHandler, mockStateResolver, mockTargetResolver);

            const result = await service.testEnsureProjectRunning(projectId);

            expect(result).toBe(false);
            // Should check state 3 times: initial check, re-check after ProjectAlreadyRunningError,
            // and final check after logging the warning
            expect(mockStateResolver).toHaveBeenCalledTimes(3);
            // Should log warning since project is NOT running (no "continuing anyway")
            expect(mockLogger.warn).toHaveBeenCalledWith(
                "Failed to auto-boot project for scheduled task",
                {
                    projectId,
                    error: expect.stringContaining("already running"),
                }
            );
        });

        it("should NOT add artificial delay after boot (readiness is start() completion)", async () => {
            const projectId = "31933:owner:test-project";
            let bootCallTime = 0;
            let bootResolveTime = 0;

            const mockBootHandler = vi.fn().mockImplementation(async () => {
                bootCallTime = Date.now();
                // Simulate some startup time
                await new Promise(resolve => setTimeout(resolve, 10));
                bootResolveTime = Date.now();
            });
            const mockStateResolver = vi.fn().mockReturnValue(false);
            const mockTargetResolver = vi.fn();

            service.setCallbacks(mockBootHandler, mockStateResolver, mockTargetResolver);

            const startTime = Date.now();
            await service.testEnsureProjectRunning(projectId);
            const endTime = Date.now();

            // Total time should be close to boot time, NOT boot time + 2000ms
            // Allow 100ms tolerance for test execution overhead
            const totalTime = endTime - startTime;
            const bootTime = bootResolveTime - bootCallTime;

            expect(totalTime).toBeLessThan(bootTime + 100); // No artificial delay
            expect(totalTime).toBeLessThan(500); // Definitely less than the old 2000ms delay
        });
    });

    describe("resolveTargetPubkey", () => {
        let service: TestableSchedulerService;

        beforeEach(() => {
            service = getTestableInstance();
        });

        it("should return original target when no resolver is registered", () => {
            const task: ScheduledTask = {
                id: "task-1",
                schedule: "* * * * *",
                prompt: "test",
                fromPubkey: "from123",
                toPubkey: "originalTarget123",
                projectId: "31933:owner:project",
            };

            // biome-ignore lint/suspicious/noExplicitAny: Testing protected method
            const result = (service as any).resolveTargetPubkey(task);

            expect(result).toBe("originalTarget123");
            expect(mockLogger.debug).toHaveBeenCalledWith(
                "Target pubkey resolver not registered, using original target",
                expect.anything()
            );
        });

        it("should use resolver when registered and log rerouting", () => {
            const task: ScheduledTask = {
                id: "task-1",
                schedule: "* * * * *",
                prompt: "test",
                fromPubkey: "from123",
                toPubkey: "originalTarget123",
                projectId: "31933:owner:project",
            };

            const pmPubkey = "pmPubkey456";
            const mockBootHandler = vi.fn();
            const mockStateResolver = vi.fn();
            const mockTargetResolver = vi.fn().mockReturnValue(pmPubkey);

            service.setCallbacks(mockBootHandler, mockStateResolver, mockTargetResolver);

            // biome-ignore lint/suspicious/noExplicitAny: Testing protected method
            const result = (service as any).resolveTargetPubkey(task);

            expect(result).toBe(pmPubkey);
            expect(mockTargetResolver).toHaveBeenCalledWith(task.projectId, task.toPubkey);
            // Should log info about rerouting (pubkey changed)
            expect(mockLogger.info).toHaveBeenCalledWith(
                "Scheduled task target resolved by daemon",
                expect.objectContaining({
                    taskId: task.id,
                    projectId: task.projectId,
                })
            );
        });

        it("should not log rerouting when pubkey is unchanged", () => {
            const task: ScheduledTask = {
                id: "task-1",
                schedule: "* * * * *",
                prompt: "test",
                fromPubkey: "from123",
                toPubkey: "originalTarget123",
                projectId: "31933:owner:project",
            };

            const mockBootHandler = vi.fn();
            const mockStateResolver = vi.fn();
            // Resolver returns the same pubkey
            const mockTargetResolver = vi.fn().mockReturnValue(task.toPubkey);

            service.setCallbacks(mockBootHandler, mockStateResolver, mockTargetResolver);

            // biome-ignore lint/suspicious/noExplicitAny: Testing protected method
            const result = (service as any).resolveTargetPubkey(task);

            expect(result).toBe(task.toPubkey);
            // Should NOT log rerouting info
            expect(mockLogger.info).not.toHaveBeenCalled();
        });

        it("should fall back to original target when resolver throws", () => {
            const task: ScheduledTask = {
                id: "task-1",
                schedule: "* * * * *",
                prompt: "test",
                fromPubkey: "from123",
                toPubkey: "originalTarget123",
                projectId: "31933:owner:project",
            };

            const mockBootHandler = vi.fn();
            const mockStateResolver = vi.fn();
            const mockTargetResolver = vi.fn().mockImplementation(() => {
                throw new Error("Resolver failed");
            });

            service.setCallbacks(mockBootHandler, mockStateResolver, mockTargetResolver);

            // biome-ignore lint/suspicious/noExplicitAny: Testing protected method
            const result = (service as any).resolveTargetPubkey(task);

            expect(result).toBe(task.toPubkey);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                "Failed to resolve target pubkey, using original",
                expect.objectContaining({
                    taskId: task.id,
                    error: "Resolver failed",
                })
            );
        });
    });

    describe("Integration: ensureProjectRunning called before task execution", () => {
        it("should call ensureProjectRunning before publishAgentTriggerEvent", async () => {
            // This test verifies the integration is in place by checking that
            // the ensureProjectRunning method is called when callbacks are registered

            const service = getTestableInstance();
            const projectId = "31933:owner:test-project";

            // Track call order
            const callOrder: string[] = [];

            const mockBootHandler = vi.fn().mockImplementation(async () => {
                callOrder.push("boot");
            });
            const mockStateResolver = vi.fn().mockImplementation(() => {
                callOrder.push("check");
                return false; // Not running, will trigger boot
            });
            const mockTargetResolver = vi.fn();

            service.setCallbacks(mockBootHandler, mockStateResolver, mockTargetResolver);

            await service.testEnsureProjectRunning(projectId);

            // Verify the sequence: check state first, then boot
            expect(callOrder).toEqual(["check", "boot"]);
            expect(mockStateResolver).toHaveBeenCalledWith(projectId);
            expect(mockBootHandler).toHaveBeenCalledWith(projectId);
        });

        it("should call ensureProjectRunning BEFORE publishAgentTriggerEvent in executeTask", async () => {
            // This test verifies that executeTask() actually calls ensureProjectRunning()
            // before publishing. This catches regressions if the call is accidentally removed.

            const service = getTestableInstance();

            const task: ScheduledTask = {
                id: "task-1",
                schedule: "* * * * *",
                prompt: "test prompt",
                fromPubkey: "from123",
                toPubkey: "to456",
                projectId: "31933:owner:test-project",
            };

            // Track call order
            const callOrder: string[] = [];

            // Spy on ensureProjectRunning - must return true so task proceeds to publish
            const ensureProjectRunningSpy = vi.fn().mockImplementation(async () => {
                callOrder.push("ensureProjectRunning");
                return true;
            });
            service.spyOnEnsureProjectRunning(ensureProjectRunningSpy);

            // Spy on publishAgentTriggerEvent
            const publishSpy = vi.fn().mockImplementation(async () => {
                callOrder.push("publishAgentTriggerEvent");
            });
            service.spyOnPublishAgentTriggerEvent(publishSpy);

            // Execute the task
            await service.testExecuteTask(task);

            // Verify ensureProjectRunning was called
            expect(ensureProjectRunningSpy).toHaveBeenCalledTimes(1);
            expect(ensureProjectRunningSpy).toHaveBeenCalledWith(task.projectId);

            // Verify publishAgentTriggerEvent was called
            expect(publishSpy).toHaveBeenCalledTimes(1);
            expect(publishSpy).toHaveBeenCalledWith(task);

            // CRITICAL: Verify the ORDER - ensureProjectRunning MUST come first
            expect(callOrder).toEqual(["ensureProjectRunning", "publishAgentTriggerEvent"]);
        });

        it("should skip task when ensureProjectRunning throws, without calling publishAgentTriggerEvent", async () => {
            // When ensureProjectRunning throws, executeTask skips publishing
            // to prevent executing in an unknown project state.

            const service = getTestableInstance();

            const task: ScheduledTask = {
                id: "task-2",
                schedule: "* * * * *",
                prompt: "test prompt",
                fromPubkey: "from123",
                toPubkey: "to456",
                projectId: "31933:owner:test-project",
            };

            // Spy on ensureProjectRunning - simulate it THROWING an error
            const ensureProjectRunningSpy = vi.fn().mockImplementation(async () => {
                throw new Error("Boot failed: unable to start project");
            });
            service.spyOnEnsureProjectRunning(ensureProjectRunningSpy);

            // Spy on publishAgentTriggerEvent - should NOT be called when project can't start
            const publishSpy = vi.fn();
            service.spyOnPublishAgentTriggerEvent(publishSpy);

            // Execute the task - should NOT throw despite ensureProjectRunning failing
            await service.testExecuteTask(task);

            // ensureProjectRunning was called and threw
            expect(ensureProjectRunningSpy).toHaveBeenCalledTimes(1);

            // publishAgentTriggerEvent should NOT be called - task is skipped
            expect(publishSpy).not.toHaveBeenCalled();

            // Should log skip warning
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.stringContaining("Skipping scheduled task execution"),
                expect.objectContaining({
                    taskId: task.id,
                    projectId: task.projectId,
                })
            );
        });
    });
});
