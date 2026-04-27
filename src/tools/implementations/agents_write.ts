import { agentStorage, deriveAgentPubkeyFromNsec } from "@/agents/AgentStorage";
import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { createLocalAgent } from "@/services/agents/AgentProvisioningService";

import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";
// Define the input schema
const agentsWriteSchema = z.object({
    slug: z.string().describe("The slug identifier for the agent"),
    name: z.string().describe("Display name of the agent"),
    role: z.string().describe("Primary role/function of the agent"),
    instructions: z.string().describe("System instructions that guide agent behavior"),
    useCriteria: z.string().describe("Criteria for when this agent should be selected"),
    llmConfig: z.string().nullable().describe("LLM configuration identifier"),
});

type AgentsWriteInput = z.infer<typeof agentsWriteSchema>;

// Define the output type
interface AgentsWriteOutput {
    success: boolean;
    error?: string;
    agent?: {
        slug: string;
        name: string;
        pubkey: string;
    };
}

/**
 * Core implementation of the agents_write functionality
 * Shared between AI SDK and legacy Tool interfaces
 */
async function executeAgentsWrite(
    input: AgentsWriteInput,
    context?: ToolExecutionContext
): Promise<AgentsWriteOutput> {
    const { slug, name, role, instructions, useCriteria, llmConfig } = input;

    if (!slug) {
        return {
            success: false,
            error: "Agent slug is required",
        };
    }

    if (!name || !role) {
        return {
            success: false,
            error: `Agent ${name ? "role" : "name"} is required`,
        };
    }

    // Get project context from tool execution context (not ALS)
    // This ensures correct project association during cross-project delegation
    if (!context?.projectContext) {
        throw new Error("ToolExecutionContext with projectContext is required for agents_write tool");
    }
    const projectContext = context.projectContext;

    // Check if agent exists by slug
    const existingAgent = await agentStorage.getAgentBySlug(slug);

    if (existingAgent) {
        logger.info(`Updating existing agent: ${slug}`);
        const existingPubkey = deriveAgentPubkeyFromNsec(existingAgent.nsec);

        // Update fields
        existingAgent.name = name;
        existingAgent.role = role;
        existingAgent.instructions = instructions;
        existingAgent.useCriteria = useCriteria;
        if (llmConfig !== undefined) {
            if (!existingAgent.default) existingAgent.default = {};
            existingAgent.default.model = llmConfig ?? undefined;
        }

        // Save to storage
        await agentStorage.saveAgent(existingAgent);

        // Reload the current project only if this agent is actually assigned there.
        if (projectContext.getAgentByPubkey(existingPubkey)) {
            await projectContext.updateProjectData(projectContext.project);
        }

        logger.info(`Successfully updated agent "${name}" (${slug})`);
        logger.info(`  Pubkey: ${existingPubkey}`);

        return {
            success: true,
            agent: {
                slug,
                name,
                pubkey: existingPubkey,
            },
        };
    }
    logger.info(`Creating new agent identity: ${slug}`);

    const result = await createLocalAgent({
        slug,
        name,
        role,
        instructions,
        useCriteria,
        llmConfig,
    });

    logger.info(`Successfully created agent "${name}" (${slug})`);
    logger.info(`  Pubkey: ${result.pubkey}`);

    return {
        success: true,
        agent: {
            slug,
            name,
            pubkey: result.pubkey,
        },
    };
}

/**
 * Create an AI SDK tool for writing agents
 * This is the primary implementation
 */
export function createAgentsWriteTool(context: ToolExecutionContext): AISdkTool {
    return tool({
        description:
            "Write or update agent configuration. Creates or updates backend-local agent identities. Core tools are automatically injected (lessons, todos, conversation tools, kill). Delegation tools (ask, delegate, delegate_crossproject, delegate_followup) are assigned based on agent category — worker agents receive ask and delegate_followup, while domain-expert agents receive only ask. Newly created agents are installed in the backend, but they are not assigned to the current project until the user publishes a 31933 event that p-tags the agent pubkey.",
        inputSchema: agentsWriteSchema,
        execute: async (input: AgentsWriteInput) => {
            try {
                return await executeAgentsWrite(input, context);
            } catch (error) {
                logger.error("Failed to write agent definition", { error });
                throw new Error(
                    `Failed to write agent definition: ${error instanceof Error ? error.message : String(error)}`,
                    { cause: error }
                );
            }
        },
    }) as AISdkTool;
}
