import { ensureDirectory, fileExists, readFile, writeJsonFile } from "@/lib/fs";
import type { ExecutionContext, Result, Tool, ToolError, Validated } from "@/tools/types";
import { createZodSchema, failure, success } from "@/tools/types";
import { logger } from "@/utils/logger";
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
  tools: z.array(z.string()).optional().describe("List of tool names available to this agent"),
  mcp: z.boolean().optional().describe("Whether this agent has access to MCP tools"),
});

type AgentsWriteInput = z.infer<typeof agentsWriteSchema>;

// Define the output type
interface AgentsWriteOutput {
  success: boolean;
  message?: string;
  error?: string;
  filePath?: string;
}

/**
 * Tool: agents_write
 * Write or update a local agent definition JSON file without publishing to Nostr
 */
export const agentsWrite: Tool<AgentsWriteInput, AgentsWriteOutput> = {
  name: "agents_write",
  description:
    "Write or update a local agent definition JSON file in the project without publishing to Nostr",
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

      // Add or update the agent in the registry
      registry[slug] = {
        file: fileName,
        nsec: registry[slug]?.nsec || "", // Preserve existing nsec if updating
      };

      await writeJsonFile(registryPath, registry);

      logger.info(`Successfully wrote agent definition for "${name}" (${slug})`);
      logger.info(`  File: ${filePath}`);

      return success({
        success: true,
        message: `Successfully wrote agent definition for "${name}"`,
        filePath,
      });
    } catch (error) {
      logger.error("Failed to write agent definition", { error });
      return failure({
        kind: "execution",
        tool: "agents_write",
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      });
    }
  },
};