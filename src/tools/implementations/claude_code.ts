import { tool } from 'ai';
import { claudeCode } from 'ai-sdk-provider-claude-code';
import { createProviderRegistry } from 'ai';
import chalk from "chalk";
import { LLMService } from '@/llm/service';
import { LLMLogger } from '@/logging/LLMLogger';
import type { Phase } from "@/conversations/types";
import { formatAnyError } from "@/utils/error-formatter";
import { logger } from "@/utils/logger";
import type { ExecutionContext } from "@/agents/execution/types";
import { z } from "zod";
import type { EventContext } from "@/nostr/AgentEventEncoder";
import { startExecutionTime, stopExecutionTime } from "@/conversations/executionTime";
import type { NDKTask } from "@nostr-dev-kit/ndk";
import { llmOpsRegistry } from '@/services/LLMOperationsRegistry';

export enum ClaudeCodeMode {
  WRITE = "WRITE",
  PLAN = "PLAN",
  READ = "READ"
}

const claudeCodeSchema = z.object({
  prompt: z.string().min(1).describe("The prompt for Claude Code to execute"),
  systemPrompt: z
    .string()
    .nullable()
    .describe("Optional system prompt to provide additional context or constraints"),
  title: z.string().describe("Title for the task"),
  branch: z.string().nullable().describe("Optional branch name for the task"),
  mode: z.enum([ClaudeCodeMode.WRITE, ClaudeCodeMode.PLAN, ClaudeCodeMode.READ]).describe("Execution mode: WRITE for making changes, PLAN for planning tasks, READ for research/analysis only"),
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
 * AI SDK-based implementation using LLMService
 * Leverages existing streaming infrastructure instead of reimplementing
 */
async function executeClaudeCode(
  input: ClaudeCodeInput,
  context: ExecutionContext
): Promise<ClaudeCodeOutput> {
  const { prompt, systemPrompt, title, branch, mode } = input;
  const startTime = Date.now();

  logger.debug("[claude_code] Starting execution with LLMService", {
    prompt: prompt.substring(0, 100),
    hasSystemPrompt: !!systemPrompt,
    mode,
    agent: context.agent.name,
  });

  try {
    // Look up existing session
    const conversation = context.conversationCoordinator.getConversation(context.conversationId);
    const agentState = conversation?.agentStates.get(context.agent.slug);
    const existingSessionId = agentState?.claudeSessionsByPhase?.[context.phase];

    if (existingSessionId) {
      logger.info(`[claude_code] Found existing session`, {
        sessionId: existingSessionId,
        agent: context.agent.slug,
        conversationId: context.conversationId.substring(0, 8),
      });
    }

    // Create event context for Nostr publishing
    const rootEvent = conversation?.history[0] ?? context.triggeringEvent;
    const baseEventContext: EventContext = {
      triggeringEvent: context.triggeringEvent,
      rootEvent: rootEvent,
      conversationId: context.conversationId,
    };

    // Create task through AgentPublisher
    const task = await context.agentPublisher.createTask(
      title,
      prompt,
      baseEventContext,
      existingSessionId, // Only pass if we have a real session ID
      branch
    );

    logger.info("[claude_code] Created task", {
      taskId: task.id,
      sessionId: existingSessionId,
      title,
    });

    // Register operation with LLM Operations Registry
    const abortSignal = llmOpsRegistry.registerOperation(context);

    // Start execution timing
    if (conversation) {
      startExecutionTime(conversation);
    }

    // Track execution state
    let lastAssistantMessage = "";
    let planResult: string | null = null;
    let totalCost = 0;
    let messageCount = 0;
    let capturedSessionId: string | undefined;

    // Determine which tools to allow based on mode
    let allowedTools: string[] | undefined;
    let disallowedTools: string[] | undefined;
    
    switch (mode) {
      case ClaudeCodeMode.READ:
        // Read-only mode - no write operations allowed
        disallowedTools = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Delete'];
        break;
      case ClaudeCodeMode.PLAN:
        // Planning mode - focus on reading and todo management
        allowedTools = ['Read', 'LS', 'Grep', 'Glob', 'TodoWrite', 'ExitPlanMode'];
        break;
      case ClaudeCodeMode.WRITE:
        // Write mode - full access to all tools (default behavior)
        // Don't restrict any tools
        break;
    }

    // Create provider registry with Claude Code
    const registry = createProviderRegistry({
      'claude-code': {
        languageModel: (modelId: string) => {
          const options: any = {
            cwd: context.projectPath,
            permissionMode: 'bypassPermissions',
            // Resume existing session if we have one
            resume: existingSessionId,
          };
          
          // Add tool restrictions based on mode
          if (allowedTools) {
            options.allowedTools = allowedTools;
          } else if (disallowedTools) {
            options.disallowedTools = disallowedTools;
          }
          
          return claudeCode(modelId, options);
        }
      }
    });

    // Create LLMLogger instance
    const llmLogger = new LLMLogger();

    // Create LLMService with Claude Code provider
    const llmService = new LLMService(
      llmLogger,
      registry,
      'claude-code',
      'opus',
      undefined, // temperature
      undefined  // maxTokens
    );

    // Set up event handlers for Nostr publishing
    llmService.on('content', async ({ delta }) => {
      lastAssistantMessage += delta;
      messageCount++;
      
      // Publish text update to Nostr
      await context.agentPublisher.publishTaskUpdate(
        task,
        delta,
        baseEventContext
      );
    });

    llmService.on('tool-did-execute', async ({ toolName, result }: any) => {
      console.log("ai sdk cc tool-did-execute", chalk.green(toolName));
      logger.debug("[claude_code] Tool executed", { toolName, result });
      
      if (toolName === 'TodoWrite' && result?.todos) {
        const todos = result.todos as Array<{
          content: string;
          status: "pending" | "in_progress" | "completed";
          activeForm?: string;
        }>;
        
        const todoLines = todos.map(todo => {
          let checkbox = "- [ ]";
          if (todo.status === "in_progress") {
            checkbox = "- ➡️";
          } else if (todo.status === "completed") {
            checkbox = "- ✅";
          }
          const text = todo.status === "in_progress" && todo.activeForm ? todo.activeForm : todo.content;
          return `${checkbox} ${text}`;
        });
        
        await context.agentPublisher.publishTaskUpdate(
          task,
          todoLines.join("\n"),
          baseEventContext
        );
      } else if (toolName === 'ExitPlanMode' && mode === ClaudeCodeMode.PLAN) {
        // Capture plan result and abort
        planResult = result?.plan || "Plan completed";
        logger.info("[claude_code] ExitPlanMode detected", {
          plan: planResult.substring(0, 100),
        });
        await context.agentPublisher.publishTaskUpdate(task, "Plan complete", baseEventContext, "complete");
        // Abort the stream since we have the plan
        // Note: We can't directly abort from here, but the stream will complete naturally
        logger.info("[claude_code] Plan completed, stream will finish", {
        });
      }
    });

    llmService.on('complete', ({ message, steps, text, usage }: any) => {
      console.log("ai sdk cc complete", chalk.blue(text), chalk.green(message));
      // Try to extract session ID from the last step's provider metadata
      const lastStep = steps[steps.length - 1];
      if (lastStep?.providerMetadata?.['claude-code']?.sessionId) {
        capturedSessionId = lastStep.providerMetadata['claude-code'].sessionId;
        logger.info("[claude_code] Captured session ID from provider metadata", {
          sessionId: capturedSessionId,
        });
      }
      
      logger.info("[claude_code] Stream completed", {
        messageLength: message.length,
        stepCount: steps.length,
        taskId: task.id,
        capturedSessionId,
        usage
      });

      context.agentPublisher.publishTaskUpdate(task, "Task complete", baseEventContext, "complete");
    });

    // Build messages
    const messages: any[] = [];
    if (systemPrompt) {
      messages.push({
        role: 'system',
        content: systemPrompt
      });
    }
    messages.push({
      role: 'user',
      content: prompt
    });

    try {
      // Execute stream with LLMService, passing abort signal from registry
      // Claude Code provider handles its own tools internally based on mode
      await llmService.stream(messages, {}, {
        abortSignal
      });

      // Stop execution timing
      if (conversation) {
        stopExecutionTime(conversation);
      }
    } finally {
      // Complete the operation (handles both success and abort cases)
      llmOpsRegistry.completeOperation(context);
    }

    try {

      // Only use real session IDs from Claude Code provider
      const sessionId = capturedSessionId || existingSessionId;

      // Store session ID for future resumption
      if (sessionId && conversation) {
        const agentState = conversation.agentStates.get(context.agent.slug) || {
          lastProcessedMessageIndex: 0,
        };

        if (!agentState.claudeSessionsByPhase) {
          agentState.claudeSessionsByPhase = {} as Record<Phase, string>;
        }

        agentState.claudeSessionsByPhase[context.phase] = sessionId;

        await context.conversationCoordinator.updateAgentState(
          context.conversationId,
          context.agent.slug,
          agentState
        );

        logger.info(`[claude_code] Stored session ID for phase ${context.phase}`, {
          sessionId,
          agent: context.agent.slug,
          conversationId: context.conversationId.substring(0, 8),
        });
      }

      // Return appropriate response
      const finalResponse = planResult || lastAssistantMessage || "Task completed successfully";
      const duration = Date.now() - startTime;

      logger.info("[claude_code] Execution completed", {
        sessionId,
        totalCost,
        messageCount,
        duration,
        mode,
        hasPlanResult: !!planResult,
      });

      return {
        sessionId,
        totalCost,
        messageCount,
        duration,
        response: finalResponse,
      };

    } catch (streamError) {
      // Stop timing on error
      if (conversation) {
        stopExecutionTime(conversation);
      }

      const errorMessage = formatAnyError(streamError);
      const isAborted = errorMessage.includes("aborted") || errorMessage.includes("interrupted");

      // Publish error update
      await context.agentPublisher.publishTaskUpdate(
        task,
        `❌ Task ${isAborted ? 'interrupted' : 'failed'}\n\nError: ${errorMessage}`,
        baseEventContext
      );

      logger.error("[claude_code] Stream execution failed", { 
        error: errorMessage, 
        isAborted 
      });

      throw new Error(`Claude Code execution failed: ${errorMessage}`);
    }

  } catch (error) {
    logger.error("[claude_code] Tool failed", { error });
    throw new Error(`Claude Code execution failed: ${formatAnyError(error)}`);
  }
}

/**
 * Create an AI SDK tool for Claude Code execution using LLMService
 */
export function createClaudeCodeTool(context: ExecutionContext): ReturnType<typeof tool> {
  return tool({
    description: "Execute Claude Code to perform planning or to execute changes. Claude Code has full access to read, write, and execute code in the project. This tool maintains session continuity for iterative development. Usage warning: claude_code is a powerful, intelligent tool; don't micromanage its work, don't try to direct how it should implement things unless explicitly asked to do so. Rely on claude_code's intelligence and only provide corrections where necessary.",
    inputSchema: claudeCodeSchema,
    execute: async (input: ClaudeCodeInput) => {
      try {
        return await executeClaudeCode(input, context);
      } catch (error) {
        logger.error("[claude_code] Tool execution failed", { error });
        throw new Error(`Claude Code failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });
}