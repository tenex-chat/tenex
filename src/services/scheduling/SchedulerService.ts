import * as fs from "node:fs/promises";
import { config } from "@/services/ConfigService";
import * as path from "node:path";
import type NDK from "@nostr-dev-kit/ndk";
import { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { trace } from "@opentelemetry/api";
import * as cron from "node-cron";
import { logger } from "@/utils/logger";
import { getProjectContext } from "@/services/projects";

interface ScheduledTask {
    id: string;
    title?: string; // Human-readable title for the scheduled task
    schedule: string; // Cron expression
    prompt: string;
    lastRun?: string;
    nextRun?: string;
    createdAt?: string; // When the task was created
    fromPubkey: string; // Who scheduled this task (the scheduler)
    toPubkey: string; // Target agent that should execute the task
    agentPubkey?: string; // Alias for toPubkey for backwards compatibility
    projectId: string; // Project A-tag ID (format: "31933:authorPubkey:dTag")
}

// Export the type so it can be used by other modules
export type { ScheduledTask };

export class SchedulerService {
    private static instance: SchedulerService;
    private tasks: Map<string, cron.ScheduledTask> = new Map();
    private taskMetadata: Map<string, ScheduledTask> = new Map();
    private taskFilePath: string;
    private ndk: NDK | null = null;

    private constructor() {
        // Use global location for scheduled tasks since it's a singleton
        const tenexDir = config.getConfigPath();
        this.taskFilePath = path.join(tenexDir, "scheduled_tasks.json");
    }

    public static getInstance(): SchedulerService {
        if (!SchedulerService.instance) {
            SchedulerService.instance = new SchedulerService();
        }
        return SchedulerService.instance;
    }

    public async initialize(ndk: NDK, _projectPath?: string): Promise<void> {
        this.ndk = ndk;

        // Ensure .tenex directory exists
        const tenexDir = path.dirname(this.taskFilePath);
        await fs.mkdir(tenexDir, { recursive: true });

        // Load existing tasks
        await this.loadTasks();

        // Start all loaded tasks
        for (const task of this.taskMetadata.values()) {
            this.startTask(task);
        }

        trace.getActiveSpan()?.addEvent("scheduler.initialized", {
            "tasks.count": this.taskMetadata.size,
        });
    }

    public async addTask(
        schedule: string,
        prompt: string,
        fromPubkey: string,
        toPubkey: string,
        projectId?: string,
        title?: string
    ): Promise<string> {
        // Validate cron expression
        if (!cron.validate(schedule)) {
            throw new Error(`Invalid cron expression: ${schedule}`);
        }

        // If projectId not provided, try to get it from current context
        let resolvedProjectId = projectId;
        if (!resolvedProjectId) {
            try {
                const projectCtx = getProjectContext();
                resolvedProjectId = projectCtx.project.tagId();
            } catch {
                throw new Error("projectId is required when scheduling tasks outside of a project context");
            }
        }

        const taskId = this.generateTaskId();

        // Store locally for cron management
        const task: ScheduledTask = {
            id: taskId,
            title,
            schedule,
            prompt,
            fromPubkey,
            toPubkey,
            projectId: resolvedProjectId,
            createdAt: new Date().toISOString(),
        };

        this.taskMetadata.set(taskId, task);

        // Start the cron task
        this.startTask(task);

        await this.saveTasks();

        logger.info(`Created scheduled task ${taskId} with cron schedule: ${schedule}`, {
            projectId: resolvedProjectId,
            fromPubkey: fromPubkey.substring(0, 8),
            toPubkey: toPubkey.substring(0, 8),
        });
        return taskId;
    }

    public async removeTask(taskId: string): Promise<boolean> {
        // Stop cron task if exists
        const cronTask = this.tasks.get(taskId);
        if (cronTask) {
            cronTask.stop();
            this.tasks.delete(taskId);
        }

        // Remove from local storage
        this.taskMetadata.delete(taskId);
        await this.saveTasks();

        logger.info(`Removed scheduled task ${taskId}`);
        return true;
    }

    public async getTasks(projectId?: string): Promise<ScheduledTask[]> {
        const allTasks = Array.from(this.taskMetadata.values());

        // If projectId is provided, filter tasks by that project
        if (projectId) {
            return allTasks.filter(task => task.projectId === projectId);
        }

        // Return all tasks if no filter specified
        return allTasks;
    }

    private startTask(task: ScheduledTask): void {
        const cronTask = cron.schedule(
            task.schedule,
            async () => {
                await this.executeTask(task);
            },
            {
                timezone: "UTC",
            }
        );

        this.tasks.set(task.id, cronTask);
        trace.getActiveSpan()?.addEvent("scheduler.task_started", {
            "task.id": task.id,
            "task.schedule": task.schedule,
        });
    }

    private async executeTask(task: ScheduledTask): Promise<void> {
        trace.getActiveSpan()?.addEvent("scheduler.task_executing", {
            "task.id": task.id,
        });

        try {
            // Try to get NDK instance if not already set
            if (!this.ndk) {
                logger.warn("NDK not available in SchedulerService, attempting to get instance");
                try {
                    const { getNDK } = await import("@/nostr/ndkClient");
                    this.ndk = getNDK();
                    if (!this.ndk) {
                        throw new Error("NDK instance not available");
                    }
                } catch (ndkError) {
                    logger.error("Failed to get NDK instance:", ndkError);
                    throw new Error("SchedulerService not properly initialized - NDK unavailable");
                }
            }

            // Update last run time
            task.lastRun = new Date().toISOString();
            await this.saveTasks();

            // Publish kind:1 event to trigger the agent (unified conversation format)
            await this.publishAgentTriggerEvent(task);

            trace.getActiveSpan()?.addEvent("scheduler.task_triggered", {
                "task.id": task.id,
            });
        } catch (error: unknown) {
            logger.error(`Failed to execute scheduled task ${task.id}:`, error);
        }
    }

    private async publishAgentTriggerEvent(task: ScheduledTask): Promise<void> {
        if (!this.ndk) {
            throw new Error("NDK not initialized");
        }

        // Validate that we have a project ID
        if (!task.projectId) {
            throw new Error(`Scheduled task ${task.id} is missing projectId - cannot route event`);
        }

        const event = new NDKEvent(this.ndk);
        event.kind = 1; // Unified conversation format (kind:1)
        event.content = task.prompt;

        // Build tags - use stored projectId instead of getting from context
        // The projectId is stored when the task is created (within project context)
        const tags: string[][] = [
            ["a", task.projectId], // Project reference (stored at task creation time)
            ["p", task.toPubkey], // Target agent that should handle this task
        ];

        // Add metadata about the scheduled task
        tags.push(["scheduled-task-id", task.id]);
        tags.push(["scheduled-task-cron", task.schedule]);

        event.tags = tags;

        // Use backend signer for scheduled tasks
        // The backend key is always available and whitelisted
        // We store fromPubkey for tracking but sign with backend key
        const privateKey = await config.ensureBackendPrivateKey();
        const signer = new NDKPrivateKeySigner(privateKey);

        // Sign and publish the event
        await event.sign(signer);
        await event.publish();

        logger.info("Published scheduled task event", {
            taskId: task.id,
            projectId: task.projectId,
            eventId: event.id?.substring(0, 8),
            from: signer.pubkey.substring(0, 8),
            to: task.toPubkey.substring(0, 8),
        });

        trace.getActiveSpan()?.addEvent("scheduler.event_published", {
            "task.id": task.id,
            "event.id": event.id || "unknown",
            "event.from": signer.pubkey.substring(0, 8),
            "event.to": task.toPubkey.substring(0, 8),
            "project.id": task.projectId,
        });
    }

    private async loadTasks(): Promise<void> {
        try {
            const data = await fs.readFile(this.taskFilePath, "utf-8");
            const tasks = JSON.parse(data) as ScheduledTask[];

            for (const task of tasks) {
                this.taskMetadata.set(task.id, task);
            }

            trace.getActiveSpan()?.addEvent("scheduler.tasks_loaded", {
                "tasks.count": tasks.length,
            });
        } catch (error: unknown) {
            if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
                // No existing file, starting fresh - this is expected
            } else {
                logger.error("Failed to load scheduled tasks:", error);
            }
        }
    }

    private async saveTasks(): Promise<void> {
        try {
            const tasks = Array.from(this.taskMetadata.values());
            await fs.writeFile(this.taskFilePath, JSON.stringify(tasks, null, 2));
        } catch (error) {
            logger.error("Failed to save scheduled tasks:", error);
        }
    }

    private generateTaskId(): string {
        return `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    public shutdown(): void {
        trace.getActiveSpan()?.addEvent("scheduler.shutting_down", {
            "tasks.count": this.tasks.size,
        });

        // Stop all cron tasks
        for (const [, cronTask] of this.tasks.entries()) {
            cronTask.stop();
        }

        this.tasks.clear();
        this.taskMetadata.clear();
        trace.getActiveSpan()?.addEvent("scheduler.shutdown_complete");
    }

    public async clearAllTasks(): Promise<void> {
        // Stop and remove all tasks
        for (const taskId of Array.from(this.tasks.keys())) {
            await this.removeTask(taskId);
        }

        // Clear the tasks file
        try {
            await fs.writeFile(this.taskFilePath, JSON.stringify([], null, 2));
        } catch (error) {
            logger.error("Failed to clear tasks file:", error);
        }
    }
}
