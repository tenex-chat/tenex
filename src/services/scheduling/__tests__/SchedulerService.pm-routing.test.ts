import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
    SchedulerService,
    type ScheduledTask,
    type ProjectBootHandler,
    type ProjectStateResolver,
    type TargetPubkeyResolver,
    type TargetResolution,
} from "@/services/scheduling/SchedulerService";

vi.mock("@/utils/logger", () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
    },
}));

import { logger } from "@/utils/logger";

class TestableSchedulerService extends SchedulerService {
    public testResolveTargetPubkey(task: ScheduledTask): TargetResolution {
        return this.resolveTargetPubkey(task);
    }

    public setCallbacks(
        bootHandler: ProjectBootHandler,
        stateResolver: ProjectStateResolver,
        targetResolver: TargetPubkeyResolver
    ): void {
        this.setProjectCallbacks(bootHandler, stateResolver, targetResolver);
    }

    public clearCallbacks(): void {
        // biome-ignore lint/suspicious/noExplicitAny: Testing requires private access
        (this as any).projectBootHandler = null;
        // biome-ignore lint/suspicious/noExplicitAny: Testing requires private access
        (this as any).projectStateResolver = null;
        // biome-ignore lint/suspicious/noExplicitAny: Testing requires private access
        (this as any).targetPubkeyResolver = null;
    }
}

function getTestableInstance(): TestableSchedulerService {
    const instance = SchedulerService.getInstance();

    // biome-ignore lint/suspicious/noExplicitAny: Testing requires prototype manipulation
    (instance as any).testResolveTargetPubkey = function(task: ScheduledTask): TargetResolution {
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

    const createTask = (overrides?: Partial<ScheduledTask>): ScheduledTask => ({
        id: "task-123",
        schedule: "0 9 * * *",
        prompt: "Test prompt",
        fromPubkey: "sender-pubkey-12345678",
        targetAgentSlug: "architect",
        projectId: "31933:owner:test-project",
        projectRef: "31933:owner:test-project",
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
        it("should throw when no resolver is registered", () => {
            const task = createTask();

            expect(() => service.testResolveTargetPubkey(task)).toThrow(
                'Target pubkey resolver not registered for agent slug "architect"'
            );
            expect(mockLogger.warn).toHaveBeenCalledWith(
                "Failed to resolve target pubkey",
                expect.objectContaining({
                    taskId: task.id,
                    targetAgentSlug: task.targetAgentSlug,
                })
            );
        });

        it("should return original agent when resolver resolves the same slug", () => {
            const targetPubkey = "target-agent-pubkey";
            const projectId = "31933:owner:test-project";
            const mockTargetResolver: TargetPubkeyResolver = vi.fn().mockReturnValue({
                pubkey: targetPubkey,
                resolvedSlug: "architect",
                wasRerouted: false,
            });

            service.setCallbacks(vi.fn(), vi.fn(), mockTargetResolver);

            const task = createTask({ targetAgentSlug: "architect", projectId });
            const result = service.testResolveTargetPubkey(task);

            expect(result).toEqual({
                pubkey: targetPubkey,
                resolvedSlug: "architect",
                wasRerouted: false,
            });
            expect(mockTargetResolver).toHaveBeenCalledWith(projectId, "architect");
            expect(mockLogger.info).not.toHaveBeenCalled();
        });

        it("should return PM pubkey when resolver reroutes", () => {
            const pmPubkey = "pm-agent-pubkey";
            const projectId = "31933:owner:test-project";
            const mockTargetResolver: TargetPubkeyResolver = vi.fn().mockReturnValue({
                pubkey: pmPubkey,
                resolvedSlug: "pm",
                wasRerouted: true,
            });

            service.setCallbacks(vi.fn(), vi.fn(), mockTargetResolver);

            const task = createTask({ targetAgentSlug: "external-agent", projectId });
            const result = service.testResolveTargetPubkey(task);

            expect(result).toEqual({
                pubkey: pmPubkey,
                resolvedSlug: "pm",
                wasRerouted: true,
            });
            expect(mockTargetResolver).toHaveBeenCalledWith(projectId, "external-agent");
            expect(mockLogger.info).toHaveBeenCalledWith(
                "Scheduled task target resolved by daemon",
                expect.objectContaining({
                    taskId: task.id,
                    projectId,
                    originalTarget: "external-agent",
                    resolvedSlug: "pm",
                })
            );
        });

        it("should normalize NIP-33 project addresses before target resolution", () => {
            const projectAddress = `31933:${"b".repeat(64)}:TENEX-ff3ssq`;
            const projectDTag = "TENEX-ff3ssq";
            const mockTargetResolver: TargetPubkeyResolver = vi.fn().mockReturnValue({
                pubkey: "pm-agent-pubkey",
                resolvedSlug: "pm",
                wasRerouted: true,
            });

            service.setCallbacks(vi.fn(), vi.fn(), mockTargetResolver);

            const task = createTask({ targetAgentSlug: "external-agent", projectId: projectAddress });
            service.testResolveTargetPubkey(task);

            expect(mockTargetResolver).toHaveBeenCalledWith(projectDTag, "external-agent");
        });

        it("should throw when resolver returns null", () => {
            const task = createTask();
            const mockTargetResolver: TargetPubkeyResolver = vi.fn().mockReturnValue(null);

            service.setCallbacks(vi.fn(), vi.fn(), mockTargetResolver);

            expect(() => service.testResolveTargetPubkey(task)).toThrow(
                'Could not resolve scheduled task target slug "architect"'
            );
        });
    });

    describe("ScheduledTask structure", () => {
        it("should require targetAgentSlug and projectId for routing", () => {
            const task: ScheduledTask = {
                id: "task-123",
                schedule: "0 9 * * *",
                prompt: "Test prompt",
                fromPubkey: "sender-pubkey",
                targetAgentSlug: "architect",
                projectId: "project-1",
            };

            expect(task.targetAgentSlug).toBe("architect");
            expect(task.projectId).toBe("project-1");
        });

        it("should preserve title for tasks", () => {
            const task: ScheduledTask = {
                id: "task-123",
                title: "Daily standup reminder",
                schedule: "0 9 * * *",
                prompt: "Run daily standup",
                fromPubkey: "sender-pubkey",
                targetAgentSlug: "architect",
                projectId: "project-1",
            };

            expect(task.title).toBe("Daily standup reminder");
        });
    });
});
