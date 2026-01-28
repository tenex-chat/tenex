import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { ToolExecutionContext } from "@/tools/types";

// Mock dependencies before imports
mock.module("@/utils/logger", () => ({
    logger: {
        info: () => {},
        debug: () => {},
        warn: () => {},
        error: () => {},
    },
}));

// Mock SchedulerService
const mockSchedulerService = {
    addTask: mock().mockResolvedValue("mock-task-id"),
};

mock.module("@/services/scheduling", () => ({
    SchedulerService: {
        getInstance: () => mockSchedulerService,
    },
}));

// Mock resolveAgentSlug from agents module - use holder pattern like learn.test.ts
const agentMocks = {
    resolveAgentSlug: mock().mockReturnValue({ pubkey: null, availableSlugs: [] }),
};

mock.module("@/services/agents", () => ({
    resolveAgentSlug: (...args: any[]) => agentMocks.resolveAgentSlug(...args),
}));

import { createScheduleTaskTool } from "../schedule_task";

describe("Schedule Task Tool", () => {
    const mockAgentPubkey = "82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2";
    const mockTargetPubkey = "feb842e2e624cb58e364f8f7cb363c03407be9519ad48326f518f976b3551059";

    const createMockContext = (): ToolExecutionContext => ({
        agent: {
            name: "Test Agent",
            slug: "test-agent",
            pubkey: mockAgentPubkey,
            eventId: "mock-agent-event-id",
            llmConfig: { model: "gpt-4" },
        } as any,
        conversationId: "mock-conversation-id",
        conversationCoordinator: {} as any,
        triggeringEvent: {
            id: "mock-triggering-event-id",
            tags: [],
        } as any,
        agentPublisher: {} as any,
        ralNumber: 1,
        projectBasePath: "/tmp/test",
        workingDirectory: "/tmp/test",
        currentBranch: "main",
        getConversation: () => ({
            getRootEventId: () => "mock-root-event-id",
        }) as any,
    } as ToolExecutionContext);

    beforeEach(() => {
        mockSchedulerService.addTask.mockReset().mockResolvedValue("mock-task-id");
        agentMocks.resolveAgentSlug.mockReset().mockReturnValue({ pubkey: null, availableSlugs: [] });
    });

    describe("Agent slug resolution", () => {
        it("should resolve valid agent slug to pubkey", async () => {
            const availableSlugs = ["architect", "claude-code", "explore-agent"];
            agentMocks.resolveAgentSlug.mockReturnValue({
                pubkey: mockTargetPubkey,
                availableSlugs,
            });

            const context = createMockContext();
            const tool = createScheduleTaskTool(context);

            const result = await tool.execute({
                prompt: "Daily standup reminder",
                schedule: "0 9 * * *",
                targetAgent: "architect",
            });

            expect(result.success).toBe(true);
            expect(result.taskId).toBe("mock-task-id");
            expect(agentMocks.resolveAgentSlug).toHaveBeenCalledWith("architect");
            expect(mockSchedulerService.addTask).toHaveBeenCalledWith(
                "0 9 * * *",
                "Daily standup reminder",
                mockAgentPubkey,
                mockTargetPubkey,
                undefined,
                undefined
            );
        });

        it("should throw for invalid agent slug with available-slugs hint", async () => {
            const availableSlugs = ["architect", "claude-code", "explore-agent"];
            agentMocks.resolveAgentSlug.mockReturnValue({
                pubkey: null,
                availableSlugs,
            });

            const context = createMockContext();
            const tool = createScheduleTaskTool(context);

            await expect(
                tool.execute({
                    prompt: "Test task",
                    schedule: "0 9 * * *",
                    targetAgent: "nonexistent-agent",
                })
            ).rejects.toThrow("Invalid agent slug");

            // Verify error message contains helpful info
            try {
                await tool.execute({
                    prompt: "Test task",
                    schedule: "0 9 * * *",
                    targetAgent: "nonexistent-agent",
                });
            } catch (error: any) {
                expect(error.message).toContain("nonexistent-agent");
                expect(error.message).toContain("Available agent slugs");
                expect(error.message).toContain("architect");
                expect(error.message).toContain("claude-code");
            }
        });

        it("should throw for pubkey input (only slugs accepted)", async () => {
            agentMocks.resolveAgentSlug.mockReturnValue({
                pubkey: null, // Pubkeys aren't slugs, so resolution returns null
                availableSlugs: ["architect", "claude-code"],
            });

            const context = createMockContext();
            const tool = createScheduleTaskTool(context);

            await expect(
                tool.execute({
                    prompt: "Test task",
                    schedule: "0 9 * * *",
                    targetAgent: mockTargetPubkey, // Using pubkey instead of slug
                })
            ).rejects.toThrow("Invalid agent slug");
        });

        it("should default to self when no targetAgent specified", async () => {
            const context = createMockContext();
            const tool = createScheduleTaskTool(context);

            const result = await tool.execute({
                prompt: "Self-reminder",
                schedule: "0 9 * * *",
                targetAgent: null,
            });

            expect(result.success).toBe(true);
            expect(agentMocks.resolveAgentSlug).not.toHaveBeenCalled();
            expect(mockSchedulerService.addTask).toHaveBeenCalledWith(
                "0 9 * * *",
                "Self-reminder",
                mockAgentPubkey,
                mockAgentPubkey, // Self
                undefined,
                undefined
            );
        });
    });

    describe("Cron validation", () => {
        it("should throw for invalid cron expression", async () => {
            const context = createMockContext();
            const tool = createScheduleTaskTool(context);

            await expect(
                tool.execute({
                    prompt: "Test task",
                    schedule: "invalid-cron",
                    targetAgent: null,
                })
            ).rejects.toThrow("Invalid cron expression");
        });

        it("should accept valid cron expressions", async () => {
            const context = createMockContext();
            const tool = createScheduleTaskTool(context);

            // Daily at 9am
            const result1 = await tool.execute({
                prompt: "Daily task",
                schedule: "0 9 * * *",
                targetAgent: null,
            });
            expect(result1.success).toBe(true);

            // Every 5 minutes
            const result2 = await tool.execute({
                prompt: "Frequent task",
                schedule: "*/5 * * * *",
                targetAgent: null,
            });
            expect(result2.success).toBe(true);
        });
    });

    describe("Task creation", () => {
        it("should pass title to scheduler when provided", async () => {
            const context = createMockContext();
            const tool = createScheduleTaskTool(context);

            const result = await tool.execute({
                title: "Morning Standup",
                prompt: "Start daily standup",
                schedule: "0 9 * * 1-5",
                targetAgent: null,
            });

            expect(result.success).toBe(true);
            expect(result.title).toBe("Morning Standup");
            expect(mockSchedulerService.addTask).toHaveBeenCalledWith(
                "0 9 * * 1-5",
                "Start daily standup",
                mockAgentPubkey,
                mockAgentPubkey,
                undefined,
                "Morning Standup"
            );
        });

        it("should propagate scheduler errors", async () => {
            mockSchedulerService.addTask.mockRejectedValue(new Error("Database connection failed"));

            const context = createMockContext();
            const tool = createScheduleTaskTool(context);

            await expect(
                tool.execute({
                    prompt: "Test task",
                    schedule: "0 9 * * *",
                    targetAgent: null,
                })
            ).rejects.toThrow("Database connection failed");
        });
    });
});
