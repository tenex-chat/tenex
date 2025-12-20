import type { ExecutionContext } from "@/agents/execution/types";
import { getProjectContext } from "@/services/projects";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";
const agentsListSchema = z.object({
    verbose: z
        .boolean()
        .nullable()
        .describe("Whether to include full instructions and details (default: false)"),
});

type AgentsListInput = z.infer<typeof agentsListSchema>;

type AgentInfo = {
    slug: string;
    name: string;
    role: string;
    description?: string;
    instructions?: string;
    useCriteria?: string;
    tools?: string[];
    phases?: Record<string, string>;
    eventId?: string;
    pubkey: string;
};

type AgentsListOutput = {
    success: boolean;
    message?: string;
    error?: string;
    agents: AgentInfo[];
    summary?: {
        total: number;
    };
};

/**
 * Core implementation of the agents_list functionality
 */
async function executeAgentsList(input: AgentsListInput): Promise<AgentsListOutput> {
    const { verbose = false } = input;

    // Get agents from project context
    const projectCtx = getProjectContext();
    const agentInstances = projectCtx.agentRegistry.getAllAgents();

    const agents: AgentInfo[] = agentInstances.map((agent) => ({
        slug: agent.slug,
        name: agent.name,
        role: agent.role,
        description: agent.description,
        instructions: verbose ? agent.instructions : undefined,
        useCriteria: agent.useCriteria,
        tools: agent.tools,
        phases: agent.phases,
        eventId: agent.eventId,
        pubkey: agent.pubkey,
    }));

    // Sort agents by name
    agents.sort((a, b) => a.name.localeCompare(b.name));

    logger.info(`Listed ${agents.length} agents`);

    return {
        success: true,
        message: `Found ${agents.length} agents`,
        agents,
        summary: {
            total: agents.length,
        },
    };
}

/**
 * Create an AI SDK tool for listing agents
 * This is the primary implementation
 */
export function createAgentsListTool(_context: ExecutionContext): AISdkTool {
    return tool({
        description:
            "List all available agents in the project, including their system prompts and configurations",
        inputSchema: agentsListSchema,
        execute: async (input: AgentsListInput) => {
            try {
                return await executeAgentsList(input);
            } catch (error) {
                logger.error("Failed to list agents", { error });
                throw new Error(
                    `Failed to list agents: ${error instanceof Error ? error.message : String(error)}`
                );
            }
        },
    }) as AISdkTool;
}
