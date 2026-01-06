import type { ToolExecutionContext } from "@/tools/types";
import { getProjectContext } from "@/services/projects";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

const stopPairingSchema = z.object({
  delegation_event_id: z
    .string()
    .describe(
      "The event ID of the delegation whose pairing you want to stop"
    ),
});

type StopPairingInput = z.infer<typeof stopPairingSchema>;

interface StopPairingOutput {
  success: boolean;
  message: string;
  delegationId: string;
  eventsSeen?: number;
  checkpointCount?: number;
}

async function executeStopPairing(
  input: StopPairingInput,
  context: ToolExecutionContext
): Promise<StopPairingOutput> {
  const { delegation_event_id } = input;

  const projectContext = getProjectContext();
  const pairingManager = projectContext.pairingManager;

  if (!pairingManager) {
    throw new Error("PairingManager not available in this project context");
  }

  if (!pairingManager.hasPairing(delegation_event_id)) {
    return {
      success: false,
      message: `No active pairing found for delegation ${delegation_event_id.substring(0, 8)}...`,
      delegationId: delegation_event_id,
    };
  }

  // Get state before stopping for reporting
  const state = pairingManager.getPairingState(delegation_event_id);
  const eventsSeen = state?.totalEventsSeen ?? 0;
  const checkpointCount = state?.checkpointNumber ?? 0;

  pairingManager.stopPairing(delegation_event_id);

  logger.info("[stop_pairing] Stopped pairing", {
    agentSlug: context.agent.slug,
    delegationId: delegation_event_id.substring(0, 8),
    eventsSeen,
    checkpointCount,
  });

  return {
    success: true,
    message: `Stopped real-time supervision for delegation ${delegation_event_id.substring(0, 8)}... You will no longer receive checkpoints for this delegation.`,
    delegationId: delegation_event_id,
    eventsSeen,
    checkpointCount,
  };
}

export function createStopPairingTool(context: ToolExecutionContext): AISdkTool {
  const aiTool = tool({
    description:
      "Stop real-time pairing supervision for a delegation. Use when you no longer need checkpoint updates and want to let the delegated agent work autonomously until completion.",
    inputSchema: stopPairingSchema,
    execute: async (input: StopPairingInput) => {
      return await executeStopPairing(input, context);
    },
  });

  Object.defineProperty(aiTool, "getHumanReadableContent", {
    value: () => "Stopping pairing supervision",
    enumerable: false,
    configurable: true,
  });

  return aiTool as AISdkTool;
}
