import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
    SchedulerService,
    type ScheduledTask,
    type TargetResolution,
} from "@/services/scheduling/SchedulerService";
import { getProjectContext } from "@/services/projects";
import { logger } from "@/utils/logger";

vi.mock("@/services/projects", () => ({
    getProjectContext: vi.fn(),
}));

vi.mock("@/utils/logger", () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
    },
}));

const mockGetProjectContext = getProjectContext as ReturnType<typeof vi.fn>;
const mockLogger = logger as {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
};

function resolveTargetPubkey(
    service: SchedulerService,
    task: ScheduledTask
): TargetResolution {
    return (service as unknown as {
        resolveTargetPubkey(task: ScheduledTask): TargetResolution;
    }).resolveTargetPubkey(task);
}

describe("SchedulerService target routing", () => {
    let service: SchedulerService;

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
        service = SchedulerService.getInstance();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("resolveTargetPubkey from project context", () => {
        it("returns the target agent from the active project context", () => {
            const targetAgent = {
                slug: "architect",
                pubkey: "target-agent-pubkey",
            };
            mockGetProjectContext.mockReturnValue({
                project: { tagId: () => "31933:owner:test-project" },
                getProjectAgentBySlug: vi.fn().mockReturnValue(targetAgent),
            });

            const result = resolveTargetPubkey(service, createTask());

            expect(result).toEqual({
                pubkey: targetAgent.pubkey,
                resolvedSlug: targetAgent.slug,
            });
            expect(mockLogger.warn).not.toHaveBeenCalled();
        });

        it("normalizes NIP-33 project addresses before comparing context", () => {
            const owner = "b".repeat(64);
            const projectAddress = `31933:${owner}:TENEX-ff3ssq`;
            const targetAgent = {
                slug: "architect",
                pubkey: "target-agent-pubkey",
            };
            mockGetProjectContext.mockReturnValue({
                project: { tagId: () => projectAddress },
                getProjectAgentBySlug: vi.fn().mockReturnValue(targetAgent),
            });

            const result = resolveTargetPubkey(
                service,
                createTask({ projectId: "TENEX-ff3ssq", projectRef: projectAddress })
            );

            expect(result.pubkey).toBe(targetAgent.pubkey);
        });

        it("throws when no active project context is available", () => {
            mockGetProjectContext.mockImplementation(() => {
                throw new Error("No project context");
            });

            const task = createTask();

            expect(() => resolveTargetPubkey(service, task)).toThrow(
                'Could not resolve scheduled task target slug "architect" in the current project context'
            );
            expect(mockLogger.warn).toHaveBeenCalledWith(
                "Failed to resolve target pubkey",
                expect.objectContaining({
                    taskId: task.id,
                    targetAgentSlug: task.targetAgentSlug,
                })
            );
        });

        it("throws when the active project context is for another project", () => {
            mockGetProjectContext.mockReturnValue({
                project: { tagId: () => "different-project" },
                getProjectAgentBySlug: vi.fn(),
            });

            expect(() => resolveTargetPubkey(service, createTask())).toThrow(
                'Could not resolve scheduled task target slug "architect" in the current project context'
            );
        });

        it("throws when the target agent is not in the active project context", () => {
            const getProjectAgentBySlug = vi.fn().mockReturnValue(undefined);
            mockGetProjectContext.mockReturnValue({
                project: { tagId: () => "31933:owner:test-project" },
                getProjectAgentBySlug,
            });

            expect(() => resolveTargetPubkey(service, createTask())).toThrow(
                'Could not resolve scheduled task target slug "architect" in the current project context'
            );
            expect(getProjectAgentBySlug).toHaveBeenCalledWith("architect");
        });
    });

    describe("ScheduledTask structure", () => {
        it("requires targetAgentSlug and projectId for routing", () => {
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

        it("preserves title for tasks", () => {
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
