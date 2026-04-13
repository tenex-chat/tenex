import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ScheduledTask } from "../types";

/**
 * Tests for the write-through architecture in SchedulerService.
 *
 * The write-through pattern ensures that JSON files are always the authoritative
 * source of truth. All mutations follow: write JSON → reload JSON → reconcile memory.
 */

// Mock logger to suppress output
vi.mock("@/utils/logger", () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
    },
}));

// Mock NDK to avoid initialization errors
vi.mock("@/nostr/ndkClient", () => ({
    getNDK: vi.fn().mockReturnValue({
        pool: { relays: new Map() },
    }),
}));

// Control file system operations
vi.mock("@/lib/fs/filesystem", () => ({
    fileExists: vi.fn(),
    readJsonFile: vi.fn(),
    writeJsonFile: vi.fn(),
    ensureDirectory: vi.fn().mockResolvedValue(undefined),
    directoryExists: vi.fn().mockResolvedValue(false),
}));

// Control config paths
vi.mock("@/services/ConfigService", () => ({
    config: {
        getConfigPath: vi.fn().mockImplementation((sub?: string) =>
            sub ? `/fake-config/${sub}` : "/fake-config"
        ),
        getProjectMetadataPath: vi.fn().mockImplementation((projectId: string) =>
            `/fake-config/projects/${projectId}`
        ),
    },
}));

// Import after mocking
import { logger } from "@/utils/logger";
import { fileExists, readJsonFile, writeJsonFile } from "@/lib/fs/filesystem";
import { SchedulerService } from "../SchedulerService";

const mockFileExists = fileExists as ReturnType<typeof vi.fn>;
const mockReadJsonFile = readJsonFile as ReturnType<typeof vi.fn>;
const mockWriteJsonFile = writeJsonFile as ReturnType<typeof vi.fn>;
const mockLogger = logger as {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
};

/** Build a minimal valid cron ScheduledTask */
function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
    return {
        id: overrides.id ?? "task-1",
        schedule: overrides.schedule ?? "0 9 * * *",
        prompt: overrides.prompt ?? "Test prompt",
        fromPubkey: overrides.fromPubkey ?? "abc123",
        targetAgentSlug: overrides.targetAgentSlug ?? "test-agent",
        projectId: overrides.projectId ?? "test-project",
        type: overrides.type ?? "cron",
        ...overrides,
    };
}

/** Access private members of SchedulerService for test assertions */
function getPrivate(service: SchedulerService) {
    // biome-ignore lint/suspicious/noExplicitAny: test access to private members
    return service as any;
}

describe("SchedulerService Write-Through", () => {
    let service: SchedulerService;

    beforeEach(() => {
        vi.clearAllMocks();

        // Reset singleton state between tests
        const instance = SchedulerService.getInstance();
        const priv = getPrivate(instance);
        priv.tasks.clear();
        priv.oneoffTimers.clear();
        priv.taskMetadata.clear();
        service = instance;

        // Default: file doesn't exist
        mockFileExists.mockResolvedValue(false);
        mockWriteJsonFile.mockResolvedValue(undefined);
    });

    afterEach(() => {
        // Stop all running cron tasks to avoid timer leaks
        const priv = getPrivate(service);
        for (const cronTask of priv.tasks.values()) {
            cronTask.stop();
        }
        for (const timer of priv.oneoffTimers.values()) {
            clearTimeout(timer);
        }
    });

    // -------------------------------------------------------------------------
    // reloadTasksFromJson
    // -------------------------------------------------------------------------

    describe("reloadTasksFromJson", () => {
        it("returns empty array when file does not exist", async () => {
            mockFileExists.mockResolvedValue(false);

            const result = await service.reloadTasksFromJson("test-project");

            expect(result).toEqual([]);
        });

        it("returns valid tasks from JSON file", async () => {
            const task = makeTask();
            mockFileExists.mockResolvedValue(true);
            mockReadJsonFile.mockResolvedValue([task]);

            const result = await service.reloadTasksFromJson("test-project");

            expect(result).toHaveLength(1);
            expect(result[0].id).toBe("task-1");
        });

        it("skips tasks with missing required fields and logs warning", async () => {
            const invalidTask = { id: "bad-task", prompt: "missing fields" }; // no fromPubkey, targetAgentSlug, projectId
            const validTask = makeTask({ id: "good-task" });
            mockFileExists.mockResolvedValue(true);
            mockReadJsonFile.mockResolvedValue([invalidTask, validTask]);

            const result = await service.reloadTasksFromJson("test-project");

            expect(result).toHaveLength(1);
            expect(result[0].id).toBe("good-task");
            expect(mockLogger.warn).toHaveBeenCalledWith(
                "Skipping schedule with missing required fields",
                { taskId: "bad-task" }
            );
        });

        it("skips task missing targetAgentSlug and logs warning", async () => {
            const taskWithoutSlug = makeTask({ targetAgentSlug: undefined as unknown as string });
            // Make the spread miss targetAgentSlug:
            const raw = { ...taskWithoutSlug };
            delete (raw as Partial<ScheduledTask>).targetAgentSlug;
            mockFileExists.mockResolvedValue(true);
            mockReadJsonFile.mockResolvedValue([raw]);

            const result = await service.reloadTasksFromJson("test-project");

            expect(result).toHaveLength(0);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                "Skipping schedule with missing required fields",
                expect.anything()
            );
        });

        it("skips cron tasks with invalid cron expression and logs warning", async () => {
            const invalidCronTask = makeTask({ id: "bad-cron", schedule: "invalid schedule", type: "cron" });
            const validTask = makeTask({ id: "good-cron", schedule: "0 10 * * *" });
            mockFileExists.mockResolvedValue(true);
            mockReadJsonFile.mockResolvedValue([invalidCronTask, validTask]);

            const result = await service.reloadTasksFromJson("test-project");

            expect(result).toHaveLength(1);
            expect(result[0].id).toBe("good-cron");
            expect(mockLogger.warn).toHaveBeenCalledWith(
                "Skipping schedule with invalid cron expression",
                { taskId: "bad-cron", schedule: "invalid schedule" }
            );
        });

        it("does NOT validate cron expression for oneoff tasks", async () => {
            // oneoff tasks use executeAt (a date string), not a cron expression
            const oneoffTask: ScheduledTask = {
                ...makeTask({ id: "oneoff-1", type: "oneoff" }),
                schedule: "not-a-cron", // irrelevant for oneoff
                executeAt: new Date(Date.now() + 60_000).toISOString(),
            };
            mockFileExists.mockResolvedValue(true);
            mockReadJsonFile.mockResolvedValue([oneoffTask]);

            const result = await service.reloadTasksFromJson("test-project");

            expect(result).toHaveLength(1);
            expect(result[0].id).toBe("oneoff-1");
            expect(mockLogger.warn).not.toHaveBeenCalledWith(
                "Skipping schedule with invalid cron expression",
                expect.anything()
            );
        });

        it("returns empty array when JSON file is not an array", async () => {
            mockFileExists.mockResolvedValue(true);
            mockReadJsonFile.mockResolvedValue({ notAnArray: true });

            const result = await service.reloadTasksFromJson("test-project");

            expect(result).toEqual([]);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                "Skipping invalid schedules file",
                expect.objectContaining({ projectId: "test-project" })
            );
        });
    });

    // -------------------------------------------------------------------------
    // reconcileTasksInMemory
    // -------------------------------------------------------------------------

    describe("reconcileTasksInMemory", () => {
        it("starts a new cron task that appears in reloaded set", async () => {
            const task = makeTask({ id: "new-task", schedule: "0 9 * * *" });

            await service.reconcileTasksInMemory("test-project", [task]);

            const priv = getPrivate(service);
            expect(priv.taskMetadata.has("new-task")).toBe(true);
            expect(priv.tasks.has("new-task")).toBe(true);

            // Clean up
            priv.tasks.get("new-task").stop();
        });

        it("removes a cron task that no longer appears in reloaded set", async () => {
            // Set up an in-memory cron task
            const task = makeTask({ id: "to-remove" });
            const priv = getPrivate(service);
            priv.taskMetadata.set("to-remove", task);
            // Manually put a fake cron entry to verify it gets stopped
            const stopFn = vi.fn();
            priv.tasks.set("to-remove", { stop: stopFn });

            // Reconcile with empty list — task should be removed
            await service.reconcileTasksInMemory("test-project", []);

            expect(stopFn).toHaveBeenCalled();
            expect(priv.tasks.has("to-remove")).toBe(false);
            expect(priv.taskMetadata.has("to-remove")).toBe(false);
        });

        it("stops old cron and starts new one when schedule changes", async () => {
            const task = makeTask({ id: "sched-change", schedule: "0 9 * * *" });
            const priv = getPrivate(service);
            priv.taskMetadata.set("sched-change", task);
            const stopFn = vi.fn();
            priv.tasks.set("sched-change", { stop: stopFn });

            const updatedTask = { ...task, schedule: "0 10 * * *" };
            await service.reconcileTasksInMemory("test-project", [updatedTask]);

            expect(stopFn).toHaveBeenCalled();
            expect(priv.tasks.has("sched-change")).toBe(true);
            expect(priv.taskMetadata.get("sched-change")?.schedule).toBe("0 10 * * *");

            // Clean up new cron
            priv.tasks.get("sched-change").stop();
        });

        it("keeps existing cron running when schedule is unchanged", async () => {
            const task = makeTask({ id: "stable", schedule: "0 9 * * *" });
            const priv = getPrivate(service);
            priv.taskMetadata.set("stable", task);
            const stopFn = vi.fn();
            const fakeCron = { stop: stopFn };
            priv.tasks.set("stable", fakeCron);

            await service.reconcileTasksInMemory("test-project", [task]);

            // Should NOT have stopped the existing cron
            expect(stopFn).not.toHaveBeenCalled();
            // The same cron object should still be in the map
            expect(priv.tasks.get("stable")).toBe(fakeCron);

            // Clean up
            fakeCron.stop();
        });

        it("only reconciles tasks belonging to the specified project", async () => {
            const otherProjectTask = makeTask({ id: "other-proj-task", projectId: "other-project" });
            const priv = getPrivate(service);
            priv.taskMetadata.set("other-proj-task", otherProjectTask);
            const stopFn = vi.fn();
            priv.tasks.set("other-proj-task", { stop: stopFn });

            // Reconcile test-project with empty list — should NOT touch other-project task
            await service.reconcileTasksInMemory("test-project", []);

            expect(stopFn).not.toHaveBeenCalled();
            expect(priv.taskMetadata.has("other-proj-task")).toBe(true);

            // Clean up
            priv.tasks.get("other-proj-task").stop();
        });
    });

    // -------------------------------------------------------------------------
    // addTask write-through
    // -------------------------------------------------------------------------

    describe("addTask write-through", () => {
        it("persists task to JSON and reconciles memory after addTask", async () => {
            // After addTask writes the file, mock the reload to return the new task
            mockWriteJsonFile.mockResolvedValue(undefined);
            mockFileExists.mockResolvedValue(true);

            let capturedWrite: ScheduledTask[] = [];
            mockWriteJsonFile.mockImplementation((_path: string, data: ScheduledTask[]) => {
                capturedWrite = data;
                mockReadJsonFile.mockResolvedValue(data);
                return Promise.resolve();
            });

            const taskId = await service.addTask(
                "0 9 * * *",
                "Daily prompt",
                "pubkey123",
                "my-agent",
                "test-project"
            );

            expect(mockWriteJsonFile).toHaveBeenCalled();
            expect(capturedWrite.length).toBeGreaterThan(0);
            expect(capturedWrite[0].targetAgentSlug).toBe("my-agent");

            const priv = getPrivate(service);
            expect(priv.taskMetadata.has(taskId)).toBe(true);
            expect(priv.tasks.has(taskId)).toBe(true);

            // Clean up
            priv.tasks.get(taskId)?.stop();
        });

        it("preserves pre-existing tasks from JSON when adding a new task", async () => {
            const existingTask = makeTask({ id: "pre-existing", schedule: "0 8 * * *" });

            mockWriteJsonFile.mockImplementation((_path: string, data: ScheduledTask[]) => {
                // Simulate reading back the full list (pre-existing + new)
                mockReadJsonFile.mockResolvedValue(data);
                return Promise.resolve();
            });
            mockFileExists.mockResolvedValue(true);

            // Seed pre-existing task in memory (as if loaded at startup)
            const priv = getPrivate(service);
            priv.taskMetadata.set("pre-existing", existingTask);
            const stopFn = vi.fn();
            priv.tasks.set("pre-existing", { stop: stopFn });

            const newTaskId = await service.addTask(
                "0 9 * * *",
                "New task prompt",
                "pubkey456",
                "another-agent",
                "test-project"
            );

            // Both tasks should exist in memory
            expect(priv.taskMetadata.has("pre-existing")).toBe(true);
            expect(priv.taskMetadata.has(newTaskId)).toBe(true);

            // Pre-existing cron should NOT have been stopped
            expect(stopFn).not.toHaveBeenCalled();

            // Clean up
            priv.tasks.get(newTaskId)?.stop();
            priv.tasks.get("pre-existing")?.stop();
        });
    });

    // -------------------------------------------------------------------------
    // removeTask write-through
    // -------------------------------------------------------------------------

    describe("removeTask write-through", () => {
        it("removes task from JSON and memory after removeTask", async () => {
            const task = makeTask({ id: "to-delete" });
            const priv = getPrivate(service);
            priv.taskMetadata.set("to-delete", task);
            const stopFn = vi.fn();
            priv.tasks.set("to-delete", { stop: stopFn });

            mockWriteJsonFile.mockImplementation((_path: string, data: ScheduledTask[]) => {
                // After deletion, JSON has no tasks
                mockReadJsonFile.mockResolvedValue(data);
                return Promise.resolve();
            });
            mockFileExists.mockResolvedValue(true);

            const result = await service.removeTask("to-delete");

            expect(result).toBe(true);
            expect(stopFn).toHaveBeenCalled();
            expect(priv.taskMetadata.has("to-delete")).toBe(false);
            expect(mockWriteJsonFile).toHaveBeenCalled();
        });

        it("returns false when task does not exist", async () => {
            const result = await service.removeTask("nonexistent-task");
            expect(result).toBe(false);
            expect(mockWriteJsonFile).not.toHaveBeenCalled();
        });
    });

    // -------------------------------------------------------------------------
    // clearAllTasks write-through
    // -------------------------------------------------------------------------

    describe("clearAllTasks write-through", () => {
        it("clears only tasks for specified projectId when projectId provided", async () => {
            const taskA = makeTask({ id: "task-a", projectId: "project-alpha" });
            const taskB = makeTask({ id: "task-b", projectId: "project-beta" });
            const priv = getPrivate(service);
            priv.taskMetadata.set("task-a", taskA);
            priv.taskMetadata.set("task-b", taskB);
            const stopA = vi.fn();
            const stopB = vi.fn();
            priv.tasks.set("task-a", { stop: stopA });
            priv.tasks.set("task-b", { stop: stopB });

            mockWriteJsonFile.mockImplementation((_path: string, data: ScheduledTask[]) => {
                mockReadJsonFile.mockResolvedValue(data);
                return Promise.resolve();
            });
            mockFileExists.mockResolvedValue(true);

            await service.clearAllTasks("project-alpha");

            expect(stopA).toHaveBeenCalled();
            expect(stopB).not.toHaveBeenCalled();
            expect(priv.taskMetadata.has("task-a")).toBe(false);
            expect(priv.taskMetadata.has("task-b")).toBe(true);

            // Clean up
            priv.tasks.get("task-b")?.stop();
        });

        it("clears all tasks across all projects when no projectId provided", async () => {
            const taskA = makeTask({ id: "task-a", projectId: "project-alpha" });
            const taskB = makeTask({ id: "task-b", projectId: "project-beta" });
            const priv = getPrivate(service);
            priv.taskMetadata.set("task-a", taskA);
            priv.taskMetadata.set("task-b", taskB);
            const stopA = vi.fn();
            const stopB = vi.fn();
            priv.tasks.set("task-a", { stop: stopA });
            priv.tasks.set("task-b", { stop: stopB });

            mockWriteJsonFile.mockResolvedValue(undefined);
            mockFileExists.mockResolvedValue(false);

            await service.clearAllTasks();

            expect(stopA).toHaveBeenCalled();
            expect(stopB).toHaveBeenCalled();
            expect(priv.taskMetadata.size).toBe(0);
        });
    });

    // -------------------------------------------------------------------------
    // Round-trip integrity
    // -------------------------------------------------------------------------

    describe("round-trip integrity", () => {
        it("persists all task fields without data loss", async () => {
            let writtenData: ScheduledTask[] = [];
            mockWriteJsonFile.mockImplementation((_path: string, data: ScheduledTask[]) => {
                writtenData = data;
                mockReadJsonFile.mockResolvedValue(data);
                return Promise.resolve();
            });
            mockFileExists.mockResolvedValue(true);

            await service.addTask(
                "0 9 * * *",
                "Round-trip prompt",
                "pubkeyABC",
                "target-agent",
                "round-trip-project",
                { title: "My Task", targetChannel: "channel-123", projectRef: "ref-456" }
            );

            expect(writtenData).toHaveLength(1);
            const saved = writtenData[0];
            expect(saved.schedule).toBe("0 9 * * *");
            expect(saved.prompt).toBe("Round-trip prompt");
            expect(saved.fromPubkey).toBe("pubkeyABC");
            expect(saved.targetAgentSlug).toBe("target-agent");
            expect(saved.projectId).toBe("round-trip-project");
            expect(saved.title).toBe("My Task");
            expect(saved.targetChannel).toBe("channel-123");
            expect(saved.projectRef).toBe("ref-456");
            expect(saved.id).toBeDefined();
            expect(saved.createdAt).toBeDefined();

            const priv = getPrivate(service);
            priv.tasks.get(saved.id)?.stop();
        });
    });

    // -------------------------------------------------------------------------
    // Delete while running (integration scenario)
    // -------------------------------------------------------------------------

    describe("delete while running", () => {
        it("stops cron and removes task when reconciled with empty list", async () => {
            const task = makeTask({ id: "running-task", schedule: "0 9 * * *" });
            const priv = getPrivate(service);

            // Start a real cron task
            priv.taskMetadata.set("running-task", task);
            const stopFn = vi.fn();
            priv.tasks.set("running-task", { stop: stopFn });

            // Reconcile with empty list (simulates JSON file having task deleted)
            await service.reconcileTasksInMemory("test-project", []);

            expect(stopFn).toHaveBeenCalled();
            expect(priv.tasks.has("running-task")).toBe(false);
            expect(priv.taskMetadata.has("running-task")).toBe(false);
        });
    });

    // -------------------------------------------------------------------------
    // Schedule modification (integration scenario)
    // -------------------------------------------------------------------------

    describe("schedule modification", () => {
        it("replaces old cron with new one when schedule changes in JSON", async () => {
            const originalTask = makeTask({ id: "modifiable", schedule: "0 9 * * *" });
            const priv = getPrivate(service);
            priv.taskMetadata.set("modifiable", originalTask);
            const stopFn = vi.fn();
            priv.tasks.set("modifiable", { stop: stopFn });

            // Simulate JSON having updated schedule
            const updatedTask = { ...originalTask, schedule: "0 10 * * *" };
            await service.reconcileTasksInMemory("test-project", [updatedTask]);

            expect(stopFn).toHaveBeenCalled();
            expect(priv.taskMetadata.get("modifiable")?.schedule).toBe("0 10 * * *");
            expect(priv.tasks.has("modifiable")).toBe(true);

            // Clean up
            priv.tasks.get("modifiable")?.stop();
        });
    });
});
