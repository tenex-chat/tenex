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
    schedule: string; // Cron expression
    prompt: string;
    lastRun?: string;
    nextRun?: string;
    createdAt?: string; // When the task was created
    fromPubkey: string; // Who scheduled this task (the scheduler)
    toPubkey: string; // Target agent that should execute the task
    agentPubkey?: string; // Alias for toPubkey for backwards compatibility
}

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
        toPubkey: string
    ): Promise<string> {
        // Validate cron expression
        if (!cron.validate(schedule)) {
            throw new Error(`Invalid cron expression: ${schedule}`);
        }

        const taskId = this.generateTaskId();

        // Store locally for cron management
        const task: ScheduledTask = {
            id: taskId,
            schedule,
            prompt,
            fromPubkey,
            toPubkey,
        };

        this.taskMetadata.set(taskId, task);

        // Start the cron task
        this.startTask(task);

        await this.saveTasks();

        logger.info(`Created scheduled task ${taskId} with cron schedule: ${schedule}`);
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

    public async getTasks(): Promise<ScheduledTask[]> {
        // Return local tasks
        return Array.from(this.taskMetadata.values());
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

            // Publish kind:11 event to trigger the agent
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

        const event = new NDKEvent(this.ndk);
        event.kind = 11; // Agent request event
        event.content = task.prompt;

        const projectCtx = await getProjectContext();

        // Build tags
        const tags: string[][] = [
            ["a", projectCtx.project.tagId()], // Project reference
            ["p", task.toPubkey], // Target agent that should handle this task
        ];

        // Add metadata about the scheduled task
        tags.push(["scheduled-task-id", task.id]);
        tags.push(["scheduled-task-cron", task.schedule]);

        event.tags = tags;

        // Get the signer for the agent that scheduled this task (fromPubkey)
        let signer: NDKPrivateKeySigner;

        // Try to get the agent that scheduled this task
        const schedulerAgent = projectCtx.getAgentByPubkey(task.fromPubkey);
        if (schedulerAgent?.signer) {
            signer = schedulerAgent.signer;
        } else {
            // If scheduler agent not found, try PM
            const pmAgent = projectCtx.projectManager;
            if (pmAgent?.signer && pmAgent.pubkey === task.fromPubkey) {
                signer = pmAgent.signer;
            } else {
                // Fall back to backend key if fromPubkey matches backend
                const privateKey = await config.ensureBackendPrivateKey();
                const backendSigner = new NDKPrivateKeySigner(privateKey);
                if (backendSigner.pubkey === task.fromPubkey) {
                    signer = backendSigner;
                } else {
                    // If we can't find the original signer, log warning and use backend key
                    logger.warn(
                        `Could not find signer for fromPubkey ${task.fromPubkey}, using backend key`
                    );
                    signer = backendSigner;
                }
            }
        }

        // Sign and publish the event
        await event.sign(signer);
        await event.publish();

        trace.getActiveSpan()?.addEvent("scheduler.event_published", {
            "task.id": task.id,
            "event.from": signer.pubkey.substring(0, 8),
            "event.to": task.toPubkey.substring(0, 8),
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
