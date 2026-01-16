import * as fs from "node:fs/promises";
import { config } from "@/services/ConfigService";
import * as path from "node:path";
import { getNDK } from "@/nostr/ndkClient";
import type NDK from "@nostr-dev-kit/ndk";
import { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { trace } from "@opentelemetry/api";
import * as cron from "node-cron";
import { CronExpressionParser } from "cron-parser";
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

interface CatchUpConfig {
    gracePeriodMs: number; // How far back to look for missed tasks (default: 24h)
    delayBetweenTasksMs: number; // Delay between catch-up executions (default: 5s)
}

const DEFAULT_CATCHUP_CONFIG: CatchUpConfig = {
    gracePeriodMs: 24 * 60 * 60 * 1000, // 24 hours
    delayBetweenTasksMs: 5000, // 5 seconds
};

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

        // Check for missed tasks BEFORE starting regular scheduling
        // This ensures catch-ups happen first and update lastRun
        await this.checkMissedTasks();

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
                try {
                    await this.executeTask(task);
                } catch (error) {
                    logger.error(`Failed to execute scheduled task ${task.id}:`, error);
                }
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

    /**
     * Check for tasks that missed their execution window during downtime.
     * Called once during initialize().
     */
    private async checkMissedTasks(catchUpConfig: CatchUpConfig = DEFAULT_CATCHUP_CONFIG): Promise<void> {
        const now = new Date();
        const gracePeriodStart = new Date(now.getTime() - catchUpConfig.gracePeriodMs);

        trace.getActiveSpan()?.addEvent("scheduler.catchup_check_started", {
            "catchup.gracePeriodMs": catchUpConfig.gracePeriodMs,
            "catchup.gracePeriodStart": gracePeriodStart.toISOString(),
            "catchup.taskCount": this.taskMetadata.size,
        });

        logger.info("Checking for missed scheduled tasks", {
            gracePeriodMs: catchUpConfig.gracePeriodMs,
            gracePeriodStart: gracePeriodStart.toISOString(),
            taskCount: this.taskMetadata.size,
        });

        const missedTasks = this.getMissedTasks(now, gracePeriodStart);
        await this.executeCatchUpTasks(missedTasks, catchUpConfig.delayBetweenTasksMs);
    }

    /**
     * Scan all tasks and return those that missed execution within the grace period.
     */
    private getMissedTasks(now: Date, gracePeriodStart: Date): ScheduledTask[] {
        const missedTasks: ScheduledTask[] = [];

        for (const task of this.taskMetadata.values()) {
            const missedExecution = this.getMissedExecutionTime(task, now, gracePeriodStart);
            if (missedExecution) {
                missedTasks.push(task);
            }
        }

        return missedTasks;
    }

    /**
     * Check if a task has a missed execution within the grace period.
     * Returns the missed execution time if within grace period, null otherwise.
     */
    private getMissedExecutionTime(task: ScheduledTask, now: Date, gracePeriodStart: Date): Date | null {
        // Skip tasks that have never run - let normal scheduling handle first run
        if (!task.lastRun) {
            logger.debug(`Task ${task.id} has no lastRun, skipping catch-up check`);
            return null;
        }

        // Validate lastRun date
        const lastRunDate = new Date(task.lastRun);
        if (Number.isNaN(lastRunDate.getTime())) {
            logger.warn(`Task ${task.id} has invalid lastRun date: ${task.lastRun}, skipping catch-up check`);
            return null;
        }

        try {
            // Parse cron expression starting from lastRun
            const interval = CronExpressionParser.parse(task.schedule, {
                currentDate: lastRunDate,
                tz: "UTC",
            });

            // Get the next scheduled execution AFTER lastRun
            const nextScheduledExecution = interval.next().toDate();

            // Check if this execution was missed (it's in the past)
            if (nextScheduledExecution < now) {
                // Check if it's within the grace period
                if (nextScheduledExecution >= gracePeriodStart) {
                    logger.info(`Task ${task.id} missed execution at ${nextScheduledExecution.toISOString()}`, {
                        taskId: task.id,
                        lastRun: task.lastRun,
                        missedAt: nextScheduledExecution.toISOString(),
                        schedule: task.schedule,
                    });
                    return nextScheduledExecution;
                } else {
                    logger.info(`Task ${task.id} missed execution outside grace period, skipping`, {
                        taskId: task.id,
                        missedAt: nextScheduledExecution.toISOString(),
                        gracePeriodStart: gracePeriodStart.toISOString(),
                    });
                }
            }
        } catch (error) {
            logger.error(`Failed to parse cron expression for task ${task.id}:`, error);
        }

        return null;
    }

    /**
     * Execute catch-up tasks sequentially with delays between executions.
     */
    private async executeCatchUpTasks(tasks: ScheduledTask[], delayBetweenTasksMs: number): Promise<void> {
        if (tasks.length === 0) {
            trace.getActiveSpan()?.addEvent("scheduler.catchup_check_completed", {
                "catchup.missedTasksFound": 0,
            });
            logger.info("No missed tasks to catch up");
            return;
        }

        trace.getActiveSpan()?.addEvent("scheduler.catchup_execution_started", {
            "catchup.tasksToExecute": tasks.length,
        });

        logger.info(`Executing ${tasks.length} catch-up task(s)`);

        for (let i = 0; i < tasks.length; i++) {
            const task = tasks[i];

            try {
                logger.info(`Executing catch-up for task ${task.id} (${i + 1}/${tasks.length})`);
                await this.executeTask(task);

                // Add delay between tasks (except after the last one)
                if (i < tasks.length - 1) {
                    await this.delay(delayBetweenTasksMs);
                }
            } catch (error) {
                logger.error(`Catch-up execution failed for task ${task.id}:`, error);
                // Continue with next task even if one fails
            }
        }

        trace.getActiveSpan()?.addEvent("scheduler.catchup_execution_completed", {
            "catchup.tasksExecuted": tasks.length,
        });

        logger.info("Catch-up execution completed");
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Execute a scheduled task. Throws on failure to allow callers to handle errors.
     * Updates lastRun only AFTER successful publish to ensure failed tasks can be retried.
     */
    private async executeTask(task: ScheduledTask): Promise<void> {
        trace.getActiveSpan()?.addEvent("scheduler.task_executing", {
            "task.id": task.id,
        });

        // Try to get NDK instance if not already set
        if (!this.ndk) {
            logger.warn("NDK not available in SchedulerService, attempting to get instance");
            this.ndk = getNDK();
            if (!this.ndk) {
                throw new Error("SchedulerService not properly initialized - NDK unavailable");
            }
        }

        // Publish kind:1 event to trigger the agent (unified conversation format)
        await this.publishAgentTriggerEvent(task);

        // Update last run time ONLY after successful publish
        // This ensures failed tasks can be retried on next startup
        task.lastRun = new Date().toISOString();
        await this.saveTasks();

        trace.getActiveSpan()?.addEvent("scheduler.task_triggered", {
            "task.id": task.id,
        });
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
