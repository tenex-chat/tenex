import type { ExecutionContext } from "@/agents/execution/types";
import type { AISdkTool } from "@/tools/types";
import { getProjectContext } from "@/services/ProjectContext";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";
// Define the input schema
const agentsReadSchema = z.object({
    slug: z.string().describe("The slug identifier of the agent to read"),
});

type AgentsReadInput = z.infer<typeof agentsReadSchema>;

// Define the output type
interface AgentsReadOutput {
    success: boolean;
    message?: string;
    error?: string;
    agent?: {
        slug: string;
        name: string;
        role: string;
        description?: string;
        instructions?: string;
        useCriteria?: string;
        llmConfig?: string;
        tools?: string[];
        phases?: Record<string, string>;
        eventId?: string;
        pubkey: string;
    };
}

/**
 * Tool: agents_read
 * Read a local agent definition from JSON file
 */
/**
 * Core implementation of reading agents
 * Shared between AI SDK and legacy Tool interfaces
 */
async function executeAgentsRead(
    input: AgentsReadInput,
    _context: ExecutionContext
): Promise<AgentsReadOutput> {
    const { slug } = input;

    if (!slug) {
        throw new Error("Agent slug is required");
    }

    // Get agent from project context
    const projectCtx = getProjectContext();
    const agent = projectCtx.getAgent(slug);

    if (!agent) {
        throw new Error(`Agent with slug "${slug}" not found in current project`);
    }

    logger.info(`Successfully read agent definition for "${agent.name}" (${slug})`);
    logger.info(`  Pubkey: ${agent.pubkey}`);

    return {
        success: true,
        message: `Successfully read agent definition for "${agent.name}"`,
        agent: {
            slug: agent.slug,
            name: agent.name,
            role: agent.role,
            description: agent.description,
            instructions: agent.instructions,
            useCriteria: agent.useCriteria,
            llmConfig: agent.llmConfig,
            tools: agent.tools,
            phases: agent.phases,
            eventId: agent.eventId,
            pubkey: agent.pubkey,
        },
    };
}

/**
 * Create an AI SDK tool for reading agents
 * This is the primary implementation
 */
export function createAgentsReadTool(context: ExecutionContext): AISdkTool {
    return tool({
        description: "Read a local agent definition from its JSON file",
        inputSchema: agentsReadSchema,
        execute: async (input: AgentsReadInput) => {
            try {
                return await executeAgentsRead(input, context);
            } catch (error) {
                logger.error("Failed to read agent definition", { error });
                throw new Error(
                    `Failed to read agent definition: ${error instanceof Error ? error.message : String(error)}`
                );
            }
        },
    }) as AISdkTool;
} 
