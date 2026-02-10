import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getDaemon } from "@/daemon";
import { getNDK } from "@/nostr/ndkClient";
import { config } from "@/services/ConfigService";
import { getProjectContext } from "@/services/projects";
import { logger } from "@/utils/logger";
import type NDK from "@nostr-dev-kit/ndk";
import { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { trace } from "@opentelemetry/api";
import { CronExpressionParser } from "cron-parser";
import * as cron from "node-cron";

/** Truncate a pubkey for logging (first 8 characters) */
function truncatePubkey(pubkey: string): string {
    return pubkey.substring(0, 8);
}

interface ScheduledTask {
    id: string;
    title?: string; // Human-readable title for the scheduled task
    schedule: string; // Cron expression (for recurring) or ISO timestamp (for one-off)
    prompt: string;
    lastRun?: string;
    nextRun?: string;
    createdAt?: string; // When the task was created
    fromPubkey: string; // Who scheduled this task (the scheduler)
    toPubkey: string; // Target agent that should execute the task
    projectId: string; // Project A-tag ID (format: "31933:authorPubkey:dTag")
    type?: "cron" | "oneoff"; // Task type - defaults to "cron" for backward compatibility
    executeAt?: string; // ISO timestamp for one-off tasks
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
    private oneoffTimers: Map<string, NodeJS.Timeout> = new Map(); // Timers for one-off tasks
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

        // Start all loaded tasks (cron or one-off based on type)
        for (const task of this.taskMetadata.values()) {
            if (task.type === "oneoff") {
                this.startOneoffTask(task);
            } else {
                this.startTask(task);
            }
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
                throw new Error(
                    "projectId is required when scheduling tasks outside of a project context"
                );
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
            fromPubkey: truncatePubkey(fromPubkey),
            toPubkey: truncatePubkey(toPubkey),
        });
        return taskId;
    }

    /**
     * Add a one-off task that executes once at a specific time.
     * The task is automatically deleted after successful execution.
     */
    public async addOneoffTask(
        executeAt: Date,
        prompt: string,
        fromPubkey: string,
        toPubkey: string,
        projectId?: string,
        title?: string
    ): Promise<string> {
        // Validate execution time is in the future
        const now = new Date();
        if (executeAt <= now) {
            throw new Error(
                `Execution time must be in the future. Received: ${executeAt.toISOString()}`
            );
        }

        // If projectId not provided, try to get it from current context
        let resolvedProjectId = projectId;
        if (!resolvedProjectId) {
            try {
                const projectCtx = getProjectContext();
                resolvedProjectId = projectCtx.project.tagId();
            } catch {
                throw new Error(
                    "projectId is required when scheduling tasks outside of a project context"
                );
            }
        }

        const taskId = this.generateTaskId();

        const task: ScheduledTask = {
            id: taskId,
            title,
            schedule: executeAt.toISOString(), // Store ISO timestamp for display
            prompt,
            fromPubkey,
            toPubkey,
            projectId: resolvedProjectId,
            createdAt: new Date().toISOString(),
            type: "oneoff",
            executeAt: executeAt.toISOString(),
        };

        this.taskMetadata.set(taskId, task);

        // Start the timer for this one-off task
        this.startOneoffTask(task);

        await this.saveTasks();

        logger.info(
            `Created one-off scheduled task ${taskId} to execute at: ${executeAt.toISOString()}`,
            {
                projectId: resolvedProjectId,
                fromPubkey: truncatePubkey(fromPubkey),
                toPubkey: truncatePubkey(toPubkey),
                executeAt: executeAt.toISOString(),
            }
        );

        return taskId;
    }

    public async removeTask(taskId: string): Promise<boolean> {
        // Stop cron task if exists
        const cronTask = this.tasks.get(taskId);
        if (cronTask) {
            cronTask.stop();
            this.tasks.delete(taskId);
        }

        // Stop one-off timer if exists
        const timer = this.oneoffTimers.get(taskId);
        if (timer) {
            clearTimeout(timer);
            this.oneoffTimers.delete(taskId);
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
            return allTasks.filter((task) => task.projectId === projectId);
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
     * Start a one-off task timer.
     * Uses setTimeout to schedule execution at the specified time.
     */
    private startOneoffTask(task: ScheduledTask): void {
        if (!task.executeAt) {
            logger.error(`One-off task ${task.id} missing executeAt timestamp, deleting task`);
            this.purgeCorruptedOneoffTask(task.id);
            return;
        }

        const executeAt = new Date(task.executeAt);

        // Validate the timestamp - if invalid, delayMs will be NaN
        if (Number.isNaN(executeAt.getTime())) {
            logger.error(
                `One-off task ${task.id} has invalid executeAt timestamp: ${task.executeAt}, deleting task`
            );
            this.purgeCorruptedOneoffTask(task.id);
            return;
        }

        // Check if task already ran (has lastRun set) - prevents re-execution after crash
        if (task.lastRun) {
            logger.warn(
                `One-off task ${task.id} already executed (lastRun: ${task.lastRun}), purging orphaned task`
            );
            this.purgeCorruptedOneoffTask(task.id);
            return;
        }

        const now = new Date();
        const delayMs = executeAt.getTime() - now.getTime();

        if (delayMs <= 0) {
            // Task time has already passed - this shouldn't happen for new tasks
            // but might happen during startup if task was missed
            logger.warn(`One-off task ${task.id} execution time has passed, executing immediately`);
            this.executeOneoffTask(task);
            return;
        }

        // Use setTimeout for the delay
        // Note: setTimeout max delay is ~24.8 days (2^31 - 1 ms)
        // For longer delays, we'll need to chain timeouts
        const maxDelay = 2147483647; // Max 32-bit signed int
        if (delayMs > maxDelay) {
            // Schedule a re-check after max delay
            const timer = setTimeout(() => {
                this.oneoffTimers.delete(task.id);
                this.startOneoffTask(task); // Re-evaluate
            }, maxDelay);
            this.oneoffTimers.set(task.id, timer);
        } else {
            const timer = setTimeout(async () => {
                await this.executeOneoffTask(task);
            }, delayMs);
            this.oneoffTimers.set(task.id, timer);
        }

        trace.getActiveSpan()?.addEvent("scheduler.oneoff_task_started", {
            "task.id": task.id,
            "task.executeAt": task.executeAt,
            "task.delayMs": delayMs,
        });

        logger.debug(
            `One-off task ${task.id} scheduled to execute in ${Math.round(delayMs / 1000)}s`
        );
    }

    /**
     * Purge a corrupted or orphaned one-off task from storage.
     * Used when a task has invalid data or has already been executed.
     */
    private purgeCorruptedOneoffTask(taskId: string): void {
        this.oneoffTimers.delete(taskId);
        this.taskMetadata.delete(taskId);
        // Save asynchronously - don't block on corrupted task cleanup
        this.saveTasks().catch((error) => {
            logger.error(`Failed to save after purging corrupted task ${taskId}:`, error);
        });

        trace.getActiveSpan()?.addEvent("scheduler.oneoff_task_purged", {
            "task.id": taskId,
            "reason": "corrupted_or_orphaned",
        });
    }

    /**
     * Execute a one-off task and auto-delete it after successful execution.
     */
    private async executeOneoffTask(task: ScheduledTask): Promise<void> {
        try {
            await this.executeTask(task);

            // Auto-delete after successful execution
            logger.info(`One-off task ${task.id} executed successfully, auto-deleting`);
            this.oneoffTimers.delete(task.id);
            this.taskMetadata.delete(task.id);
            await this.saveTasks();

            trace.getActiveSpan()?.addEvent("scheduler.oneoff_task_completed", {
                "task.id": task.id,
            });
        } catch (error) {
            logger.error(`Failed to execute one-off task ${task.id}:`, error);
            // Don't delete on failure - keep for potential retry or manual investigation
        }
    }

    /**
     * Check for tasks that missed their execution window during downtime.
     * Called once during initialize().
     */
    private async checkMissedTasks(
        catchUpConfig: CatchUpConfig = DEFAULT_CATCHUP_CONFIG
    ): Promise<void> {
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

        // First, delete any expired one-off tasks that are past the grace period
        await this.deleteExpiredOneoffTasks(gracePeriodStart);

        const missedTasks = this.getMissedTasks(now, gracePeriodStart);
        await this.executeCatchUpTasks(missedTasks, catchUpConfig.delayBetweenTasksMs);
    }

    /**
     * Delete one-off tasks that have expired (executeAt < gracePeriodStart).
     * These tasks missed their window and won't be caught up.
     */
    private async deleteExpiredOneoffTasks(gracePeriodStart: Date): Promise<void> {
        const expiredTasks: string[] = [];

        for (const task of this.taskMetadata.values()) {
            if (task.type !== "oneoff" || !task.executeAt) continue;

            const executeAt = new Date(task.executeAt);
            if (Number.isNaN(executeAt.getTime())) {
                // Invalid timestamp - mark for deletion
                logger.warn(`One-off task ${task.id} has invalid executeAt: ${task.executeAt}, deleting`);
                expiredTasks.push(task.id);
                continue;
            }

            // Check if task is past the grace period (too old to catch up)
            if (executeAt < gracePeriodStart) {
                logger.info(
                    `One-off task ${task.id} expired (executeAt: ${executeAt.toISOString()} < gracePeriod: ${gracePeriodStart.toISOString()}), deleting`,
                    {
                        taskId: task.id,
                        executeAt: task.executeAt,
                        gracePeriodStart: gracePeriodStart.toISOString(),
                    }
                );
                expiredTasks.push(task.id);
            }
        }

        // Delete all expired tasks
        if (expiredTasks.length > 0) {
            for (const taskId of expiredTasks) {
                this.oneoffTimers.delete(taskId);
                this.taskMetadata.delete(taskId);
            }
            await this.saveTasks();

            trace.getActiveSpan()?.addEvent("scheduler.expired_oneoff_tasks_deleted", {
                "catchup.expiredTasksDeleted": expiredTasks.length,
            });

            logger.info(`Deleted ${expiredTasks.length} expired one-off task(s)`);
        }
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
    private getMissedExecutionTime(
        task: ScheduledTask,
        now: Date,
        gracePeriodStart: Date
    ): Date | null {
        // Handle one-off tasks differently
        if (task.type === "oneoff") {
            return this.getMissedOneoffExecutionTime(task, now, gracePeriodStart);
        }

        // Skip tasks that have never run - let normal scheduling handle first run
        if (!task.lastRun) {
            logger.debug(`Task ${task.id} has no lastRun, skipping catch-up check`);
            return null;
        }

        // Validate lastRun date
        const lastRunDate = new Date(task.lastRun);
        if (Number.isNaN(lastRunDate.getTime())) {
            logger.warn(
                `Task ${task.id} has invalid lastRun date: ${task.lastRun}, skipping catch-up check`
            );
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
                    logger.info(
                        `Task ${task.id} missed execution at ${nextScheduledExecution.toISOString()}`,
                        {
                            taskId: task.id,
                            lastRun: task.lastRun,
                            missedAt: nextScheduledExecution.toISOString(),
                            schedule: task.schedule,
                        }
                    );
                    return nextScheduledExecution;
                }
                logger.info(`Task ${task.id} missed execution outside grace period, skipping`, {
                    taskId: task.id,
                    missedAt: nextScheduledExecution.toISOString(),
                    gracePeriodStart: gracePeriodStart.toISOString(),
                });
            }
        } catch (error) {
            logger.error(`Failed to parse cron expression for task ${task.id}:`, error);
        }

        return null;
    }

    /**
     * Check if a one-off task was missed.
     * One-off tasks are missed if their executeAt time has passed and they haven't run yet.
     */
    private getMissedOneoffExecutionTime(
        task: ScheduledTask,
        now: Date,
        gracePeriodStart: Date
    ): Date | null {
        if (!task.executeAt) {
            logger.warn(`One-off task ${task.id} missing executeAt timestamp`);
            return null;
        }

        // If already run, don't catch up (shouldn't happen as one-off tasks are deleted after execution)
        if (task.lastRun) {
            logger.debug(`One-off task ${task.id} already executed, skipping catch-up`);
            return null;
        }

        const executeAt = new Date(task.executeAt);
        if (Number.isNaN(executeAt.getTime())) {
            logger.warn(`One-off task ${task.id} has invalid executeAt: ${task.executeAt}`);
            return null;
        }

        // Check if execution time has passed and is within grace period
        if (executeAt < now && executeAt >= gracePeriodStart) {
            logger.info(
                `One-off task ${task.id} missed execution at ${executeAt.toISOString()}`,
                {
                    taskId: task.id,
                    executeAt: task.executeAt,
                }
            );
            return executeAt;
        }

        // Tasks past grace period are handled by deleteExpiredOneoffTasks
        return null;
    }

    /**
     * Execute catch-up tasks sequentially with delays between executions.
     */
    private async executeCatchUpTasks(
        tasks: ScheduledTask[],
        delayBetweenTasksMs: number
    ): Promise<void> {
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

                // Auto-delete one-off tasks after successful catch-up execution
                if (task.type === "oneoff") {
                    logger.info(`One-off task ${task.id} catch-up completed, auto-deleting`);
                    this.oneoffTimers.delete(task.id);
                    this.taskMetadata.delete(task.id);
                    await this.saveTasks();
                }

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
        return new Promise((resolve) => setTimeout(resolve, ms));
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

    /**
     * Resolve the target pubkey for a scheduled task.
     * If the original target agent is not in the task's project,
     * route to the Project Manager (PM) of that project instead.
     *
     * @param task - The scheduled task to resolve target for
     * @returns The pubkey to use as the target (either original or PM)
     */
    protected resolveTargetPubkey(task: ScheduledTask): string {
        try {
            const daemon = getDaemon();
            const activeRuntimes = daemon.getActiveRuntimes();

            // Find the runtime for this task's project
            const runtime = activeRuntimes.get(task.projectId);
            if (!runtime) {
                // Project not running, use original target
                // The event will be routed when project starts
                logger.debug("Project not running, using original target pubkey", {
                    taskId: task.id,
                    projectId: task.projectId,
                    toPubkey: truncatePubkey(task.toPubkey),
                });
                return task.toPubkey;
            }

            const context = runtime.getContext();
            if (!context) {
                // No context available, use original target
                logger.warn("Project context not available, using original target pubkey", {
                    taskId: task.id,
                    projectId: task.projectId,
                    toPubkey: truncatePubkey(task.toPubkey),
                });
                return task.toPubkey;
            }

            // Check if the target agent is in this project
            const targetAgent = context.getAgentByPubkey(task.toPubkey);
            if (targetAgent) {
                // Target agent exists in project, use original target
                return task.toPubkey;
            }

            // Target agent is NOT in this project - route to PM instead
            const pm = context.projectManager;
            if (!pm) {
                logger.warn("Target agent not in project and no PM available, using original target", {
                    taskId: task.id,
                    projectId: task.projectId,
                    toPubkey: truncatePubkey(task.toPubkey),
                });
                return task.toPubkey;
            }

            logger.info("Rerouting scheduled task to PM (target agent not in project)", {
                taskId: task.id,
                projectId: task.projectId,
                originalTarget: truncatePubkey(task.toPubkey),
                pmPubkey: truncatePubkey(pm.pubkey),
                pmSlug: pm.slug,
            });

            trace.getActiveSpan()?.addEvent("scheduler.task_rerouted_to_pm", {
                "task.id": task.id,
                "task.original_target": truncatePubkey(task.toPubkey),
                "task.pm_pubkey": truncatePubkey(pm.pubkey),
                "task.pm_slug": pm.slug,
                "project.id": task.projectId,
            });

            return pm.pubkey;
        } catch (error) {
            // If we can't access the daemon (e.g., during tests or standalone mode),
            // fall back to original target
            logger.warn("Failed to resolve target pubkey, using original", {
                taskId: task.id,
                error: error instanceof Error ? error.message : String(error),
            });
            return task.toPubkey;
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

        // Resolve the target pubkey - if the target agent is not in the project,
        // route to the PM of that project instead
        const targetPubkey = this.resolveTargetPubkey(task);

        const event = new NDKEvent(this.ndk);
        event.kind = 1; // Unified conversation format (kind:1)
        event.content = task.prompt;

        // Build tags - use stored projectId instead of getting from context
        // The projectId is stored when the task is created (within project context)
        const tags: string[][] = [
            ["a", task.projectId], // Project reference (stored at task creation time)
            ["p", targetPubkey], // Target agent that should handle this task (may be PM if original target not in project)
        ];

        // Add metadata about the scheduled task
        tags.push(["scheduled-task-id", task.id]);

        // Use appropriate tag based on task type
        if (task.type === "oneoff" && task.executeAt) {
            // One-off tasks use execute-at tag with ISO timestamp
            tags.push(["scheduled-task-execute-at", task.executeAt]);
        } else {
            // Recurring tasks use cron tag with cron expression
            tags.push(["scheduled-task-cron", task.schedule]);
        }

        event.tags = tags;

        // Use backend signer for scheduled tasks
        // The backend key is always available and whitelisted
        // We store fromPubkey for tracking but sign with backend key
        const privateKey = await config.ensureBackendPrivateKey();
        const signer = new NDKPrivateKeySigner(privateKey);

        // Sign and publish the event
        await event.sign(signer);
        await event.publish();

        const wasRerouted = targetPubkey !== task.toPubkey;

        logger.info("Published scheduled task event", {
            taskId: task.id,
            projectId: task.projectId,
            eventId: event.id?.substring(0, 8),
            from: truncatePubkey(signer.pubkey),
            to: truncatePubkey(targetPubkey),
            originalTarget: wasRerouted ? truncatePubkey(task.toPubkey) : undefined,
            reroutedToPM: wasRerouted,
        });

        trace.getActiveSpan()?.addEvent("scheduler.event_published", {
            "task.id": task.id,
            "event.id": event.id || "unknown",
            "event.from": truncatePubkey(signer.pubkey),
            "event.to": truncatePubkey(targetPubkey),
            "event.original_target": wasRerouted ? truncatePubkey(task.toPubkey) : undefined,
            "event.rerouted_to_pm": wasRerouted,
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
        return `task-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    }

    public shutdown(): void {
        trace.getActiveSpan()?.addEvent("scheduler.shutting_down", {
            "tasks.count": this.tasks.size,
            "oneoff.count": this.oneoffTimers.size,
        });

        // Stop all cron tasks
        for (const [, cronTask] of this.tasks.entries()) {
            cronTask.stop();
        }

        // Clear all one-off timers
        for (const [, timer] of this.oneoffTimers.entries()) {
            clearTimeout(timer);
        }

        this.tasks.clear();
        this.oneoffTimers.clear();
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
