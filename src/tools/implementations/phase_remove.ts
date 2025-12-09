import type { ExecutionContext } from "@/agents/execution/types";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

const removePhaseSchema = z.object({
    phaseName: z.string().describe("The name of the phase to remove"),
});

type RemovePhaseInput = z.infer<typeof removePhaseSchema>;

interface RemovePhaseOutput {
    success: boolean;
    message: string;
    remainingPhases?: number;
}

// Core implementation
async function executeRemovePhase(
    input: RemovePhaseInput,
    context: ExecutionContext
): Promise<RemovePhaseOutput> {
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
            storedAgent.phases = undefined;
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
            "Remove a phase definition from your agent configuration. Use this to delete phases that are no longer needed.",
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
        configurable: true,
    });

    return aiTool as AISdkTool;
}
