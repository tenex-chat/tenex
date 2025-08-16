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
 * Strips thinking blocks from message content.
 * Removes everything between <thinking> and </thinking> tags.
 */
function stripThinkingBlocks(content: string): string {
    // Remove thinking blocks including the tags themselves
    return content.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim();
}

/**
 * ClaudeBackend executes tasks by directly calling Claude Code
 * and then uses the same completion logic as the complete() tool to return
 * control to the orchestrator.
 */
export class ClaudeBackend implements ExecutionBackend {
    async execute(
        messages: Array<Message>,
        _tools: Tool[],
        context: ExecutionContext,
        publisher: NostrPublisher
    ): Promise<void> {
        // Strip thinking blocks from all messages before processing
        const cleanedMessages = messages.map(msg => {
            const originalContent = msg.content || "";
            const cleanedContent = stripThinkingBlocks(originalContent);
            
            // Log if we actually stripped any thinking blocks
            if (originalContent !== cleanedContent) {
                const removedLength = originalContent.length - cleanedContent.length;
                logger.debug(`[ClaudeBackend] Stripped thinking blocks from ${msg.role} message`, {
                    originalLength: originalContent.length,
                    cleanedLength: cleanedContent.length,
                    removedLength,
                    agent: context.agent.name
                });
            }
            
            return {
                ...msg,
                content: cleanedContent
            };
        });
        
        // Extract ALL system messages for proper context
        const systemMessages = cleanedMessages.filter(m => m.role === "system");
        const nonSystemMessages = cleanedMessages.filter(m => m.role !== "system");
        
        // First system message becomes the main system prompt for Claude
        const mainSystemPrompt = systemMessages[0]?.content || "";
        
        // Build the user prompt with additional system context if present
        let prompt = "";
        
        // If we have additional system messages (phase transitions, etc), include them
        if (systemMessages.length > 1) {
            const additionalSystemContext = systemMessages.slice(1)
                .map(msg => msg.content)
                .join("\n\n");
            
            prompt = `<system_context>
${additionalSystemContext}
</system_context>

`;
        }
        
        // Add the actual user/assistant messages
        const lastMessage = nonSystemMessages[nonSystemMessages.length - 1];
        if (!lastMessage) {
            throw new Error("No user message provided");
        }
        prompt += lastMessage.content || "";

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
            systemPrompt: mainSystemPrompt,
            projectPath: context.projectPath || "",
            title: `Claude Code Execution (via ${context.agent.name})`,
            conversationRootEventId: context.conversationId,
            conversation: context.conversationManager.getConversation(context.conversationId),
            conversationManager: context.conversationManager,
            abortSignal: abortController.signal,
            resumeSessionId: context.claudeSessionId,
            agentName: context.agent.name,
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

        // Get the unpublished event from completion handler
        logger.info("[ClaudeBackend] Getting unpublished event from handleAgentCompletion");
        const { event } = await handleAgentCompletion({
            response: claudeReport,
            summary: `Claude Code execution completed. Task ID: ${result.task.id}`,
            agent: context.agent,
            conversationId: context.conversationId,
            publisher,
            triggeringEvent: context.triggeringEvent,
            conversationManager: context.conversationManager,
        });

        // Create metadata from Claude's results
        const claudeMetadata: import("@/nostr/types").LLMMetadata = {
            model: "claude-code",
            cost: result.totalCost,
            promptTokens: 0,  // Claude Code doesn't provide token counts
            completionTokens: 0,
            totalTokens: 0,
            systemPrompt: mainSystemPrompt || "",
            userPrompt: prompt,  // We have this from earlier
            rawResponse: claudeReport,
        };

        logger.info("[ClaudeBackend] Adding Claude metadata to event", {
            model: claudeMetadata.model,
            cost: claudeMetadata.cost,
            hasSystemPrompt: !!mainSystemPrompt,
            systemMessageCount: systemMessages.length,
            promptLength: prompt.length,
            responseLength: claudeReport.length,
        });

        // Add metadata to event
        publisher.addLLMMetadata(event, claudeMetadata);

        // Sign and publish immediately (ClaudeBackend doesn't wait for streaming)
        await event.sign(context.agent.signer);
        await event.publish();

        logger.info("[ClaudeBackend] ✅ Published completion with metadata", {
            eventId: event.id,
            cost: result.totalCost,
            messageCount: result.messageCount,
            duration: result.duration,
            sessionId: result.sessionId,
        });
    }
}
