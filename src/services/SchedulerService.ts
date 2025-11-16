import * as os from "os";
import * as path from "path";
import type NDK from "@nostr-dev-kit/ndk";
import { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import * as fs from "fs/promises";
import * as cron from "node-cron";
import { logger } from "../utils/logger";
import { ConfigService } from "./ConfigService";
import { getProjectContext } from "./ProjectContext";

interface ScheduledTask {
    id: string;
    schedule: string; // Cron expression
    prompt: string;
    lastRun?: string;
    nextRun?: string;
    fromPubkey: string; // Who scheduled this task (the scheduler)
    toPubkey: string; // Target agent that should execute the task
}

export class SchedulerService {
    private static instance: SchedulerService;
    private tasks: Map<string, cron.ScheduledTask> = new Map();
    private taskMetadata: Map<string, ScheduledTask> = new Map();
    private taskFilePath: string;
    private ndk: NDK | null = null;
    private projectPath: string | null = null;

    private constructor() {
        // Use global location for scheduled tasks since it's a singleton
        const tenexDir = path.join(os.homedir(), ".tenex");
        this.taskFilePath = path.join(tenexDir, "scheduled_tasks.json");
    }

    public static getInstance(): SchedulerService {
        if (!SchedulerService.instance) {
            SchedulerService.instance = new SchedulerService();
        }
        return SchedulerService.instance;
    }

    public async initialize(ndk: NDK, projectPath?: string): Promise<void> {
        this.ndk = ndk;
        this.projectPath = projectPath || process.cwd();

        logger.debug("Initializing SchedulerService");

        // Ensure .tenex directory exists
        const tenexDir = path.dirname(this.taskFilePath);
        await fs.mkdir(tenexDir, { recursive: true });

        // Load existing tasks
        await this.loadTasks();

        // Start all loaded tasks
        for (const task of this.taskMetadata.values()) {
            this.startTask(task);
        }

        logger.debug(`SchedulerService initialized with ${this.taskMetadata.size} tasks`);
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
                scheduled: true,
                timezone: "UTC",
            }
        );

        this.tasks.set(task.id, cronTask);
        logger.debug(`Started cron task ${task.id} with schedule: ${task.schedule}`);
    }

    private async executeTask(task: ScheduledTask): Promise<void> {
        logger.info(`Executing scheduled task ${task.id}: ${task.prompt}`);

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

            logger.info(`Successfully triggered scheduled task ${task.id} via kind:11 event`);
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
                const privateKey = await ConfigService.getInstance().ensureBackendPrivateKey();
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

        logger.info(
            `Published kind:11 event for scheduled task ${task.id} from ${signer.pubkey} to ${task.toPubkey}`
        );
    }

    private async loadTasks(): Promise<void> {
        try {
            const data = await fs.readFile(this.taskFilePath, "utf-8");
            const tasks = JSON.parse(data) as ScheduledTask[];

            for (const task of tasks) {
                this.taskMetadata.set(task.id, task);
            }

            logger.debug(`Loaded ${tasks.length} scheduled tasks from disk`);
        } catch (error: unknown) {
            if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
                logger.debug("No existing scheduled tasks file found, starting fresh");
            } else {
                logger.error("Failed to load scheduled tasks:", error);
            }
        }
    }

    private async saveTasks(): Promise<void> {
        try {
            const tasks = Array.from(this.taskMetadata.values());
            await fs.writeFile(this.taskFilePath, JSON.stringify(tasks, null, 2));
            logger.debug(`Saved ${tasks.length} scheduled tasks to disk`);
        } catch (error) {
            logger.error("Failed to save scheduled tasks:", error);
        }
    }

    private generateTaskId(): string {
        return `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    public shutdown(): void {
        logger.info("Shutting down SchedulerService");

        // Stop all cron tasks
        for (const [taskId, cronTask] of this.tasks.entries()) {
            cronTask.stop();
            logger.debug(`Stopped cron task ${taskId}`);
        }

        this.tasks.clear();
        this.taskMetadata.clear(); // Also clear metadata
        logger.info("SchedulerService shutdown complete");
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
