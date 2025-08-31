import { tool } from 'ai';
import { fileExists, readFile } from "@/lib/fs";
import type { ExecutionContext } from "@/agents/execution/types";
import { logger } from "@/utils/logger";
import * as path from "node:path";
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
    mcp?: boolean;
    filePath?: string;
    isGlobal?: boolean;
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

  // Get project context
  const projectPath = process.cwd();
  
  // Try to read from project agents first
  let agentsDir = path.join(projectPath, ".tenex", "agents");
  const fileName = `${slug}.json`;
  let filePath = path.join(agentsDir, fileName);
  let isGlobal = false;

  // Check if the file exists in project directory
  if (!(await fileExists(filePath))) {
    // Try global agents directory
    const homedir = process.env.HOME || process.env.USERPROFILE || "";
    agentsDir = path.join(homedir, ".tenex", "agents");
    filePath = path.join(agentsDir, fileName);
    isGlobal = true;

    if (!(await fileExists(filePath))) {
      throw new Error(`Agent definition for slug "${slug}" not found in project or global agents`);
    }
  }

  // Read the agent definition file
  let agentDefinition: {
    name: string;
    role: string;
    description?: string;
    instructions?: string;
    useCriteria?: string;
    llmConfig?: string;
    tools?: string[];
    mcp?: boolean;
  };
  try {
    const content = await readFile(filePath);
    agentDefinition = JSON.parse(content);
  } catch (error) {
    throw new Error(`Failed to read or parse agent definition file: ${error}`);
  }

  // Also check if agent is in registry to get additional metadata
  const registryPath = isGlobal
    ? path.join(path.dirname(agentsDir), "agents.json")
    : path.join(projectPath, ".tenex", "agents.json");
  
  if (await fileExists(registryPath)) {
    try {
      const content = await readFile(registryPath);
      const registry = JSON.parse(content);
      // Check if agent exists in registry
      if (registry[slug]) {
        logger.debug("Agent found in registry", { slug });
      }
    } catch (error) {
      logger.debug("Failed to read agents registry", { error });
    }
  }

  logger.info(`Successfully read agent definition for "${agentDefinition.name}" (${slug})`);
  logger.info(`  Location: ${isGlobal ? "Global" : "Project"}`);
  logger.info(`  File: ${filePath}`);

  return {
    success: true,
    message: `Successfully read agent definition for "${agentDefinition.name}"`,
    agent: {
      slug,
      name: agentDefinition.name,
      role: agentDefinition.role,
      description: agentDefinition.description,
      instructions: agentDefinition.instructions,
      useCriteria: agentDefinition.useCriteria,
      llmConfig: agentDefinition.llmConfig,
      tools: agentDefinition.tools,
      mcp: agentDefinition.mcp,
      filePath,
      isGlobal,
    },
  };
}

/**
 * Create an AI SDK tool for reading agents
 * This is the primary implementation
 */
export function createAgentsReadTool(context: ExecutionContext) {
  return tool({
    description: "Read a local agent definition from its JSON file",
    parameters: agentsReadSchema,
    execute: async (input: AgentsReadInput) => {
      try {
        return await executeAgentsRead(input, context);
      } catch (error) {
        logger.error("Failed to read agent definition", { error });
        throw new Error(`Failed to read agent definition: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });
}

