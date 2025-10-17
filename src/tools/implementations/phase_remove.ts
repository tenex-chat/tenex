import { tool } from "ai";
import type { ExecutionContext } from "@/agents/execution/types";
import type { AISdkTool } from "@/tools/registry";
import { logger } from "@/utils/logger";
import { z } from "zod";

const removePhaseSchema = z.object({
  phaseName: z
    .string()
    .describe("The name of the phase to remove"),
});

type RemovePhaseInput = z.infer<typeof removePhaseSchema>;

interface RemovePhaseOutput {
  success: boolean;
  message: string;
  remainingPhases?: number;
}

// Core implementation
async function executeRemovePhase(input: RemovePhaseInput, context: ExecutionContext): Promise<RemovePhaseOutput> {
  const { phaseName } = input;
  const agent = context.agent;

  // Check if agent has phases
  if (!agent.phases || Object.keys(agent.phases).length === 0) {
    return {
      success: false,
      message: `Agent ${agent.name} has no phases defined`,
    };
  }

  // Normalize phase name for case-insensitive matching
  const normalizedPhaseName = phaseName.toLowerCase();
  const phaseToRemove = Object.entries(agent.phases).find(
    ([name]) => name.toLowerCase() === normalizedPhaseName
  );

  if (!phaseToRemove) {
    const availablePhases = Object.keys(agent.phases).join(", ");
    return {
      success: false,
      message: `Phase '${phaseName}' not found. Available phases: ${availablePhases}`,
    };
  }

  // Remove the phase
  const [actualPhaseName] = phaseToRemove;
  delete agent.phases[actualPhaseName];

  // Persist to agent's global storage file
  try {
    const { agentStorage } = await import("@/agents/AgentStorage");
    await agentStorage.initialize();

    // Load current agent data from global storage
    const storedAgent = await agentStorage.loadAgent(agent.pubkey);
    if (!storedAgent) {
      throw new Error(`Agent ${agent.slug} not found in global storage`);
    }

    // Update phases in stored data
    if (Object.keys(agent.phases).length === 0) {
      // Remove phases property if empty
      delete storedAgent.phases;
    } else {
      storedAgent.phases = agent.phases;
    }

    // Save back to global storage
    await agentStorage.saveAgent(storedAgent);

    logger.info(`Removed phase '${actualPhaseName}' from agent ${agent.name}`, {
      agent: agent.slug,
      phaseName: actualPhaseName,
      remainingPhases: Object.keys(agent.phases).length,
    });

    // Check if agent should switch back to delegate tool
    if (Object.keys(agent.phases).length === 0) {
      const hasDelegatePhase = agent.tools.includes("delegate_phase");
      const hasDelegate = agent.tools.includes("delegate");

      if (hasDelegatePhase && !hasDelegate) {
        // Switch from delegate_phase back to delegate
        agent.tools = agent.tools.filter(t => t !== "delegate_phase");
        agent.tools.push("delegate");

        // Update stored agent tools as well
        storedAgent.tools = agent.tools;
        await agentStorage.saveAgent(storedAgent);

        logger.info(`Switched agent ${agent.name} from 'delegate_phase' back to 'delegate' tool (no phases remaining)`);
      }

      // Also remove phase management tools if no phases remain
      const hasAddPhase = agent.tools.includes("add_phase");
      const hasRemovePhase = agent.tools.includes("remove_phase");

      if (hasAddPhase || hasRemovePhase) {
        agent.tools = agent.tools.filter(t => t !== "add_phase" && t !== "remove_phase");

        // Update stored agent tools
        storedAgent.tools = agent.tools;
        await agentStorage.saveAgent(storedAgent);

        logger.info(`Removed phase management tools from agent ${agent.name} (no phases remaining)`);
      }
    }

    return {
      success: true,
      message: `Successfully removed phase '${actualPhaseName}' from agent ${agent.name}`,
      remainingPhases: Object.keys(agent.phases).length,
    };
  } catch (error) {
    logger.error("Failed to persist phase removal", { error, agent: agent.slug });
    return {
      success: false,
      message: `Failed to remove phase: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// AI SDK tool factory
export function createRemovePhaseTool(context: ExecutionContext): AISdkTool {
  const aiTool = tool({
    description:
      "Remove a phase definition from your agent configuration. Use this to delete phases that are no longer needed. If you remove all phases, you'll switch back to using the regular delegate tool instead of delegate_phase.",
    inputSchema: removePhaseSchema,
    execute: async (input: RemovePhaseInput) => {
      return await executeRemovePhase(input, context);
    },
  });

  Object.defineProperty(aiTool, "getHumanReadableContent", {
    value: ({ phaseName }: RemovePhaseInput) => {
      return `Removing phase: ${phaseName}`;
    },
    enumerable: false,
    configurable: true
  });

  return aiTool;
}