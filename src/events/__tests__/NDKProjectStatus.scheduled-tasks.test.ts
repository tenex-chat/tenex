import { describe, expect, it } from "bun:test";
import { NDKProjectStatus } from "../NDKProjectStatus";

describe("NDKProjectStatus scheduled task getters", () => {
    it("should return empty array when no scheduled tasks", () => {
        const status = new NDKProjectStatus();
        expect(status.scheduledTasks).toEqual([]);
    });

    it("should parse scheduled task tags correctly", () => {
        const status = new NDKProjectStatus();
        status.tags = [
            [
                "scheduled-task",
                "task-123",
                "Daily standup",
                "0 9 * * *",
                "architect",
                "cron",
                "1740470400",
            ],
        ];

        const tasks = status.scheduledTasks;
        expect(tasks).toHaveLength(1);
        expect(tasks[0]).toEqual({
            id: "task-123",
            title: "Daily standup",
            schedule: "0 9 * * *",
            targetAgentSlug: "architect",
            type: "cron",
            lastRun: 1740470400,
        });
    });

    it("should handle missing lastRun", () => {
        const status = new NDKProjectStatus();
        status.tags = [
            ["scheduled-task", "task-456", "Release", "2026-03-01T12:00:00Z", "reporter", "oneoff", ""],
        ];

        const tasks = status.scheduledTasks;
        expect(tasks).toHaveLength(1);
        expect(tasks[0].lastRun).toBeUndefined();
        expect(tasks[0].type).toBe("oneoff");
    });

    it("should parse multiple scheduled task tags", () => {
        const status = new NDKProjectStatus();
        status.tags = [
            ["agent", "pubkey-1", "pm"],
            ["scheduled-task", "task-1", "Task A", "*/5 * * * *", "pm", "cron", "1740470000"],
            ["model", "gpt-4", "pm"],
            ["scheduled-task", "task-2", "Task B", "0 12 * * *", "reporter", "cron", ""],
            ["scheduled-task", "task-3", "Task C", "2026-04-01T00:00:00Z", "pm", "oneoff", ""],
        ];

        const tasks = status.scheduledTasks;
        expect(tasks).toHaveLength(3);
        expect(tasks[0].id).toBe("task-1");
        expect(tasks[1].id).toBe("task-2");
        expect(tasks[2].id).toBe("task-3");
    });

    it("should add a scheduled task", () => {
        const status = new NDKProjectStatus();
        status.addScheduledTask("task-1", "Daily report", "0 8 * * *", "reporter", "cron", 1740470400);

        expect(status.scheduledTasks).toHaveLength(1);
        const task = status.scheduledTasks[0];
        expect(task.id).toBe("task-1");
        expect(task.title).toBe("Daily report");
        expect(task.schedule).toBe("0 8 * * *");
        expect(task.targetAgentSlug).toBe("reporter");
        expect(task.type).toBe("cron");
        expect(task.lastRun).toBe(1740470400);
    });

    it("should add a scheduled task without lastRun", () => {
        const status = new NDKProjectStatus();
        status.addScheduledTask("task-2", "Future task", "2026-05-01T00:00:00Z", "pm", "oneoff");

        const task = status.scheduledTasks[0];
        expect(task.lastRun).toBeUndefined();
    });

    it("should remove a scheduled task by id", () => {
        const status = new NDKProjectStatus();
        status.addScheduledTask("task-1", "Keep", "0 8 * * *", "pm", "cron");
        status.addScheduledTask("task-2", "Remove", "0 12 * * *", "pm", "cron");
        status.addScheduledTask("task-3", "Keep", "0 18 * * *", "pm", "cron");

        status.removeScheduledTask("task-2");

        expect(status.scheduledTasks).toHaveLength(2);
        expect(status.scheduledTasks[0].id).toBe("task-1");
        expect(status.scheduledTasks[1].id).toBe("task-3");
    });

    it("should clear all scheduled tasks", () => {
        const status = new NDKProjectStatus();
        status.addScheduledTask("task-1", "Task A", "0 8 * * *", "pm", "cron");
        status.addScheduledTask("task-2", "Task B", "0 12 * * *", "reporter", "cron");

        // Also add non-task tags to ensure they survive
        status.tags.push(["agent", "pubkey-1", "pm"]);

        status.clearScheduledTasks();

        expect(status.scheduledTasks).toHaveLength(0);
        // Non-task tags should still be present
        expect(status.tags.some((t) => t[0] === "agent")).toBe(true);
    });

    it("should check if a task exists", () => {
        const status = new NDKProjectStatus();
        status.addScheduledTask("task-1", "Exists", "0 8 * * *", "pm", "cron");

        expect(status.hasScheduledTask("task-1")).toBe(true);
        expect(status.hasScheduledTask("task-nonexistent")).toBe(false);
    });

    it("should get tasks for a specific agent", () => {
        const status = new NDKProjectStatus();
        status.addScheduledTask("task-1", "PM Task 1", "0 8 * * *", "pm", "cron");
        status.addScheduledTask("task-2", "Reporter Task", "0 12 * * *", "reporter", "cron");
        status.addScheduledTask("task-3", "PM Task 2", "0 18 * * *", "pm", "cron");

        const pmTasks = status.getScheduledTasksForAgent("pm");
        expect(pmTasks).toHaveLength(2);
        expect(pmTasks[0].id).toBe("task-1");
        expect(pmTasks[1].id).toBe("task-3");

        const reporterTasks = status.getScheduledTasksForAgent("reporter");
        expect(reporterTasks).toHaveLength(1);
        expect(reporterTasks[0].id).toBe("task-2");

        const noTasks = status.getScheduledTasksForAgent("nonexistent");
        expect(noTasks).toHaveLength(0);
    });

    it("should handle task tags with minimal data (missing optional fields)", () => {
        const status = new NDKProjectStatus();
        // Simulate a tag with only id (edge case)
        status.tags = [["scheduled-task", "task-minimal"]];

        const tasks = status.scheduledTasks;
        expect(tasks).toHaveLength(1);
        expect(tasks[0].id).toBe("task-minimal");
        expect(tasks[0].title).toBe("");
        expect(tasks[0].schedule).toBe("");
        expect(tasks[0].targetAgentSlug).toBe("");
        expect(tasks[0].type).toBe("cron"); // Defaults to cron
        expect(tasks[0].lastRun).toBeUndefined();
    });
});
