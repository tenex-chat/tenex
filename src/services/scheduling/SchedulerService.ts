import * as fs from "node:fs/promises";
import { getProjectSchedulesPath, normalizeProjectIdForRuntime } from "./storage";
import type { ScheduledTask } from "./types";
import { getNDK } from "@/nostr/ndkClient";
import { config } from "@/services/ConfigService";
import { getProjectContext } from "@/services/projects";
import { ensureDirectory, fileExists, readJsonFile, writeJsonFile } from "@/lib/fs";
import { shortenOptionalEventId } from "@/utils/conversation-id";
import { logger } from "@/utils/logger";
import type NDK from "@nostr-dev-kit/ndk";
import { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { trace } from "@opentelemetry/api";
import { CronExpressionParser } from "cron-parser";
import * as cron from "node-cron";

export interface TargetResolution {
    pubkey: string;
    resolvedSlug?: string;
}

/** Truncate a pubkey for logging (first 8 characters) */
function truncatePubkey(pubkey: string): string {
    return pubkey.substring(0, 8);
}

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
    private ndk: NDK | null = null;

    private constructor() {}

    public static getInstance(): SchedulerService {
        if (!SchedulerService.instance) {
            SchedulerService.instance = new SchedulerService();
        }
        return SchedulerService.instance;
    }

    public async initialize(ndk: NDK, _projectPath?: string): Promise<void> {
        this.ndk = ndk;

        await ensureDirectory(config.getConfigPath("projects"));

        // Load existing tasks and start their crons/timers via reconciliation
        await this.loadTasks();

        // Check for missed tasks BEFORE starting regular scheduling
        // This ensures catch-ups happen first and update lastRun
        await this.checkMissedTasks();

        trace.getActiveSpan()?.addEvent("scheduler.initialized", {
            "tasks.count": this.taskMetadata.size,
        });
    }

    public async addTask(
        schedule: string,
        prompt: string,
        fromPubkey: string,
        targetAgentSlug: string,
        projectId?: string,
        options?: { title?: string; targetChannel?: string; projectRef?: string } | string,
        targetChannel?: string
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

        const normalizedProjectId = normalizeProjectIdForRuntime(resolvedProjectId);
        const taskId = this.generateTaskId();

        // Resolve options: 6th param can be a string (legacy title) or an options object
        const resolvedTitle =
            typeof options === "string" ? options : options?.title;
        const resolvedTargetChannel =
            typeof options === "object" ? options?.targetChannel : targetChannel;
        const resolvedProjectRef =
            typeof options === "object" && options?.projectRef
                ? options.projectRef
                : resolvedProjectId;

        // Store locally for cron management
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

        // Write-through: persist → reload → reconcile
        await this.saveProjectTasks(task.projectId);
        const reloadedTasks = await this.reloadTasksFromJson(task.projectId);
        await this.reconcileTasksInMemory(task.projectId, reloadedTasks);

        logger.info(`Created scheduled task ${taskId} with cron schedule: ${schedule}`, {
            projectId: task.projectId,
            fromPubkey: truncatePubkey(fromPubkey),
            targetAgentSlug,
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
        targetAgentSlug: string,
        projectId?: string,
        title?: string,
        targetChannel?: string
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

        const normalizedProjectId = normalizeProjectIdForRuntime(resolvedProjectId);
        const taskId = this.generateTaskId();

        const task: ScheduledTask = {
            id: taskId,
            title,
            schedule: executeAt.toISOString(), // Store ISO timestamp for display
            prompt,
            fromPubkey,
            targetAgentSlug,
            projectId: normalizedProjectId,
            projectRef: resolvedProjectId,
            createdAt: new Date().toISOString(),
            type: "oneoff",
            executeAt: executeAt.toISOString(),
            ...(targetChannel && { targetChannel }),
        };

        this.taskMetadata.set(taskId, task);

        // Write-through: persist → reload → reconcile
        await this.saveProjectTasks(task.projectId);
        const reloadedTasks = await this.reloadTasksFromJson(task.projectId);
        await this.reconcileTasksInMemory(task.projectId, reloadedTasks);

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
        const task = this.taskMetadata.get(taskId);

        if (!task) {
            return false;
        }

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

        // Write-through: persist → reload → reconcile
        await this.saveProjectTasks(task.projectId);
        const reloadedTasks = await this.reloadTasksFromJson(task.projectId);
        await this.reconcileTasksInMemory(task.projectId, reloadedTasks);

        logger.info(`Removed scheduled task ${taskId}`);
        return true;
    }

    public async getTasks(projectId?: string): Promise<ScheduledTask[]> {
        const allTasks = Array.from(this.taskMetadata.values());

        // If projectId is provided, filter tasks by that project
        if (projectId) {
            const normalizedProjectId = normalizeProjectIdForRuntime(projectId);
            return allTasks.filter(
                (task) => normalizeProjectIdForRuntime(task.projectId) === normalizedProjectId
            );
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
        const task = this.taskMetadata.get(taskId);
        this.oneoffTimers.delete(taskId);
        this.taskMetadata.delete(taskId);
        // Save asynchronously - don't block on corrupted task cleanup
        const persist = task ? this.saveProjectTasks(task.projectId) : Promise.resolve();
        persist.catch((error) => {
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
            await this.saveProjectTasks(task.projectId);

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
            const affectedProjects = new Set<string>();
            for (const taskId of expiredTasks) {
                const task = this.taskMetadata.get(taskId);
                this.oneoffTimers.delete(taskId);
                this.taskMetadata.delete(taskId);
                if (task) {
                    affectedProjects.add(task.projectId);
                }
            }
            await Promise.all(
                Array.from(affectedProjects).map((projectId) => this.saveProjectTasks(projectId))
            );

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
                    await this.saveProjectTasks(task.projectId);
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
        await this.saveProjectTasks(task.projectId);

        trace.getActiveSpan()?.addEvent("scheduler.task_triggered", {
            "task.id": task.id,
        });
    }

    /**
     * Resolve the target pubkey for a scheduled task.
     * TypeScript worker processes do not own project boot/routing state; they can
     * only resolve targets from the active project context. Background schedule
     * publishing is owned by the Rust daemon.
     *
     * @param task - The scheduled task to resolve target for
     * @returns The resolved target pubkey and routing metadata
     */
    protected resolveTargetPubkey(task: ScheduledTask): TargetResolution {
        try {
            const resolvedViaContext = this.resolveTargetFromProjectContext(task);
            if (resolvedViaContext) {
                return resolvedViaContext;
            }

            throw new Error(
                `Could not resolve scheduled task target slug "${task.targetAgentSlug}" in the current project context`
            );
        } catch (error) {
            logger.warn("Failed to resolve target pubkey", {
                taskId: task.id,
                targetAgentSlug: task.targetAgentSlug,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }

    private resolveTargetFromProjectContext(task: ScheduledTask): TargetResolution | null {
        try {
            const projectContext = getProjectContext();
            const currentProjectId = normalizeProjectIdForRuntime(projectContext.project.tagId());
            if (currentProjectId !== normalizeProjectIdForRuntime(task.projectId)) {
                return null;
            }

            const targetAgent = projectContext.getProjectAgentBySlug(task.targetAgentSlug);
            if (!targetAgent) {
                return null;
            }

            return {
                pubkey: targetAgent.pubkey,
                resolvedSlug: targetAgent.slug,
            };
        } catch {
            return null;
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

        // Resolve the target pubkey from the active project context.
        const targetResolution = this.resolveTargetPubkey(task);
        const targetPubkey = targetResolution.pubkey;

        const event = new NDKEvent(this.ndk);
        event.kind = 1; // Unified conversation format (kind:1)
        event.content = task.prompt;

        // Build tags - use stored projectId instead of getting from context
        // The projectId is stored when the task is created (within project context)
        const tags: string[][] = [
            ["a", task.projectRef ?? task.projectId], // Project reference (stored at task creation time)
            ["p", targetPubkey], // Target agent that should handle this task
        ];

        // Add metadata about the scheduled task
        tags.push(["scheduled-task-id", task.id]);

        // Route into an existing conversation channel if specified
        if (task.targetChannel) {
            tags.push(["e", task.targetChannel]);
        }

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

        logger.info("Published scheduled task event", {
            taskId: task.id,
            projectId: task.projectId,
            eventId: shortenOptionalEventId(event.id),
            from: truncatePubkey(signer.pubkey),
            to: truncatePubkey(targetPubkey),
            resolvedSlug: targetResolution.resolvedSlug,
        });

        if (!event.id) {
            throw new Error("[SchedulerService] Missing event id after publish.");
        }

        trace.getActiveSpan()?.addEvent("scheduler.event_published", {
            "task.id": task.id,
            "event.id": event.id,
            "event.from": truncatePubkey(signer.pubkey),
            "event.to": truncatePubkey(targetPubkey),
            "project.id": task.projectId,
        });
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
            logger.warn("Skipping invalid schedules file", { filePath, projectId: normalizedProjectId });
            return [];
        }

        const validTasks: ScheduledTask[] = [];
        for (const task of raw) {
            if (!task.id || !task.prompt || !task.fromPubkey || !task.targetAgentSlug || !task.projectId) {
                logger.warn("Skipping schedule with missing required fields", { taskId: task.id });
                continue;
            }

            if (task.type !== "oneoff" && !cron.validate(task.schedule)) {
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
     * Reconcile in-memory cron/timer state so it exactly matches reloadedTasks for this project.
     * - Tasks in reloadedTasks but not in memory: start them
     * - Tasks in memory with changed schedule: stop old, start new
     * - Tasks in memory but not in reloadedTasks: stop and remove
     */
    async reconcileTasksInMemory(projectId: string, reloadedTasks: ScheduledTask[]): Promise<void> {
        const normalizedProjectId = normalizeProjectIdForRuntime(projectId);

        // Build a map of reloaded tasks for quick lookup
        const reloadedMap = new Map<string, ScheduledTask>();
        for (const task of reloadedTasks) {
            reloadedMap.set(task.id, task);
        }

        // Find tasks currently in memory for this project
        const inMemoryIds = new Set<string>();
        for (const [id, task] of this.taskMetadata.entries()) {
            if (normalizeProjectIdForRuntime(task.projectId) === normalizedProjectId) {
                inMemoryIds.add(id);
            }
        }

        // Stop and remove tasks that are no longer in the reloaded set
        for (const id of inMemoryIds) {
            if (!reloadedMap.has(id)) {
                const cronTask = this.tasks.get(id);
                if (cronTask) {
                    cronTask.stop();
                    this.tasks.delete(id);
                }
                const timer = this.oneoffTimers.get(id);
                if (timer) {
                    clearTimeout(timer);
                    this.oneoffTimers.delete(id);
                }
                this.taskMetadata.delete(id);
            }
        }

        // Add or update tasks from the reloaded set
        for (const task of reloadedTasks) {
            const existing = this.taskMetadata.get(task.id);
            if (!existing) {
                // New task — start it
                this.taskMetadata.set(task.id, task);
                if (task.type === "oneoff") {
                    this.startOneoffTask(task);
                } else {
                    this.startTask(task);
                }
            } else if (existing.schedule !== task.schedule) {
                // Schedule changed — stop old, start new
                const cronTask = this.tasks.get(task.id);
                if (cronTask) {
                    cronTask.stop();
                    this.tasks.delete(task.id);
                }
                const timer = this.oneoffTimers.get(task.id);
                if (timer) {
                    clearTimeout(timer);
                    this.oneoffTimers.delete(task.id);
                }
                this.taskMetadata.set(task.id, task);
                if (task.type === "oneoff") {
                    this.startOneoffTask(task);
                } else {
                    this.startTask(task);
                }
            } else {
                // Same schedule — update metadata but keep running timer/cron
                this.taskMetadata.set(task.id, task);
                // If the cron/timer is not actually running yet, start it now
                const isRunning =
                    this.tasks.has(task.id) || this.oneoffTimers.has(task.id);
                if (!isRunning) {
                    if (task.type === "oneoff") {
                        this.startOneoffTask(task);
                    } else {
                        this.startTask(task);
                    }
                }
            }
        }
    }

    private async loadTasks(): Promise<void> {
        try {
            const projectsBase = config.getConfigPath("projects");
            const entries = await fs.readdir(projectsBase, { withFileTypes: true });
            let loadedCount = 0;

            for (const entry of entries) {
                if (!entry.isDirectory()) {
                    continue;
                }

                const projectId = entry.name;
                const filePath = getProjectSchedulesPath(projectId);

                if (!(await fileExists(filePath))) {
                    continue;
                }

                const tasks = await readJsonFile<ScheduledTask[]>(filePath);
                if (!Array.isArray(tasks)) {
                    logger.warn("Skipping invalid schedules file", { filePath });
                    continue;
                }

                for (const task of tasks) {
                    const normalizedProjectId = normalizeProjectIdForRuntime(
                        task.projectId || projectId
                    );
                    if (!task.targetAgentSlug) {
                        logger.warn("Skipping schedule without targetAgentSlug", {
                            taskId: task.id,
                            filePath,
                        });
                        continue;
                    }

                    this.taskMetadata.set(task.id, {
                        ...task,
                        projectId: normalizedProjectId,
                        projectRef: task.projectRef ?? task.projectId,
                    });
                    loadedCount++;
                }

                // Start crons/timers for this project's loaded tasks
                const projectTasks = Array.from(this.taskMetadata.values()).filter(
                    (t) => normalizeProjectIdForRuntime(t.projectId) === normalizeProjectIdForRuntime(projectId)
                );
                await this.reconcileTasksInMemory(projectId, projectTasks);
            }

            trace.getActiveSpan()?.addEvent("scheduler.tasks_loaded", {
                "tasks.count": loadedCount,
            });
        } catch (error: unknown) {
            if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
                // No existing file, starting fresh - this is expected
            } else {
                logger.error("Failed to load scheduled tasks:", error);
            }
        }
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

    public async clearAllTasks(projectId?: string): Promise<void> {
        const affectedProjects = new Set<string>();

        if (projectId) {
            // Clear only tasks for the specified project
            const normalizedProjectId = normalizeProjectIdForRuntime(projectId);
            for (const [id, task] of this.taskMetadata.entries()) {
                if (normalizeProjectIdForRuntime(task.projectId) === normalizedProjectId) {
                    const cronTask = this.tasks.get(id);
                    if (cronTask) {
                        cronTask.stop();
                        this.tasks.delete(id);
                    }
                    const timer = this.oneoffTimers.get(id);
                    if (timer) {
                        clearTimeout(timer);
                        this.oneoffTimers.delete(id);
                    }
                    this.taskMetadata.delete(id);
                    affectedProjects.add(task.projectId);
                }
            }
        } else {
            // Clear all tasks across all projects
            for (const task of this.taskMetadata.values()) {
                affectedProjects.add(task.projectId);
            }

            for (const cronTask of this.tasks.values()) {
                cronTask.stop();
            }

            for (const timer of this.oneoffTimers.values()) {
                clearTimeout(timer);
            }

            this.tasks.clear();
            this.oneoffTimers.clear();
            this.taskMetadata.clear();
        }

        // Write-through: persist → reload → reconcile for each affected project
        await Promise.all(
            Array.from(affectedProjects).map(async (pid) => {
                await this.saveProjectTasks(pid);
                const reloadedTasks = await this.reloadTasksFromJson(pid);
                await this.reconcileTasksInMemory(pid, reloadedTasks);
            })
        );
    }
}
