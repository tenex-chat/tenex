import { tool } from "ai";
import { z } from "zod";
import { LLMService } from "@/llm/service";
import { LLMLogger } from "@/logging/LLMLogger";
import { formatAnyError } from "@/utils/error-formatter";
import { logger } from "@/utils/logger";
import type { ExecutionContext } from "@/agents/execution/types";
import { startExecutionTime, stopExecutionTime } from "@/conversations/executionTime";
import { llmOpsRegistry } from "@/services/LLMOperationsRegistry";
import type { ModelMessage } from "ai";
import { llmServiceFactory } from "@/llm/LLMServiceFactory";

const geminiCliSchema = z.object({
  prompt: z.string().min(1).describe("The prompt for Gemini CLI to execute"),
  title: z.string().describe("Title for the task"),
});

type GeminiCliInput = z.infer<typeof geminiCliSchema>;
type GeminiCliOutput = {
  totalCost: number;
  messageCount: number;
  duration: number;
  response: string;
};

async function executeGeminiCli(
  input: GeminiCliInput,
  context: ExecutionContext
): Promise<GeminiCliOutput> {
  const { prompt, title } = input;
  const startTime = Date.now();

  logger.debug("[gemini_cli] Starting execution with LLMService", {
    prompt: prompt.substring(0, 100),
    agent: context.agent.name,
  });

  try {
    const conversation = context.getConversation();

    const abortSignal = llmOpsRegistry.registerOperation(context);

    if (conversation) {
      startExecutionTime(conversation);
    }

    let lastAssistantMessage = "";
    const totalCost = 0;
    let messageCount = 0;

    const llmLogger = new LLMLogger();

    const llmService = llmServiceFactory.createService(llmLogger, {
      provider: "gemini-cli",
      model: "gemini-2.5-pro",
    });

    llmService.on("content", async ({ delta }) => {
      logger.info("[gemini_cli] content", { delta });
      lastAssistantMessage += delta;
      messageCount++;
    });

    llmService.on("complete", ({ message, steps, usage }) => {
      logger.info("[gemini_cli] 🏁 STREAM COMPLETE EVENT:", {
        stepCount: steps?.length || 0,
        hasSteps: !!steps,
      });
    });

    const messages: ModelMessage[] = [];
    messages.push({
      role: "user",
      content: prompt
    });

    try {
      await llmService.stream(messages, {}, {
        abortSignal
      });

      if (conversation) {
        stopExecutionTime(conversation);
      }
    } finally {
      llmOpsRegistry.completeOperation(context);
    }

    try {
      const finalResponse = lastAssistantMessage || "Task completed successfully";
      const duration = Date.now() - startTime;

      logger.info("[gemini_cli] Execution completed", {
        totalCost,
        messageCount,
        finalResponse,
        duration,
      });

      return {
        totalCost,
        messageCount,
        duration,
        response: finalResponse,
      };

    } catch (streamError) {
      if (conversation) {
        stopExecutionTime(conversation);
      }

      const errorMessage = formatAnyError(streamError);
      const isAborted = errorMessage.includes("aborted") || errorMessage.includes("interrupted");

      logger.error("[gemini_cli] Stream execution failed", { 
        error: errorMessage, 
        isAborted 
      });

      throw new Error(`Gemini CLI execution failed: ${errorMessage}`);
    }

  } catch (error) {
    logger.error("[gemini_cli] Tool failed", { error });
    throw new Error(`Gemini CLI execution failed: ${formatAnyError(error)}`);
  }
}

export function createGeminiCliTool(context: ExecutionContext): ReturnType<typeof tool> {
  return tool({
    description: "Execute Gemini CLI to perform tasks.",
    inputSchema: geminiCliSchema,
    execute: async (input: GeminiCliInput) => {
      try {
        return await executeGeminiCli(input, context);
      } catch (error) {
        logger.error("[gemini_cli] Tool execution failed", { error });
        throw new Error(`Gemini CLI failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });
}