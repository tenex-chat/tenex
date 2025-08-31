import { tool } from 'ai';
import { ClaudeTaskExecutor } from "@/claude/task-executor";
import type { Phase } from "@/conversations/phases";
import { formatAnyError } from "@/utils/error-formatter";
import { logger } from "@/utils/logger";
import { randomUUID } from "crypto";
import type { ExecutionContext } from "@/agents/execution/types";
import { z } from "zod";

/**
 * Strips thinking blocks from content.
 * Removes everything between <thinking> and </thinking> tags.
 */
function stripThinkingBlocks(content: string): string {
  return content.replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim();
}

const claudeCodeSchema = z.object({
  prompt: z.string().min(1).describe("The prompt for Claude Code to execute"),
  systemPrompt: z
    .string()
    .optional()
    .describe("Optional system prompt to provide additional context or constraints"),
  title: z.string().describe("Title for the task"),
  branch: z.string().optional().describe("Optional branch name for the task"),
});

type ClaudeCodeInput = z.infer<typeof claudeCodeSchema>;
type ClaudeCodeOutput = {
  sessionId?: string;
  totalCost: number;
  messageCount: number;
  duration: number;
  response: string;
};

/**
 * Core implementation of the claude_code functionality
 * Shared between AI SDK and legacy Tool interfaces
 */
async function executeClaudeCode(
  input: ClaudeCodeInput,
  context: ExecutionContext
): Promise<ClaudeCodeOutput> {
  const { prompt, systemPrompt, title, branch } = input;

    // Strip thinking blocks from prompts
    const cleanedPrompt = stripThinkingBlocks(prompt);
    const cleanedSystemPrompt = systemPrompt ? stripThinkingBlocks(systemPrompt) : undefined;

    logger.debug("Running claude_code tool", {
      prompt: cleanedPrompt.substring(0, 100),
      hasSystemPrompt: !!cleanedSystemPrompt,
      agent: context.agent.name,
    });

    try {
      // Always use the current conversation for session management
      // The conversation ID is already the root - delegations work within the same conversation
      logger.debug(`[claude_code] Starting session lookup`, {
        conversationId: context.conversationId,
        conversationIdShort: context.conversationId.substring(0, 8),
        agent: context.agent.slug,
        phase: context.phase,
        triggeringEventKind: context.triggeringEvent.kind,
        triggeringEventId: context.triggeringEvent.id?.substring(0, 8),
      });

      const conversation = context.conversationCoordinator.getConversation(context.conversationId);
      
      logger.debug(`[claude_code] Conversation lookup result`, {
        conversationFound: !!conversation,
        conversationId: conversation?.id?.substring(0, 8),
        agentStatesCount: conversation?.agentStates?.size || 0,
        agentStatesKeys: conversation ? Array.from(conversation.agentStates.keys()) : [],
      });

      const agentState = conversation?.agentStates.get(context.agent.slug);
      
      logger.debug(`[claude_code] Agent state lookup`, {
        agentStateFound: !!agentState,
        agent: context.agent.slug,
        claudeSessionsByPhase: agentState?.claudeSessionsByPhase,
        lastProcessedMessageIndex: agentState?.lastProcessedMessageIndex,
      });

      const existingSessionId = agentState?.claudeSessionsByPhase?.[context.phase];

      if (existingSessionId) {
        logger.info(`[claude_code] Resuming existing Claude session`, {
          sessionId: existingSessionId,
          agent: context.agent.slug,
          phase: context.phase,
          conversationId: context.conversationId.substring(0, 8),
        });
      } else {
        logger.debug(`[claude_code] No existing session ID, will create new session`, {
          agent: context.agent.slug,
          phase: context.phase,
          conversationId: context.conversationId.substring(0, 8),
        });
      }

      // Create instances for Claude Code execution
      // Use shared AgentPublisher instance from context (guaranteed to be present)
      const taskExecutor = new ClaudeTaskExecutor(context.agentPublisher);

      // Create abort controller for this execution
      const abortController = new AbortController();

      // Only use existing session ID for resumption, generate new one otherwise
      const isResuming = !!existingSessionId;
      const sessionId = existingSessionId || randomUUID();
      
      logger.info(`[claude_code] Session ID decision`, {
        usingExistingSession: isResuming,
        sessionId: sessionId,
        agent: context.agent.slug,
        phase: context.phase,
        conversationId: context.conversationId.substring(0, 8),
      });

      // Execute Claude Code through the task executor with cleaned prompts
      // Pass resumeSessionId only when actually resuming
      const result = await taskExecutor.execute({
        prompt: cleanedPrompt,
        systemPrompt: cleanedSystemPrompt,
        projectPath: context.projectPath,
        title,
        branch,
        conversationRootEventId: context.conversationId,
        conversation: conversation,
        conversationCoordinator: context.conversationCoordinator,
        abortSignal: abortController.signal,
        claudeSessionId: sessionId,
        resumeSessionId: isResuming ? sessionId : undefined, // Only pass for actual resumption
        agentName: context.agent.name,
        triggeringEvent: context.triggeringEvent,
        phase: context.phase,
      });

      if (!result.success) {
        throw new Error(`Claude code execution failed: ${result.error || "Unknown error"}`);
      }

      // Update the Claude session ID in the conversation's agent state for this phase
      if (result.sessionId) {
        const conversation = context.conversationCoordinator.getConversation(context.conversationId);

        if (conversation) {
          const agentState = conversation.agentStates.get(context.agent.slug) || {
            lastProcessedMessageIndex: 0,
          };

          // Initialize claudeSessionsByPhase if it doesn't exist
          if (!agentState.claudeSessionsByPhase) {
            agentState.claudeSessionsByPhase = {} as Record<Phase, string>;
          }

          // Store the session ID for this phase
          agentState.claudeSessionsByPhase[context.phase] = result.sessionId;

          await context.conversationCoordinator.updateAgentState(
            context.conversationId,
            context.agent.slug,
            agentState
          );

          logger.info(`[claude_code] Stored Claude session ID for phase ${context.phase}`, {
            sessionId: result.sessionId,
            agent: context.agent.slug,
            phase: context.phase,
            conversationId: context.conversationId.substring(0, 8),
          });
        }
      }

      // Return the result
      const response = result.finalResponse || result.taskEvent.content || "Task completed successfully";

      logger.info("Claude Code execution completed successfully", {
        sessionId: result.sessionId,
        cost: result.totalCost,
        messageCount: result.messageCount,
        duration: result.duration,
        response
      });

      return {
        sessionId: result.sessionId,
        totalCost: result.totalCost,
        messageCount: result.messageCount,
        duration: result.duration,
        response,
      };
    } catch (error) {
      logger.error("Claude Code tool failed", { error });
      throw new Error(`Claude Code execution failed: ${formatAnyError(error)}`);
    }
}

/**
 * Create an AI SDK tool for Claude Code execution
 * This is the primary implementation
 */
export function createClaudeCodeTool(context: ExecutionContext) {
  return tool({
    description: "Execute Claude Code to perform planning or to execute changes. Claude Code has full access to read, write, and execute code in the project. This tool maintains session continuity for iterative development.",
    parameters: claudeCodeSchema,
    execute: async (input: ClaudeCodeInput) => {
      try {
        return await executeClaudeCode(input, context);
      } catch (error) {
        logger.error("Claude Code tool failed", { error });
        throw new Error(`Claude Code execution failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });
}

