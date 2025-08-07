import type { Agent } from "@/agents/types";
import { getProjectContext } from "@/services";
import { logger } from "@/utils/logger";
import type NDK from "@nostr-dev-kit/ndk";
import { NDKTask } from "@nostr-dev-kit/ndk";

export interface TaskCreationOptions {
    title: string;
    prompt: string;
    branch?: string;
    conversationRootEventId?: string;
}

export interface TaskCompletionOptions {
    sessionId?: string;
    totalCost?: number;
    messageCount?: number;
    duration?: number;
    error?: string;
}

/**
 * Publishes NDKTask events to Nostr
 * Single Responsibility: Manage the lifecycle of NDKTask events (create and complete)
 */
export class TaskPublisher {
    private currentTask?: NDKTask;

    constructor(
        private ndk: NDK,
        private agent: Agent
    ) {}

    async createTask(options: TaskCreationOptions): Promise<NDKTask> {
        const projectCtx = getProjectContext();

        const task = new NDKTask(this.ndk);
        task.title = options.title;
        task.content = options.prompt;

        // Tag the project
        task.tag(projectCtx.project);

        // Add branch tag if provided
        if (options.branch) {
            task.tags.push(["branch", options.branch]);
        }

        // Link to conversation if provided
        if (options.conversationRootEventId) {
            task.tags.push(["e", options.conversationRootEventId, "", "reply"]);
        }

        // Sign with the agent's signer
        await task.sign(this.agent.signer);

        // we want to allow any message that prefaces the creation of this task to be published
        // setTimeout(task.publish, 500);
        await task.publish();

        // Store the task instance for future operations
        this.currentTask = task;

        return task;
    }

    async completeTask(_success: boolean, _options: TaskCompletionOptions): Promise<void> {
        if (!this.currentTask) {
            throw new Error("No current task to complete. Call createTask first.");
        }
    }

    async publishTaskProgress(content: string, sessionId?: string): Promise<void> {
        if (!this.currentTask) {
            throw new Error("No current task for progress updates. Call createTask first.");
        }

        const task = this.currentTask;
        const projectCtx = getProjectContext();

        // Create a proper reply using the task event
        const progressUpdate = task.reply();
        progressUpdate.content = content;
        progressUpdate.tags.push(["status", "progress"]);

        // remove all p tags
        progressUpdate.tags = progressUpdate.tags.filter((t) => t[0] !== "p");

        // Add session ID if available
        if (sessionId) {
            progressUpdate.tags.push(["claude-session", sessionId]);
        }

        // Add project tag
        progressUpdate.tag(projectCtx.project);

        // Sign with the agent's signer
        await progressUpdate.sign(this.agent.signer);
        try {
            await progressUpdate.publish();
        } catch (e) {
            logger.debug("Error publishing update: " + (e instanceof Error ? e.message : String(e)), {
                taskId: task.id,
                contentLength: content.length,
                sessionId,
            });
            return;
        }

        logger.debug("Published task progress", {
            taskId: task.id,
            contentLength: content.length,
            sessionId,
        });
    }
}
