import { ClaudeTaskOrchestrator } from "@/claude/orchestrator";
import { TaskPublisher } from "@/nostr/TaskPublisher";
import { getNDK } from "@/nostr/ndkClient";
import { formatAnyError } from "@/utils/error-formatter";
import { logger } from "@/utils/logger";
import { z } from "zod";
import { createToolDefinition, success, failure } from "../types";

/**
 * Strips thinking blocks from content.
 * Removes everything between <thinking> and </thinking> tags.
 */
function stripThinkingBlocks(content: string): string {
    return content.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim();
}

const claudeCodeSchema = z.object({
    prompt: z.string().min(1).describe("The prompt for Claude Code to execute"),
    systemPrompt: z
        .string()
        .optional()
        .describe("Optional system prompt to provide additional context or constraints"),
    title: z
        .string()
        .optional()
        .describe("Optional title for the task (defaults to 'Claude Code Execution')"),
    branch: z
        .string()
        .optional()
        .describe("Optional branch name for the task"),
});

interface ClaudeCodeOutput {
    sessionId?: string;
    totalCost: number;
    messageCount: number;
    duration: number;
    response: string;
}

export const claudeCode = createToolDefinition<z.infer<typeof claudeCodeSchema>, ClaudeCodeOutput>({
    name: "claude_code",
    description:
        "Execute Claude Code to perform planning or to execute changes. Claude Code has full access to read, write, and execute code in the project. This tool maintains session continuity for iterative development.",
    schema: claudeCodeSchema,
    execute: async (input, context) => {
        const { prompt, systemPrompt, title, branch } = input.value;
        
        // Strip thinking blocks from prompts
        const cleanedPrompt = stripThinkingBlocks(prompt);
        const cleanedSystemPrompt = systemPrompt ? stripThinkingBlocks(systemPrompt) : undefined;
        
        // Log if we stripped any thinking blocks
        if (cleanedPrompt !== prompt) {
            logger.debug("[claude_code] Stripped thinking blocks from prompt", {
                originalLength: prompt.length,
                cleanedLength: cleanedPrompt.length,
                agent: context.agent.name
            });
        }
        if (systemPrompt && cleanedSystemPrompt !== systemPrompt) {
            logger.debug("[claude_code] Stripped thinking blocks from system prompt", {
                originalLength: systemPrompt.length,
                cleanedLength: cleanedSystemPrompt!.length,
                agent: context.agent.name
            });
        }

        logger.info("Running claude_code tool", { 
            prompt: cleanedPrompt.substring(0, 100), 
            hasSystemPrompt: !!cleanedSystemPrompt,
            agent: context.agent.name 
        });

        try {
            // Get the current Claude session ID from the conversation's agent state
            const conversation = context.conversationManager.getConversation(context.conversationId);
            const agentState = conversation?.agentStates.get(context.agent.slug);
            const existingSessionId = agentState?.claudeSessionId;

            if (existingSessionId) {
                logger.info(`[claude_code] Resuming Claude session: ${existingSessionId}`);
            }

            // Create instances for Claude Code execution
            const ndk = getNDK();
            const taskPublisher = new TaskPublisher(ndk, context.agent);
            const orchestrator = new ClaudeTaskOrchestrator(taskPublisher);

            // Create abort controller for this execution
            const abortController = new AbortController();

            // Execute Claude Code through the orchestrator with cleaned prompts
            const result = await orchestrator.execute({
                prompt: cleanedPrompt,
                systemPrompt: cleanedSystemPrompt,
                projectPath: context.projectPath,
                title: title || `Claude Code Execution (via ${context.agent.name})`,
                branch,
                conversationRootEventId: context.conversationId,
                conversation,
                conversationManager: context.conversationManager,
                abortSignal: abortController.signal,
                resumeSessionId: existingSessionId,
                agentName: context.agent.name,
            });

            if (!result.success) {
                return failure({
                    kind: "execution" as const,
                    tool: "claude_code",
                    message: `Claude code execution failed: ${result.error || "Unknown error"}`,
                });
            }

            // Update the Claude session ID in the conversation's agent state
            if (result.sessionId) {
                await context.conversationManager.updateAgentState(
                    context.conversationId,
                    context.agent.slug,
                    { claudeSessionId: result.sessionId }
                );
                logger.info(`[claude_code] Stored Claude session ID for agent ${context.agent.slug}: ${result.sessionId}`);
            }

            // Return the result
            const response = result.finalResponse || result.task.content || "Task completed successfully";
            
            logger.info("Claude Code execution completed successfully", {
                sessionId: result.sessionId,
                cost: result.totalCost,
                messageCount: result.messageCount,
                duration: result.duration,
            });

            return success({
                sessionId: result.sessionId,
                totalCost: result.totalCost,
                messageCount: result.messageCount,
                duration: result.duration,
                response,
            });
        } catch (error) {
            logger.error("Claude Code tool failed", { error });

            return failure({
                kind: "execution" as const,
                tool: "claude_code",
                message: formatAnyError(error),
                cause: error,
            });
        }
    },
});