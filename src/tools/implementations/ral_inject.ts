import type { ExecutionContext } from "@/agents/execution/types";
import { RALRegistry } from "@/services/ral";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

const ralInjectSchema = z.object({
  ral_number: z
    .number()
    .describe("The RAL number to inject the message into (from the concurrent execution context)"),
  message: z
    .string()
    .describe("The message to inject. This will be seen by that RAL when it next processes messages."),
});

type RalInjectInput = z.infer<typeof ralInjectSchema>;

interface RalInjectOutput {
  success: boolean;
  message: string;
}

async function executeRalInject(
  input: RalInjectInput,
  context: ExecutionContext
): Promise<RalInjectOutput> {
  const { ral_number, message } = input;

  const registry = RALRegistry.getInstance();

  const success = registry.injectToRAL(
    context.agent.pubkey,
    context.conversationId,
    ral_number,
    message
  );

  if (success) {
    logger.info("[ral_inject] Injected message to RAL", {
      agent: context.agent.slug,
      targetRalNumber: ral_number,
      messageLength: message.length,
    });

    return {
      success: true,
      message: `Message injected to RAL #${ral_number}. It will be processed when that RAL continues.`,
    };
  } else {
    logger.warn("[ral_inject] Failed to inject - RAL not found", {
      agent: context.agent.slug,
      targetRalNumber: ral_number,
    });

    return {
      success: false,
      message: `RAL #${ral_number} not found. It may have already completed.`,
    };
  }
}

export function createRalInjectTool(context: ExecutionContext): AISdkTool {
  const aiTool = tool({
    description:
      "Inject a message into another active RAL (Request-Action-Loop) execution. " +
      "The message will be seen by that RAL when it next processes messages. " +
      "Use this to communicate updates, changes, or cancellation requests to ongoing work.",
    inputSchema: ralInjectSchema,
    execute: async (input: RalInjectInput) => {
      return await executeRalInject(input, context);
    },
  });

  Object.defineProperty(aiTool, "getHumanReadableContent", {
    value: (args: RalInjectInput) => `Injecting message to RAL #${args.ral_number}`,
    enumerable: false,
    configurable: true,
  });

  return aiTool as AISdkTool;
}
