import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ScheduledTask } from "../types";

/**
 * Tests for the filesystem-backed SchedulerService store.
 *
 * Rust owns runtime scheduling and event publishing. TypeScript only validates,
 * writes, reloads, and mirrors `schedules.json` state.
 */

vi.mock("node:fs/promises", () => ({
    readdir: vi.fn(),
}));

vi.mock("@/utils/logger", () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
    },
}));

vi.mock("@/lib/fs/filesystem", () => ({
    fileExists: vi.fn(),
    readJsonFile: vi.fn(),
    writeJsonFile: vi.fn(),
    ensureDirectory: vi.fn().mockResolvedValue(undefined),
    directoryExists: vi.fn().mockResolvedValue(false),
}));

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

import * as fs from "node:fs/promises";
import { logger } from "@/utils/logger";
import { fileExists, readJsonFile, writeJsonFile } from "@/lib/fs/filesystem";
import { SchedulerService } from "../SchedulerService";

const mockReaddir = fs.readdir as ReturnType<typeof vi.fn>;
const mockFileExists = fileExists as ReturnType<typeof vi.fn>;
const mockReadJsonFile = readJsonFile as ReturnType<typeof vi.fn>;
const mockWriteJsonFile = writeJsonFile as ReturnType<typeof vi.fn>;
const mockLogger = logger as {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
};

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

function dirent(name: string, directory = true) {
    return {
        name,
        isDirectory: () => directory,
    };
}

function getPrivate(service: SchedulerService) {
    return service as unknown as {
        taskMetadata: Map<string, ScheduledTask>;
    };
}

describe("SchedulerService Write-Through", () => {
    let service: SchedulerService;

    beforeEach(() => {
        vi.clearAllMocks();

        const instance = SchedulerService.getInstance();
        getPrivate(instance).taskMetadata.clear();
        service = instance;

        mockFileExists.mockResolvedValue(false);
        mockWriteJsonFile.mockResolvedValue(undefined);
        mockReaddir.mockResolvedValue([]);
    });

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
            const invalidTask = { id: "bad-task", prompt: "missing fields" };
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
            const invalidCronTask = makeTask({
                id: "bad-cron",
                schedule: "invalid schedule",
                type: "cron",
            });
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
            const oneoffTask: ScheduledTask = {
                ...makeTask({ id: "oneoff-1", type: "oneoff" }),
                schedule: "not-a-cron",
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

    describe("reconcileTasksInMemory", () => {
        it("mirrors the reloaded tasks for a project without starting timers", async () => {
            const task = makeTask({ id: "new-task", schedule: "0 9 * * *" });

            await service.reconcileTasksInMemory("test-project", [task]);

            const priv = getPrivate(service);
            expect(priv.taskMetadata.has("new-task")).toBe(true);
            expect(Object.hasOwn(priv, "tasks")).toBe(false);
            expect(Object.hasOwn(priv, "oneoffTimers")).toBe(false);
        });

        it("removes tasks that no longer appear in the project file", async () => {
            const task = makeTask({ id: "to-remove" });
            const priv = getPrivate(service);
            priv.taskMetadata.set("to-remove", task);

            await service.reconcileTasksInMemory("test-project", []);

            expect(priv.taskMetadata.has("to-remove")).toBe(false);
        });

        it("updates metadata when a schedule changes", async () => {
            const task = makeTask({ id: "sched-change", schedule: "0 9 * * *" });
            const priv = getPrivate(service);
            priv.taskMetadata.set("sched-change", task);

            const updatedTask = { ...task, schedule: "0 10 * * *" };
            await service.reconcileTasksInMemory("test-project", [updatedTask]);

            expect(priv.taskMetadata.get("sched-change")?.schedule).toBe("0 10 * * *");
        });

        it("only reconciles tasks belonging to the specified project", async () => {
            const otherProjectTask = makeTask({
                id: "other-proj-task",
                projectId: "other-project",
            });
            const priv = getPrivate(service);
            priv.taskMetadata.set("other-proj-task", otherProjectTask);

            await service.reconcileTasksInMemory("test-project", []);

            expect(priv.taskMetadata.has("other-proj-task")).toBe(true);
        });
    });

    describe("addTask write-through", () => {
        it("persists task to JSON and refreshes memory after addTask", async () => {
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
            expect(capturedWrite).toHaveLength(1);
            expect(capturedWrite[0].targetAgentSlug).toBe("my-agent");
            expect(getPrivate(service).taskMetadata.has(taskId)).toBe(true);
        });

        it("preserves pre-existing tasks from memory when adding a new task", async () => {
            const existingTask = makeTask({ id: "pre-existing", schedule: "0 8 * * *" });
            getPrivate(service).taskMetadata.set("pre-existing", existingTask);

            mockFileExists.mockResolvedValue(true);
            mockWriteJsonFile.mockImplementation((_path: string, data: ScheduledTask[]) => {
                mockReadJsonFile.mockResolvedValue(data);
                return Promise.resolve();
            });

            const newTaskId = await service.addTask(
                "0 9 * * *",
                "New task prompt",
                "pubkey456",
                "another-agent",
                "test-project"
            );

            const priv = getPrivate(service);
            expect(priv.taskMetadata.has("pre-existing")).toBe(true);
            expect(priv.taskMetadata.has(newTaskId)).toBe(true);
        });
    });

    describe("getTasks", () => {
        it("reloads tasks for a specific project from disk", async () => {
            const task = makeTask({ id: "disk-task" });
            mockFileExists.mockResolvedValue(true);
            mockReadJsonFile.mockResolvedValue([task]);

            const result = await service.getTasks("test-project");

            expect(result).toEqual([{ ...task, projectRef: task.projectId }]);
            expect(getPrivate(service).taskMetadata.has("disk-task")).toBe(true);
        });

        it("scans project directories when no projectId is provided", async () => {
            const taskA = makeTask({ id: "task-a", projectId: "project-alpha" });
            const taskB = makeTask({ id: "task-b", projectId: "project-beta" });
            mockReaddir.mockResolvedValue([
                dirent("project-alpha"),
                dirent("README.md", false),
                dirent("project-beta"),
            ]);
            mockFileExists.mockResolvedValue(true);
            mockReadJsonFile.mockImplementation((path: string) => {
                if (path.includes("project-alpha")) {
                    return Promise.resolve([taskA]);
                }
                if (path.includes("project-beta")) {
                    return Promise.resolve([taskB]);
                }
                return Promise.resolve([]);
            });

            const result = await service.getTasks();

            expect(result.map((task) => task.id)).toEqual(["task-a", "task-b"]);
        });
    });

    describe("removeTask write-through", () => {
        it("removes task from JSON and memory after removeTask", async () => {
            const task = makeTask({ id: "to-delete" });
            getPrivate(service).taskMetadata.set("to-delete", task);

            mockFileExists.mockResolvedValue(true);
            mockWriteJsonFile.mockImplementation((_path: string, data: ScheduledTask[]) => {
                mockReadJsonFile.mockResolvedValue(data);
                return Promise.resolve();
            });

            const result = await service.removeTask("to-delete");

            expect(result).toBe(true);
            expect(getPrivate(service).taskMetadata.has("to-delete")).toBe(false);
            expect(mockWriteJsonFile).toHaveBeenCalledWith(
                expect.stringContaining("test-project"),
                []
            );
        });

        it("loads from disk before removing a task missing from memory", async () => {
            const task = makeTask({ id: "disk-delete" });
            mockReaddir.mockResolvedValue([dirent("test-project")]);
            mockFileExists.mockResolvedValue(true);
            mockReadJsonFile.mockResolvedValue([task]);
            mockWriteJsonFile.mockImplementation((_path: string, data: ScheduledTask[]) => {
                mockReadJsonFile.mockResolvedValue(data);
                return Promise.resolve();
            });

            const result = await service.removeTask("disk-delete");

            expect(result).toBe(true);
            expect(mockWriteJsonFile).toHaveBeenCalledWith(
                expect.stringContaining("test-project"),
                []
            );
        });

        it("returns false when task does not exist", async () => {
            const result = await service.removeTask("nonexistent-task");

            expect(result).toBe(false);
            expect(mockWriteJsonFile).not.toHaveBeenCalled();
        });
    });

    describe("clearAllTasks write-through", () => {
        it("clears only tasks for specified projectId when projectId provided", async () => {
            const taskA = makeTask({ id: "task-a", projectId: "project-alpha" });
            const taskB = makeTask({ id: "task-b", projectId: "project-beta" });
            const priv = getPrivate(service);
            priv.taskMetadata.set("task-a", taskA);
            priv.taskMetadata.set("task-b", taskB);

            mockFileExists.mockResolvedValue(true);
            mockReadJsonFile.mockResolvedValue([taskA]);
            mockWriteJsonFile.mockImplementation((_path: string, data: ScheduledTask[]) => {
                mockReadJsonFile.mockResolvedValue(data);
                return Promise.resolve();
            });

            await service.clearAllTasks("project-alpha");

            expect(priv.taskMetadata.has("task-a")).toBe(false);
            expect(priv.taskMetadata.has("task-b")).toBe(true);
            expect(mockWriteJsonFile).toHaveBeenCalledWith(
                expect.stringContaining("project-alpha"),
                []
            );
        });

        it("clears all tasks across all projects", async () => {
            const taskA = makeTask({ id: "task-a", projectId: "project-alpha" });
            const taskB = makeTask({ id: "task-b", projectId: "project-beta" });
            const store = new Map<string, ScheduledTask[]>([
                ["project-alpha", [taskA]],
                ["project-beta", [taskB]],
            ]);
            mockReaddir.mockResolvedValue([dirent("project-alpha"), dirent("project-beta")]);
            mockFileExists.mockResolvedValue(true);
            mockReadJsonFile.mockImplementation((path: string) => {
                if (path.includes("project-alpha")) {
                    return Promise.resolve(store.get("project-alpha") ?? []);
                }
                if (path.includes("project-beta")) {
                    return Promise.resolve(store.get("project-beta") ?? []);
                }
                return Promise.resolve([]);
            });
            mockWriteJsonFile.mockImplementation((path: string, data: ScheduledTask[]) => {
                if (path.includes("project-alpha")) {
                    store.set("project-alpha", data);
                }
                if (path.includes("project-beta")) {
                    store.set("project-beta", data);
                }
                return Promise.resolve();
            });

            await service.clearAllTasks();

            expect(getPrivate(service).taskMetadata.size).toBe(0);
            expect(mockWriteJsonFile).toHaveBeenCalledWith(
                expect.stringContaining("project-alpha"),
                []
            );
            expect(mockWriteJsonFile).toHaveBeenCalledWith(
                expect.stringContaining("project-beta"),
                []
            );
        });
    });

    describe("round-trip integrity", () => {
        it("persists all task fields without data loss", async () => {
            let writtenData: ScheduledTask[] = [];
            mockFileExists.mockResolvedValue(true);
            mockWriteJsonFile.mockImplementation((_path: string, data: ScheduledTask[]) => {
                writtenData = data;
                mockReadJsonFile.mockResolvedValue(data);
                return Promise.resolve();
            });

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
        });
    });
});
