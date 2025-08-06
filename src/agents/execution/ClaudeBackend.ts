import type { Tool } from "@/tools/types";
import type { ExecutionBackend } from "./ExecutionBackend";
import type { ExecutionContext } from "./types";
import { handleAgentCompletion } from "./completionHandler";
import { ClaudeTaskOrchestrator } from "@/claude/orchestrator";
import { TaskPublisher } from "@/nostr/TaskPublisher";
import { getNDK } from "@/nostr/ndkClient";
import type { NostrPublisher } from "@/nostr/NostrPublisher";
import { logger } from "@/utils/logger";
import type { Message } from "multi-llm-ts";

/**
 * ClaudeBackend executes tasks by directly calling Claude Code
 * and then uses the same completion logic as the complete() tool to return
 * control to the orchestrator.
 */
export class ClaudeBackend implements ExecutionBackend {
    async execute(
        messages: Array<Message>,
        tools: Tool[],
        context: ExecutionContext,
        publisher: NostrPublisher
    ): Promise<void> {
        // Extract the system prompt from messages
        const systemMessage = messages.find((m) => m.role === "system");
        const systemPrompt = systemMessage?.content;

        // Extract the prompt from the last user message
        const lastMessage = messages[messages.length - 1];
        if (!lastMessage) {
            throw new Error("No messages provided");
        }
        const prompt = lastMessage.content || "";

        if (!prompt) {
            throw new Error("No prompt found in messages");
        }

        // Create instances for direct Claude Code execution
        const ndk = getNDK();
        const taskPublisher = new TaskPublisher(ndk, context.agent);
        const orchestrator = new ClaudeTaskOrchestrator(taskPublisher);

        // Create abort controller for this execution
        const abortController = new AbortController();

        // Log if we have a claude session ID to resume
        if (context.claudeSessionId) {
            logger.info(`[ClaudeBackend] Resuming Claude session: ${context.claudeSessionId}`);
        }

        // Execute Claude Code directly
        const result = await orchestrator.execute({
            prompt,
            systemPrompt,
            projectPath: context.projectPath || "",
            title: `Claude Code Execution (via ${context.agent.name})`,
            conversationRootEventId: context.conversationId,
            conversation: context.conversationManager.getConversation(context.conversationId),
            abortSignal: abortController.signal,
            resumeSessionId: context.claudeSessionId,
        });

        if (!result.success) {
            throw new Error(`Claude code execution failed: ${result.error || "Unknown error"}`);
        }

        // Store the Claude session ID using the new updateAgentState method
        if (result.sessionId) {
            await context.conversationManager.updateAgentState(
                context.conversationId,
                context.agent.slug,
                { claudeSessionId: result.sessionId }
            );
            logger.info(`[ClaudeBackend] Stored Claude session ID for agent ${context.agent.slug}: ${result.sessionId}`);
        }

        // Use Claude's final response instead of the original task content
        const claudeReport =
            result.finalResponse || result.task.content || "Task completed successfully";

        // Use the same completion handler as the complete() tool
        // This will publish the completion event
        await handleAgentCompletion({
            response: claudeReport,
            summary: `Claude Code execution completed. Task ID: ${result.task.id}`,
            agent: context.agent,
            conversationId: context.conversationId,
            publisher,
            triggeringEvent: context.triggeringEvent,
        });
    }
}
