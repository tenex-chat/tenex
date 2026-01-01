import type { ExecutionContext } from "@/agents/execution/types";
import { RALRegistry } from "@/services/ral";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

const ralAbortSchema = z.object({
  ral_number: z
    .number()
    .describe("The RAL number to abort (from the concurrent execution context)"),
});

type RalAbortInput = z.infer<typeof ralAbortSchema>;

interface RalAbortOutput {
  success: boolean;
  message: string;
}

async function executeRalAbort(
  input: RalAbortInput,
  context: ExecutionContext
): Promise<RalAbortOutput> {
  const { ral_number } = input;

  const registry = RALRegistry.getInstance();

  const result = registry.abortRAL(
    context.agent.pubkey,
    context.conversationId,
    ral_number
  );

  if (result.success) {
    logger.info("[ral_abort] Aborted RAL", {
      agent: context.agent.slug,
      targetRalNumber: ral_number,
    });

    // Mark the RAL as complete in ConversationStore so its messages become visible
    const conversationStore = context.getConversation();
    if (conversationStore) {
      conversationStore.completeRal(context.agent.pubkey, ral_number);

      // Inject system message about the abort
      conversationStore.addMessage({
        pubkey: context.agent.pubkey,
        ral: ral_number,
        content: `⚠️ RAL #${ral_number} was aborted. Work may be incomplete.`,
        messageType: "text",
      });

      await conversationStore.save();
    }

    return {
      success: true,
      message: `RAL #${ral_number} has been aborted. Any in-progress work has been cancelled.`,
    };
  } else {
    logger.warn("[ral_abort] Failed to abort RAL", {
      agent: context.agent.slug,
      targetRalNumber: ral_number,
      reason: result.reason,
    });

    return {
      success: false,
      message: result.reason || `Failed to abort RAL #${ral_number}.`,
    };
  }
}

export function createRalAbortTool(context: ExecutionContext): AISdkTool {
  const aiTool = tool({
    description:
      "Abort another active RAL (Request-Action-Loop) execution. " +
      "This will immediately stop that RAL and cancel any in-progress tool execution. " +
      "IMPORTANT: This only works if the RAL has no pending delegations. " +
      "If it has pending delegations, use delegate_followup to communicate with those agents first.",
    inputSchema: ralAbortSchema,
    execute: async (input: RalAbortInput) => {
      return await executeRalAbort(input, context);
    },
  });

  Object.defineProperty(aiTool, "getHumanReadableContent", {
    value: (args: RalAbortInput) => `Aborting RAL #${args.ral_number}`,
    enumerable: false,
    configurable: true,
  });

  return aiTool as AISdkTool;
}
