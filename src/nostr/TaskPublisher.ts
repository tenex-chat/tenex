import type { AgentInstance } from "@/agents/types";
import { getProjectContext } from "@/services";
import { logger } from "@/utils/logger";
import type NDK from "@nostr-dev-kit/ndk";
import { NDKTask } from "@nostr-dev-kit/ndk";
import type { ConversationManager } from "@/conversations/ConversationManager";

export interface TaskCreationOptions {
    title: string;
    prompt: string;
    branch?: string;
    conversationRootEventId?: string;
    conversationManager?: ConversationManager;
    claudeSessionId?: string;
}

export interface TaskCompletionOptions {
    sessionId?: string;
    totalCost?: number;
    messageCount?: number;
    duration?: number;
    error?: string;
    finalMessage?: string;
}

/**
 * Publishes NDKTask events to Nostr
 * Single Responsibility: Manage the lifecycle of NDKTask events (create and complete)
 */
export class TaskPublisher {
    private currentTask?: NDKTask;

    constructor(
        private ndk: NDK,
        private agent: AgentInstance
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

        // Register task mapping if conversation manager is provided
        if (options.conversationManager && options.conversationRootEventId && task.id) {
            await options.conversationManager.registerTaskMapping(
                task.id,
                options.conversationRootEventId,
                options.claudeSessionId
            );
            logger.debug("Registered task mapping for conversation", {
                taskId: task.id,
                conversationId: options.conversationRootEventId,
                claudeSessionId: options.claudeSessionId
            });
        }

        return task;
    }

    /**
     * Completes the current task by publishing a completion event
     * @param success - Whether the task completed successfully
     * @param options - Additional metadata about the task completion
     */
    async completeTask(success: boolean, options: TaskCompletionOptions): Promise<void> {
        if (!this.currentTask) {
            throw new Error("No current task to complete. Call createTask first.");
        }

        const task = this.currentTask;
        const projectCtx = getProjectContext();

        // Create a completion event as a reply to the task
        const completionEvent = task.reply();
        
        // Build completion message
        const status = success ? "completed" : "failed";
        const statusEmoji = success ? "✅" : "❌";
        
        let content: string;
        
        // Use finalMessage if provided, otherwise use generic completion message
        if (options.finalMessage && success) {
            content = options.finalMessage;
            
            // Append metadata as a footer
            const metadata: string[] = [];
            
            if (options.messageCount) {
                metadata.push(`Messages: ${options.messageCount}`);
            }
            
            if (options.duration) {
                const durationInSeconds = Math.round(options.duration / 1000);
                metadata.push(`Duration: ${durationInSeconds}s`);
            }
            
            if (options.totalCost) {
                metadata.push(`Cost: $${options.totalCost.toFixed(4)}`);
            }
            
            if (metadata.length > 0) {
                content += `\n\n---\n${statusEmoji} Task ${status} • ${metadata.join(" • ")}`;
            }
        } else {
            // Fallback to generic message
            content = `${statusEmoji} Task ${status}`;
            
            if (options.error) {
                content += `\n\nError: ${options.error}`;
            }
            
            if (options.messageCount) {
                content += `\n\nMessages exchanged: ${options.messageCount}`;
            }
            
            if (options.duration) {
                const durationInSeconds = Math.round(options.duration / 1000);
                content += `\nDuration: ${durationInSeconds}s`;
            }
            
            if (options.totalCost) {
                content += `\nCost: $${options.totalCost.toFixed(4)}`;
            }
        }

        completionEvent.content = content;
        
        // Add status tag
        completionEvent.tags.push(["status", status]);
        
        // Remove all p tags (we don't want to notify all participants)
        completionEvent.tags = completionEvent.tags.filter((t) => t[0] !== "p");
        
        // Add session ID if available
        if (options.sessionId) {
            completionEvent.tags.push(["claude-session", options.sessionId]);
        }
        
        // Add error tag if task failed
        if (!success && options.error) {
            completionEvent.tags.push(["error", options.error]);
        }
        
        // Add project tag
        completionEvent.tag(projectCtx.project);
        
        // Sign with the agent's signer
        await completionEvent.sign(this.agent.signer);
        
        try {
            await completionEvent.publish();
            logger.debug("Published task completion", {
                taskId: task.id,
                status,
                sessionId: options.sessionId,
                success,
            });
        } catch (e) {
            logger.error("Error publishing task completion: " + (e instanceof Error ? e.message : String(e)), {
                taskId: task.id,
                status,
                sessionId: options.sessionId,
            });
            // Don't throw - task completion is best effort
        }
        
        // Clear the current task after completion
        this.currentTask = undefined;
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
