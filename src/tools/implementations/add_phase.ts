import { tool } from "ai";
import type { ExecutionContext } from "@/agents/execution/types";
import type { AISdkTool } from "@/tools/registry";
import { logger } from "@/utils/logger";
import { z } from "zod";
import { writeJsonFile, readFile, fileExists } from "@/lib/fs";
import * as path from "node:path";

const addPhaseSchema = z.object({
  phaseName: z
    .string()
    .describe("The name of the phase to add"),
  instructions: z
    .string()
    .describe("Detailed instructions for what should be accomplished in this phase"),
});

type AddPhaseInput = z.infer<typeof addPhaseSchema>;

interface AddPhaseOutput {
  success: boolean;
  message: string;
  totalPhases?: number;
}

// Core implementation
async function executeAddPhase(input: AddPhaseInput, context: ExecutionContext): Promise<AddPhaseOutput> {
  const { phaseName, instructions } = input;
  const agent = context.agent;

  // Normalize phase name to lowercase for consistency
  const normalizedPhaseName = phaseName.toLowerCase();

  // Initialize phases if not present
  if (!agent.phases) {
    agent.phases = {};
  }

  // Check if phase already exists
  const existingPhase = Object.entries(agent.phases).find(
    ([name]) => name.toLowerCase() === normalizedPhaseName
  );

  if (existingPhase) {
    return {
      success: false,
      message: `Phase '${existingPhase[0]}' already exists. Use a different name or remove it first.`,
    };
  }

  // Add the new phase
  agent.phases[phaseName] = instructions;

  // Persist to agent's JSON file
  try {
    const projectPath = process.cwd();
    const agentsDir = path.join(projectPath, ".tenex", "agents");

    // Get the agent's file name from registry
    const registryPath = path.join(projectPath, ".tenex", "agents.json");
    if (await fileExists(registryPath)) {
      const registryContent = await readFile(registryPath);
      const registry = JSON.parse(registryContent);
      const registryEntry = registry[agent.slug];

      if (registryEntry && registryEntry.file) {
        const agentFilePath = path.join(agentsDir, registryEntry.file);

        // Read existing agent data
        const agentContent = await readFile(agentFilePath);
        const agentData = JSON.parse(agentContent);

        // Update phases
        agentData.phases = agent.phases;

        // Write back
        await writeJsonFile(agentFilePath, agentData);

        logger.info(`Added phase '${phaseName}' to agent ${agent.name}`, {
          agent: agent.slug,
          phaseName,
          totalPhases: Object.keys(agent.phases).length,
        });

        // Check if agent needs delegate_phase tool now
        const hasDelegate = agent.tools.includes("delegate");
        const hasDelegatePhase = agent.tools.includes("delegate_phase");

        if (hasDelegate && !hasDelegatePhase) {
          // Switch from delegate to delegate_phase
          agent.tools = agent.tools.filter(t => t !== "delegate");
          agent.tools.push("delegate_phase");

          logger.info(`Switched agent ${agent.name} from 'delegate' to 'delegate_phase' tool`);
        }

        return {
          success: true,
          message: `Successfully added phase '${phaseName}' to agent ${agent.name}`,
          totalPhases: Object.keys(agent.phases).length,
        };
      }
    }

    throw new Error("Could not find agent configuration file");
  } catch (error) {
    logger.error("Failed to persist phase addition", { error, agent: agent.slug });
    return {
      success: false,
      message: `Failed to save phase: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// AI SDK tool factory
export function createAddPhaseTool(context: ExecutionContext): AISdkTool {
  const aiTool = tool({
    description:
      "Add a new phase definition to your agent configuration. This allows you to define new phases that you can switch to using delegate_phase. Each phase has a name and detailed instructions for what should be accomplished.",
    inputSchema: addPhaseSchema,
    execute: async (input: AddPhaseInput) => {
      return await executeAddPhase(input, context);
    },
  });

  Object.defineProperty(aiTool, "getHumanReadableContent", {
    value: ({ phaseName }: AddPhaseInput) => {
      return `Adding phase: ${phaseName}`;
    },
    enumerable: false,
    configurable: true
  });

  return aiTool;
}