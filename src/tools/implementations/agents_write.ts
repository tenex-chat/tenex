import { tool } from "ai";
import { getProjectContext } from "@/services/ProjectContext";
import { logger } from "@/utils/logger";
import { z } from "zod";
import { agentStorage } from "@/agents/AgentStorage";
// Define the input schema
const agentsWriteSchema = z.object({
  slug: z.string().describe("The slug identifier for the agent"),
  name: z.string().describe("Display name of the agent"),
  role: z.string().describe("Primary role/function of the agent"),
  description: z.string().nullable().optional().describe("Agent description"),
  instructions: z.string().nullable().optional().describe("System instructions that guide agent behavior"),
  useCriteria: z.string().nullable().optional().describe("Criteria for when this agent should be selected"),
  llmConfig: z.string().nullable().optional().describe("LLM configuration identifier"),
  tools: z.array(z.string()).nullable().optional().describe("List of tool names available to this agent. All agents automatically get core tools: lesson_get, lesson_learn, read_path, reports_list, report_read. Delegation tools (delegate, delegate_phase, delegate_external, delegate_followup) and phase management tools (phase_add, phase_remove) are automatically assigned based on whether the agent has phases defined - do not include them. Additional tools can include: agents_write, agents_read, agents_list, agents_discover, agents_hire, analyze, shell, claude_code, nostr_projects, discover_capabilities, report_write, report_delete. MCP tools use format: mcp__servername__toolname"),
  phases: z.record(z.string(), z.string()).optional().nullable().describe("Phase definitions for this agent - maps phase names to their instructions. When phases are defined, the agent gets delegate_phase tool instead of delegate tool."),
});

type AgentsWriteInput = z.infer<typeof agentsWriteSchema>;

// Define the output type
interface AgentsWriteOutput {
  success: boolean;
  message?: string;
  error?: string;
  filePath?: string;
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
  input: AgentsWriteInput
): Promise<AgentsWriteOutput> {
  const { slug, name, role, description, instructions, useCriteria, llmConfig, tools, phases } = input;

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

  // Get project context
  const projectContext = getProjectContext();
  const projectPath = process.cwd();

  // Check if agent exists by slug
  const existingAgent = await agentStorage.getAgentBySlug(slug);

  if (existingAgent) {
    logger.info(`Updating existing agent: ${slug}`);

    // Update fields
    existingAgent.name = name;
    existingAgent.role = role;
    if (description !== undefined) existingAgent.description = description;
    if (instructions !== undefined) existingAgent.instructions = instructions;
    if (useCriteria !== undefined) existingAgent.useCriteria = useCriteria;
    if (llmConfig !== undefined) existingAgent.llmConfig = llmConfig;
    if (tools !== undefined) existingAgent.tools = tools;
    if (phases !== undefined) existingAgent.phases = phases;

    // Save to storage
    await agentStorage.saveAgent(existingAgent);

    // Reload project context to pick up changes
    await projectContext.updateProjectData(projectContext.project);

    const agent = projectContext.getAgent(slug);
    if (!agent) {
      return {
        success: false,
        error: `Agent ${slug} updated in storage but not found in project context`,
      };
    }

    logger.info(`Successfully updated agent "${name}" (${slug})`);
    logger.info(`  Pubkey: ${agent.pubkey}`);

    return {
      success: true,
      message: `Successfully updated agent "${name}"`,
      agent: {
        slug,
        name,
        pubkey: agent.pubkey,
      },
    };
  } else {
    logger.info(`Creating new agent: ${slug}`);

    // Create agent config
    const agentConfig = {
      name,
      role,
      description,
      instructions,
      useCriteria,
      llmConfig,
      tools,
      phases,
    };

    // Use ensureAgent to create and register the agent
    const agent = await projectContext.agentRegistry.ensureAgent(
      slug,
      agentConfig,
      projectContext.project
    );

    logger.info(`Successfully created agent "${name}" (${slug})`);
    logger.info(`  Pubkey: ${agent.pubkey}`);

    return {
      success: true,
      message: `Successfully created agent "${name}"`,
      agent: {
        slug,
        name,
        pubkey: agent.pubkey,
      },
    };
  }
}

/**
 * Create an AI SDK tool for writing agents
 * This is the primary implementation
 */
export function createAgentsWriteTool(): ReturnType<typeof tool> {
  return tool({
    description: "Write or update agent configuration and tools. Creates/updates agent definition files in .tenex/agents/. All agents automatically get core tools: lesson_get, lesson_learn, read_path, reports_list, report_read. Delegation tools (delegate, delegate_phase, delegate_external, delegate_followup) are automatically assigned based on PM status - do not include them. Assign additional tools based on responsibilities. Agent activates immediately and becomes available for delegation. Use to create specialized agents for specific tasks or update existing agent configurations. Changes persist across sessions.",
    inputSchema: agentsWriteSchema,
    execute: async (input: AgentsWriteInput) => {
      try {
        return await executeAgentsWrite(input);
      } catch (error) {
        logger.error("Failed to write agent definition", { error });
        throw new Error(`Failed to write agent definition: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });
}

