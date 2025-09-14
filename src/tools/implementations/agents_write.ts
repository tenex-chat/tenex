import { tool } from 'ai';
import { ensureDirectory, fileExists, readFile, writeJsonFile } from "@/lib/fs";
import { getProjectContext } from "@/services/ProjectContext";
import { logger } from "@/utils/logger";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import * as path from "node:path";
import { z } from "zod";
// Define the input schema
const agentsWriteSchema = z.object({
  slug: z.string().describe("The slug identifier for the agent"),
  name: z.string().describe("Display name of the agent"),
  role: z.string().describe("Primary role/function of the agent"),
  description: z.string().nullable().describe("Agent description"),
  instructions: z.string().nullable().describe("System instructions that guide agent behavior"),
  useCriteria: z.string().nullable().describe("Criteria for when this agent should be selected"),
  llmConfig: z.string().nullable().describe("LLM configuration identifier"),
  tools: z.array(z.string()).nullable().describe("List of tool names available to this agent. All agents automatically get core tools: lesson_get, lesson_learn, read_path, reports_list, report_read. Delegation tools (delegate, delegate_phase, delegate_external, delegate_followup) and phase management tools (add_phase, remove_phase) are automatically assigned based on whether the agent has phases defined - do not include them. Additional tools can include: agents_write, agents_read, agents_list, agents_discover, agents_hire, analyze, generate_inventory, shell, claude_code, nostr_projects, discover_capabilities, write_context_file, report_write, report_delete. MCP tools use format: mcp__servername__toolname"),
  mcp: z.boolean().nullable().describe("Whether this agent has access to MCP tools (defaults to true)"),
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
  const { slug, name, role, description, instructions, useCriteria, llmConfig, tools, mcp, phases } = input;

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

  // Get project path
  const projectPath = process.cwd();
  
  // Determine agents directory
  const agentsDir = path.join(projectPath, ".tenex", "agents");
  await ensureDirectory(agentsDir);

  // Create the agent definition file path
  const fileName = `${slug}.json`;
  const filePath = path.join(agentsDir, fileName);

  // Check if file exists and load existing data if updating
  let existingData = {};
  if (await fileExists(filePath)) {
    try {
      const content = await readFile(filePath);
      existingData = JSON.parse(content);
      logger.info(`Updating existing agent definition: ${slug}`);
    } catch (error) {
      logger.warn(`Failed to read existing agent file, will create new`, { error });
    }
  } else {
    logger.info(`Creating new agent definition: ${slug}`);
  }

  // Create agent definition object
  const agentDefinition = {
    ...existingData,
    name,
    role,
    ...(description !== undefined && { description }),
    ...(instructions !== undefined && { instructions }),
    ...(useCriteria !== undefined && { useCriteria }),
    ...(llmConfig !== undefined && { llmConfig }),
    ...(tools !== undefined && { tools }),
    ...(mcp !== undefined && { mcp }),
    ...(phases !== undefined && { phases }),
  };

  // Write the agent definition to file
  await writeJsonFile(filePath, agentDefinition);

  // Update the agents registry
  const registryPath = path.join(projectPath, ".tenex", "agents.json");
  let registry: Record<string, { file: string; nsec?: string; eventId?: string }> = {};
  
  if (await fileExists(registryPath)) {
    try {
      const content = await readFile(registryPath);
      registry = JSON.parse(content);
    } catch (error) {
      logger.warn("Failed to read agents registry, will create new", { error });
    }
  }

  // Generate nsec if needed (check for both missing and empty string)
  let nsec = registry[slug]?.nsec;
  if (!nsec || nsec === "") {
    const signer = NDKPrivateKeySigner.generate();
    nsec = signer.privateKey;
    logger.info(`Generated new nsec for agent "${slug}"`);
  }

  // Add or update the agent in the registry
  registry[slug] = {
    file: fileName,
    nsec: nsec,
  };

  await writeJsonFile(registryPath, registry);

  // Use the existing agent registry from project context
  const projectContext = getProjectContext();
  
  // Ensure the agent is registered with all proper initialization
  const agentConfig = {
    name,
    role,
    description,
    instructions,
    useCriteria,
    llmConfig,
    tools,
    mcp,
    phases,
  };
  
  // Use the existing agent registry to ensure the agent
  const agent = await projectContext.agentRegistry.ensureAgent(slug, agentConfig, projectContext.project);
  
  // The agentRegistry.ensureAgent already updates the registry internally,
  // but we need to update the ProjectContext's agents map as well
  const updatedAgents = new Map(projectContext.agents);
  updatedAgents.set(slug, agent);
  await projectContext.updateProjectData(projectContext.project, updatedAgents);

  logger.info(`Successfully wrote and activated agent "${name}" (${slug})`);
  logger.info(`  File: ${filePath}`);
  logger.info(`  Pubkey: ${agent.pubkey}`);

  return {
    success: true,
    message: `Successfully wrote and activated agent "${name}"`,
    filePath,
    agent: {
      slug,
      name,
      pubkey: agent.pubkey,
    },
  };
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

