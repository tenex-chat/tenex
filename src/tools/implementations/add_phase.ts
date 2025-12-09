import type { ExecutionContext } from "@/agents/execution/types";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

const addPhaseSchema = z.object({
    phaseName: z.string().describe("The name of the phase to add"),
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
async function executeAddPhase(
    input: AddPhaseInput,
    context: ExecutionContext
): Promise<AddPhaseOutput> {
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
        storedAgent.phases = agent.phases;

        // Save back to global storage
        await agentStorage.saveAgent(storedAgent);

        logger.info(`Added phase '${phaseName}' to agent ${agent.name}`, {
            agent: agent.slug,
            phaseName,
            totalPhases: Object.keys(agent.phases).length,
        });

        return {
            success: true,
            message: `Successfully added phase '${phaseName}' to agent ${agent.name}`,
            totalPhases: Object.keys(agent.phases).length,
        };
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
            "Add a new phase definition to your agent configuration. This allows you to define new phases that you can use when delegating tasks. Each phase has a name and detailed instructions for what should be accomplished. Once defined, use the 'phase' parameter in the delegate tool to switch to this phase.",
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
        configurable: true,
    });

    return aiTool as AISdkTool;
}
