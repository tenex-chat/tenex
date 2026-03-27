import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as agentsModule from "@/services/agents";
import { logger } from "@/utils/logger";
import type { ToolExecutionContext } from "@/tools/types";
import { SchedulerService } from "@/services/scheduling";

const mockSchedulerService = {
    addTask: mock().mockResolvedValue("mock-task-id"),
    addOneoffTask: mock().mockResolvedValue("mock-oneoff-task-id"),
};

const mockResolveAgentSlug = mock().mockReturnValue({ pubkey: null, availableSlugs: [] });

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
        triggeringEnvelope: {
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
        mockSchedulerService.addOneoffTask.mockReset().mockResolvedValue("mock-oneoff-task-id");
        mockResolveAgentSlug.mockReset().mockReturnValue({ pubkey: null, availableSlugs: [] });
        spyOn(agentsModule, "resolveAgentSlug").mockImplementation(
            mockResolveAgentSlug as typeof agentsModule.resolveAgentSlug
        );
        spyOn(SchedulerService, "getInstance").mockReturnValue(mockSchedulerService as any);
        spyOn(logger, "info").mockImplementation(() => undefined);
    });

    afterEach(() => {
        mock.restore();
    });

    describe("Detection: cron vs delay", () => {
        it("should detect relative delay format and route to oneoff", async () => {
            const context = createMockContext();
            const tool = createScheduleTaskTool(context);

            const result = await tool.execute({
                prompt: "Remind me",
                when: "5m",
                targetAgent: null,
            });

            expect(result.type).toBe("oneoff");
            expect(mockSchedulerService.addOneoffTask).toHaveBeenCalled();
            expect(mockSchedulerService.addTask).not.toHaveBeenCalled();
        });

        it("should detect cron expression and route to recurring", async () => {
            const context = createMockContext();
            const tool = createScheduleTaskTool(context);

            const result = await tool.execute({
                prompt: "Daily task",
                when: "0 9 * * *",
                targetAgent: null,
            });

            expect(result.type).toBe("cron");
            expect(mockSchedulerService.addTask).toHaveBeenCalled();
            expect(mockSchedulerService.addOneoffTask).not.toHaveBeenCalled();
        });

        it("should throw for invalid when value", async () => {
            const context = createMockContext();
            const tool = createScheduleTaskTool(context);

            await expect(
                tool.execute({
                    prompt: "Test",
                    when: "invalid",
                    targetAgent: null,
                })
            ).rejects.toThrow("Invalid 'when' value");
        });
    });

    describe("Cron mode", () => {
        it("should accept valid cron expressions", async () => {
            const context = createMockContext();
            const tool = createScheduleTaskTool(context);

            const result = await tool.execute({
                prompt: "Daily task",
                when: "0 9 * * *",
                targetAgent: null,
            });

            expect(result.success).toBe(true);
            expect(result.type).toBe("cron");
            expect(result.schedule).toBe("0 9 * * *");
            expect(result.taskId).toBe("mock-task-id");
        });

        it("should accept every-5-minutes cron", async () => {
            const context = createMockContext();
            const tool = createScheduleTaskTool(context);

            const result = await tool.execute({
                prompt: "Frequent task",
                when: "*/5 * * * *",
                targetAgent: null,
            });

            expect(result.success).toBe(true);
            expect(result.type).toBe("cron");
        });

        it("should pass title to scheduler", async () => {
            const context = createMockContext();
            const tool = createScheduleTaskTool(context);

            const result = await tool.execute({
                title: "Morning Standup",
                prompt: "Start daily standup",
                when: "0 9 * * 1-5",
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
    });

    describe("Delay mode", () => {
        it("should handle minutes delay", async () => {
            const context = createMockContext();
            const tool = createScheduleTaskTool(context);

            const result = await tool.execute({
                prompt: "Remind me",
                when: "30m",
                targetAgent: null,
            });

            expect(result.success).toBe(true);
            expect(result.type).toBe("oneoff");
            expect(result.delay).toBe("30m");
            expect(result.delayHuman).toBe("30 minutes");
            expect(result.executeAt).toBeDefined();
            expect(result.executeAtFormatted).toBeDefined();
            expect(result.taskId).toBe("mock-oneoff-task-id");
        });

        it("should handle hours delay", async () => {
            const context = createMockContext();
            const tool = createScheduleTaskTool(context);

            const result = await tool.execute({
                prompt: "Check later",
                when: "2h",
                targetAgent: null,
            });

            expect(result.success).toBe(true);
            expect(result.type).toBe("oneoff");
            expect(result.delay).toBe("2h");
            expect(result.delayHuman).toBe("2 hours");
        });

        it("should handle days delay", async () => {
            const context = createMockContext();
            const tool = createScheduleTaskTool(context);

            const result = await tool.execute({
                prompt: "Follow up",
                when: "1d",
                targetAgent: null,
            });

            expect(result.success).toBe(true);
            expect(result.type).toBe("oneoff");
            expect(result.delay).toBe("1d");
            expect(result.delayHuman).toBe("1 day");
        });

        it("should compute executeAt correctly", async () => {
            const context = createMockContext();
            const tool = createScheduleTaskTool(context);

            const before = Date.now();
            const result = await tool.execute({
                prompt: "Test",
                when: "5m",
                targetAgent: null,
            });
            const after = Date.now();

            const executeAt = new Date(result.executeAt).getTime();
            const expectedMin = before + 5 * 60 * 1000;
            const expectedMax = after + 5 * 60 * 1000;
            expect(executeAt).toBeGreaterThanOrEqual(expectedMin);
            expect(executeAt).toBeLessThanOrEqual(expectedMax);
        });
    });

    describe("Agent resolution", () => {
        it("should resolve valid agent slug to pubkey", async () => {
            mockResolveAgentSlug.mockReturnValue({
                pubkey: mockTargetPubkey,
                availableSlugs: ["architect", "claude-code"],
            });

            const context = createMockContext();
            const tool = createScheduleTaskTool(context);

            const result = await tool.execute({
                prompt: "Daily standup reminder",
                when: "0 9 * * *",
                targetAgent: "architect",
            });

            expect(result.success).toBe(true);
            expect(mockResolveAgentSlug).toHaveBeenCalledWith("architect");
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
            mockResolveAgentSlug.mockReturnValue({
                pubkey: null,
                availableSlugs: ["architect", "claude-code", "explore-agent"],
            });

            const context = createMockContext();
            const tool = createScheduleTaskTool(context);

            try {
                await tool.execute({
                    prompt: "Test task",
                    when: "0 9 * * *",
                    targetAgent: "nonexistent-agent",
                });
                expect(true).toBe(false); // Should not reach here
            } catch (error: any) {
                expect(error.message).toContain("Invalid agent slug");
                expect(error.message).toContain("nonexistent-agent");
                expect(error.message).toContain("Available agent slugs");
                expect(error.message).toContain("architect");
            }
        });

        it("should default to self when no targetAgent specified", async () => {
            const context = createMockContext();
            const tool = createScheduleTaskTool(context);

            const result = await tool.execute({
                prompt: "Self-reminder",
                when: "0 9 * * *",
                targetAgent: null,
            });

            expect(result.success).toBe(true);
            expect(mockResolveAgentSlug).not.toHaveBeenCalled();
            expect(mockSchedulerService.addTask).toHaveBeenCalledWith(
                "0 9 * * *",
                "Self-reminder",
                mockAgentPubkey,
                mockAgentPubkey,
                undefined,
                undefined
            );
        });

        it("should resolve agent for oneoff tasks too", async () => {
            mockResolveAgentSlug.mockReturnValue({
                pubkey: mockTargetPubkey,
                availableSlugs: ["architect"],
            });

            const context = createMockContext();
            const tool = createScheduleTaskTool(context);

            const result = await tool.execute({
                prompt: "Remind architect",
                when: "5m",
                targetAgent: "architect",
            });

            expect(result.success).toBe(true);
            expect(result.type).toBe("oneoff");
            expect(mockResolveAgentSlug).toHaveBeenCalledWith("architect");
            expect(mockSchedulerService.addOneoffTask).toHaveBeenCalledWith(
                expect.any(Date),
                "Remind architect",
                mockAgentPubkey,
                mockTargetPubkey,
                undefined,
                undefined
            );
        });
    });

    describe("Error propagation", () => {
        it("should propagate scheduler errors for cron tasks", async () => {
            mockSchedulerService.addTask.mockRejectedValue(new Error("Database connection failed"));

            const context = createMockContext();
            const tool = createScheduleTaskTool(context);

            await expect(
                tool.execute({
                    prompt: "Test task",
                    when: "0 9 * * *",
                    targetAgent: null,
                })
            ).rejects.toThrow("Database connection failed");
        });

        it("should propagate scheduler errors for oneoff tasks", async () => {
            mockSchedulerService.addOneoffTask.mockRejectedValue(new Error("Storage full"));

            const context = createMockContext();
            const tool = createScheduleTaskTool(context);

            await expect(
                tool.execute({
                    prompt: "Test task",
                    when: "5m",
                    targetAgent: null,
                })
            ).rejects.toThrow("Storage full");
        });
    });
});
