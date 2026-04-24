import * as fs from "node:fs/promises";
import { getProjectSchedulesPath, normalizeProjectIdForRuntime } from "./storage";
import type { ScheduledTask } from "./types";
import { config } from "@/services/ConfigService";
import { ensureDirectory, fileExists, readJsonFile, writeJsonFile } from "@/lib/fs";
import { logger } from "@/utils/logger";
import { trace } from "@opentelemetry/api";
import * as cron from "node-cron";

/** Truncate a pubkey for logging (first 8 characters) */
function truncatePubkey(pubkey: string): string {
    return pubkey.substring(0, 8);
}

function isRustSchedulerCronCompatible(schedule: string): boolean {
    if (!cron.validate(schedule)) {
        return false;
    }

    const fields = schedule.trim().split(/\s+/);
    if (fields.length !== 5 && fields.length !== 6) {
        return false;
    }

    if (schedule.includes("?") || schedule.includes("#")) {
        return false;
    }

    const dayOfMonthField = fields[fields.length - 3];
    const dayOfWeekField = fields[fields.length - 1];
    return !/[LW]/i.test(dayOfMonthField) && !/L/i.test(dayOfWeekField);
}

export type { ScheduledTask };

/**
 * Filesystem-backed scheduled task store.
 *
 * Rust owns daemon scheduling and event publishing. This TypeScript service is
 * intentionally limited to validating, reading, and mutating project
 * `schedules.json` files for tools, prompts, and status snapshots.
 */
export class SchedulerService {
    private static instance: SchedulerService;
    private taskMetadata: Map<string, ScheduledTask> = new Map();

    private constructor() {}

    public static getInstance(): SchedulerService {
        if (!SchedulerService.instance) {
            SchedulerService.instance = new SchedulerService();
        }
        return SchedulerService.instance;
    }

    public async addTask(
        schedule: string,
        prompt: string,
        fromPubkey: string,
        targetAgentSlug: string,
        projectId: string,
        options?: { title?: string; targetChannel?: string; projectRef?: string } | string,
        targetChannel?: string
    ): Promise<string> {
        if (!isRustSchedulerCronCompatible(schedule)) {
            throw new Error(`Invalid cron expression: ${schedule}`);
        }

        const normalizedProjectId = normalizeProjectIdForRuntime(projectId);
        const taskId = this.generateTaskId();

        const resolvedTitle =
            typeof options === "string" ? options : options?.title;
        const resolvedTargetChannel =
            typeof options === "object" ? options?.targetChannel : targetChannel;
        const resolvedProjectRef =
            typeof options === "object" && options?.projectRef
                ? options.projectRef
                : projectId;

        const task: ScheduledTask = {
            id: taskId,
            title: resolvedTitle,
            schedule,
            prompt,
            fromPubkey,
            targetAgentSlug,
            projectId: normalizedProjectId,
            projectRef: resolvedProjectRef,
            createdAt: new Date().toISOString(),
            ...(resolvedTargetChannel && { targetChannel: resolvedTargetChannel }),
        };

        this.taskMetadata.set(taskId, task);
        await this.saveProjectTasks(task.projectId);
        await this.reconcileTasksInMemory(task.projectId, await this.reloadTasksFromJson(task.projectId));

        logger.info(`Created scheduled task ${taskId} with cron schedule: ${schedule}`, {
            projectId: task.projectId,
            fromPubkey: truncatePubkey(fromPubkey),
            targetAgentSlug,
        });
        return taskId;
    }

    /**
     * Add a one-off task that should execute once at a specific time.
     * Execution is performed by the Rust daemon's filesystem scheduler.
     */
    public async addOneoffTask(
        executeAt: Date,
        prompt: string,
        fromPubkey: string,
        targetAgentSlug: string,
        projectId: string,
        title?: string,
        targetChannel?: string
    ): Promise<string> {
        const now = new Date();
        if (executeAt <= now) {
            throw new Error(
                `Execution time must be in the future. Received: ${executeAt.toISOString()}`
            );
        }

        const normalizedProjectId = normalizeProjectIdForRuntime(projectId);
        const taskId = this.generateTaskId();

        const task: ScheduledTask = {
            id: taskId,
            title,
            schedule: executeAt.toISOString(),
            prompt,
            fromPubkey,
            targetAgentSlug,
            projectId: normalizedProjectId,
            projectRef: projectId,
            createdAt: new Date().toISOString(),
            type: "oneoff",
            executeAt: executeAt.toISOString(),
            ...(targetChannel && { targetChannel }),
        };

        this.taskMetadata.set(taskId, task);
        await this.saveProjectTasks(task.projectId);
        await this.reconcileTasksInMemory(task.projectId, await this.reloadTasksFromJson(task.projectId));

        logger.info(
            `Created one-off scheduled task ${taskId} to execute at: ${executeAt.toISOString()}`,
            {
                projectId: task.projectId,
                fromPubkey: truncatePubkey(fromPubkey),
                targetAgentSlug,
                executeAt: executeAt.toISOString(),
            }
        );

        return taskId;
    }

    public async removeTask(taskId: string): Promise<boolean> {
        let task = this.taskMetadata.get(taskId);
        if (!task) {
            await this.loadAllTasksFromDisk();
            task = this.taskMetadata.get(taskId);
        }

        if (!task) {
            return false;
        }

        this.taskMetadata.delete(taskId);
        await this.saveProjectTasks(task.projectId);
        await this.reconcileTasksInMemory(task.projectId, await this.reloadTasksFromJson(task.projectId));

        logger.info(`Removed scheduled task ${taskId}`);
        return true;
    }

    public async getTasks(projectId?: string): Promise<ScheduledTask[]> {
        if (projectId) {
            const tasks = await this.reloadTasksFromJson(projectId);
            await this.reconcileTasksInMemory(projectId, tasks);
            return tasks;
        }

        await this.loadAllTasksFromDisk();
        return Array.from(this.taskMetadata.values()).sort((left, right) =>
            left.id.localeCompare(right.id)
        );
    }

    /**
     * Read and validate tasks from the JSON file for a specific project.
     * Returns only valid tasks; invalid ones are skipped with a warning.
     */
    async reloadTasksFromJson(projectId: string): Promise<ScheduledTask[]> {
        const normalizedProjectId = normalizeProjectIdForRuntime(projectId);
        const filePath = getProjectSchedulesPath(normalizedProjectId);

        if (!(await fileExists(filePath))) {
            return [];
        }

        const raw = await readJsonFile<ScheduledTask[]>(filePath);
        if (!Array.isArray(raw)) {
            logger.warn("Skipping invalid schedules file", {
                filePath,
                projectId: normalizedProjectId,
            });
            return [];
        }

        const validTasks: ScheduledTask[] = [];
        for (const task of raw) {
            if (!task.id || !task.prompt || !task.fromPubkey || !task.targetAgentSlug || !task.projectId) {
                logger.warn("Skipping schedule with missing required fields", { taskId: task.id });
                continue;
            }

            if (task.type !== "oneoff" && !isRustSchedulerCronCompatible(task.schedule)) {
                logger.warn("Skipping schedule with invalid cron expression", {
                    taskId: task.id,
                    schedule: task.schedule,
                });
                continue;
            }

            validTasks.push({
                ...task,
                projectId: normalizeProjectIdForRuntime(task.projectId),
                projectRef: task.projectRef ?? task.projectId,
            });
        }

        return validTasks;
    }

    /**
     * Refresh the in-memory mirror for one project. This method does not start
     * timers; Rust reads the same files and owns execution.
     */
    async reconcileTasksInMemory(projectId: string, reloadedTasks: ScheduledTask[]): Promise<void> {
        const normalizedProjectId = normalizeProjectIdForRuntime(projectId);

        for (const [id, task] of this.taskMetadata.entries()) {
            if (normalizeProjectIdForRuntime(task.projectId) === normalizedProjectId) {
                this.taskMetadata.delete(id);
            }
        }

        for (const task of reloadedTasks) {
            this.taskMetadata.set(task.id, {
                ...task,
                projectId: normalizeProjectIdForRuntime(task.projectId),
                projectRef: task.projectRef ?? task.projectId,
            });
        }

        trace.getActiveSpan()?.addEvent("scheduler.tasks_reconciled", {
            "project.id": normalizedProjectId,
            "tasks.count": reloadedTasks.length,
        });
    }

    public async clearAllTasks(projectId?: string): Promise<void> {
        const affectedProjects = new Set<string>();

        if (projectId) {
            const normalizedProjectId = normalizeProjectIdForRuntime(projectId);
            await this.reconcileTasksInMemory(normalizedProjectId, await this.reloadTasksFromJson(normalizedProjectId));

            for (const [id, task] of this.taskMetadata.entries()) {
                if (normalizeProjectIdForRuntime(task.projectId) === normalizedProjectId) {
                    this.taskMetadata.delete(id);
                    affectedProjects.add(normalizedProjectId);
                }
            }
        } else {
            await this.loadAllTasksFromDisk();
            for (const task of this.taskMetadata.values()) {
                affectedProjects.add(normalizeProjectIdForRuntime(task.projectId));
            }
            this.taskMetadata.clear();
        }

        await Promise.all(
            Array.from(affectedProjects).map(async (pid) => {
                await this.saveProjectTasks(pid);
                await this.reconcileTasksInMemory(pid, await this.reloadTasksFromJson(pid));
            })
        );
    }

    public shutdown(): void {
        this.taskMetadata.clear();
        trace.getActiveSpan()?.addEvent("scheduler.shutdown_complete");
    }

    private async loadAllTasksFromDisk(): Promise<void> {
        this.taskMetadata.clear();

        let entries: Array<{ name: string; isDirectory(): boolean }>;
        try {
            entries = await fs.readdir(config.getConfigPath("projects"), { withFileTypes: true });
        } catch (error: unknown) {
            if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
                return;
            }
            logger.error("Failed to load scheduled tasks:", error);
            return;
        }

        let loadedCount = 0;
        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }

            const tasks = await this.reloadTasksFromJson(entry.name);
            for (const task of tasks) {
                this.taskMetadata.set(task.id, task);
                loadedCount++;
            }
        }

        trace.getActiveSpan()?.addEvent("scheduler.tasks_loaded", {
            "tasks.count": loadedCount,
        });
    }

    private async saveProjectTasks(projectId: string): Promise<void> {
        try {
            const normalizedProjectId = normalizeProjectIdForRuntime(projectId);
            const filePath = getProjectSchedulesPath(normalizedProjectId);
            const tasks = Array.from(this.taskMetadata.values())
                .filter((task) => normalizeProjectIdForRuntime(task.projectId) === normalizedProjectId)
                .sort((left, right) => left.id.localeCompare(right.id));

            await ensureDirectory(config.getProjectMetadataPath(normalizedProjectId));
            await writeJsonFile(filePath, tasks);
        } catch (error) {
            logger.error("Failed to save scheduled tasks:", {
                projectId,
                error,
            });
        }
    }

    private generateTaskId(): string {
        return `task-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    }
}
