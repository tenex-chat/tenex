import { AgentRegistry } from "@/agents/AgentRegistry";
import { ensureDirectory, fileExists, readFile, writeJsonFile } from "@/lib/fs";
import { getProjectContext } from "@/services/ProjectContext";
import type { ExecutionContext, Result, Tool, ToolError, Validated } from "@/tools/types";
import { createZodSchema, failure, success } from "@/tools/types";
import { logger } from "@/utils/logger";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import * as path from "node:path";
import { z } from "zod";

// Define the input schema
const agentsWriteSchema = z.object({
  slug: z.string().describe("The slug identifier for the agent"),
  name: z.string().describe("Display name of the agent"),
  role: z.string().describe("Primary role/function of the agent"),
  description: z.string().optional().describe("Agent description"),
  instructions: z.string().optional().describe("System instructions that guide agent behavior"),
  useCriteria: z.string().optional().describe("Criteria for when this agent should be selected"),
  llmConfig: z.string().optional().describe("LLM configuration identifier"),
  tools: z.array(z.string()).optional().describe("List of tool names available to this agent. All agents automatically get core tools: complete, lesson_get, lesson_learn, delegate, read_path, reports_list, report_read. Additional tools can include: agents_write, agents_read, agents_list, agents_discover, agents_hire, analyze, generate_inventory, shell, claude_code, delegate_external, delegate_phase, nostr_projects, discover_capabilities, write_context_file, report_write, report_delete. MCP tools use format: mcp__servername__toolname"),
  mcp: z.boolean().optional().describe("Whether this agent has access to MCP tools (defaults to true)"),
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
 * Tool: agents_write
 * Write or update a local agent definition and activate it in the project
 */
export const agentsWrite: Tool<AgentsWriteInput, AgentsWriteOutput> = {
  name: "agents-write",
  description:
    "Write or update a local agent definition and immediately activate it in the current project. Creates the agent configuration, assigns tools, and starts the agent. All agents automatically receive core tools (complete, delegate, lesson access, file reading, report access). Additional tools can be assigned based on the agent's responsibilities. The agent becomes immediately available for delegation and task execution.",
  parameters: createZodSchema(agentsWriteSchema),
  execute: async (
    input: Validated<AgentsWriteInput>,
    _context: ExecutionContext
  ): Promise<Result<ToolError, AgentsWriteOutput>> => {
    try {
      const { slug, name, role, description, instructions, useCriteria, llmConfig, tools, mcp } = input.value;

      if (!slug) {
        return failure({
          kind: "validation",
          field: "slug",
          message: "Agent slug is required",
        });
      }

      if (!name || !role) {
        return failure({
          kind: "validation",
          field: name ? "role" : "name",
          message: `Agent ${name ? "role" : "name"} is required`,
        });
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
      };

      // Write the agent definition to file
      await writeJsonFile(filePath, agentDefinition);

      // Update the agents registry
      const registryPath = path.join(projectPath, ".tenex", "agents.json");
      let registry: Record<string, any> = {};
      
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

      // Load the agent using AgentRegistry to ensure it's properly initialized
      const projectContext = getProjectContext();
      const agentRegistry = new AgentRegistry(projectPath, false);
      await agentRegistry.loadFromProject();
      
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
      };
      
      const agent = await agentRegistry.ensureAgent(slug, agentConfig, projectContext.project);
      
      // Update the ProjectContext with the new/updated agent to trigger 24010 event
      const updatedAgents = new Map(projectContext.agents);
      updatedAgents.set(slug, agent);
      await projectContext.updateProjectData(projectContext.project, updatedAgents);

      logger.info(`Successfully wrote and activated agent "${name}" (${slug})`);
      logger.info(`  File: ${filePath}`);
      logger.info(`  Pubkey: ${agent.pubkey}`);

      return success({
        success: true,
        message: `Successfully wrote and activated agent "${name}"`,
        filePath,
        agent: {
          slug,
          name,
          pubkey: agent.pubkey,
        },
      });
    } catch (error) {
      logger.error("Failed to write agent definition", { error });
      return failure({
        kind: "execution",
        tool: "agents-write",
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      });
    }
  },
};