import { tool } from 'ai';
import { fileExists, readFile } from "@/lib/fs";
import { logger } from "@/utils/logger";
import * as path from "node:path";
import { z } from "zod";
const agentsListSchema = z.object({
  includeGlobal: z
    .boolean()
    .nullable()
    .optional()
    .describe("Whether to include global agents in the list (default: true)"),
  verbose: z
    .boolean()
    .nullable()
    .optional()
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
  mcp?: boolean;
  isGlobal?: boolean;
  eventId?: string;
};

type AgentsListOutput = {
  success: boolean;
  message?: string;
  error?: string;
  agents: AgentInfo[];
  summary?: {
    total: number;
    project: number;
    global: number;
  };
};

/**
 * Core implementation of the agents_list functionality
 */
async function executeAgentsList(
  input: AgentsListInput
): Promise<AgentsListOutput> {
  const { includeGlobal = true, verbose = false } = input;

      const projectPath = process.cwd();
      const agents: AgentInfo[] = [];
      
      // Load project agents
      const projectAgentsDir = path.join(projectPath, ".tenex", "agents");
      const projectRegistryPath = path.join(projectPath, ".tenex", "agents.json");
      
      let projectAgents = 0;
      let globalAgents = 0;

      // Read project registry
      if (await fileExists(projectRegistryPath)) {
        try {
          const registryContent = await readFile(projectRegistryPath);
          const registry = JSON.parse(registryContent);
          
          for (const [slug, entry] of Object.entries(registry as Record<string, { file: string; eventId?: string }>)) {
            const agentFilePath = path.join(projectAgentsDir, entry.file);
            
            if (await fileExists(agentFilePath)) {
              try {
                const agentContent = await readFile(agentFilePath);
                const agentDef = JSON.parse(agentContent);
                
                agents.push({
                  slug,
                  name: agentDef.name,
                  role: agentDef.role,
                  description: agentDef.description,
                  instructions: verbose ? agentDef.instructions : undefined,
                  useCriteria: agentDef.useCriteria,
                  tools: agentDef.tools,
                  mcp: agentDef.mcp,
                  isGlobal: false,
                  eventId: entry.eventId,
                });
                projectAgents++;
              } catch (error) {
                logger.warn(`Failed to read agent file: ${agentFilePath}`, { error });
              }
            }
          }
        } catch (error) {
          logger.debug("Failed to read project agents registry", { error });
        }
      }

      // Load global agents if requested
      if (includeGlobal) {
        const homedir = process.env.HOME || process.env.USERPROFILE || "";
        const globalAgentsDir = path.join(homedir, ".tenex", "agents");
        const globalRegistryPath = path.join(homedir, ".tenex", "agents.json");
        
        if (await fileExists(globalRegistryPath)) {
          try {
            const registryContent = await readFile(globalRegistryPath);
            const registry = JSON.parse(registryContent);
            
            for (const [slug, entry] of Object.entries(registry as Record<string, { file: string; eventId?: string }>)) {
              // Skip if already loaded from project
              if (agents.some(a => a.slug === slug)) {
                continue;
              }
              
              const agentFilePath = path.join(globalAgentsDir, entry.file);
              
              if (await fileExists(agentFilePath)) {
                try {
                  const agentContent = await readFile(agentFilePath);
                  const agentDef = JSON.parse(agentContent);
                  
                  agents.push({
                    slug,
                    name: agentDef.name,
                    role: agentDef.role,
                    description: agentDef.description,
                    instructions: verbose ? agentDef.instructions : undefined,
                    useCriteria: agentDef.useCriteria,
                    tools: agentDef.tools,
                    mcp: agentDef.mcp,
                    isGlobal: true,
                    eventId: entry.eventId,
                  });
                  globalAgents++;
                } catch (error) {
                  logger.warn(`Failed to read global agent file: ${agentFilePath}`, { error });
                }
              }
            }
          } catch (error) {
            logger.debug("Failed to read global agents registry", { error });
          }
        }
      }


      // Sort agents by type (project first, then global) and name
      agents.sort((a, b) => {
        if (a.isGlobal !== b.isGlobal) return a.isGlobal ? 1 : -1;
        return a.name.localeCompare(b.name);
      });

      logger.info(`Listed ${agents.length} agents`);
      logger.info(`  Project: ${projectAgents}`);
      logger.info(`  Global: ${globalAgents}`);

  return {
    success: true,
    message: `Found ${agents.length} agents`,
    agents,
    summary: {
      total: agents.length,
      project: projectAgents,
      global: globalAgents,
    },
  };
}

/**
 * Create an AI SDK tool for listing agents
 * This is the primary implementation
 */
export function createAgentsListTool(): ReturnType<typeof tool> {
  return tool({
    description: "List all available agents in the project, including their system prompts and configurations",
    inputSchema: agentsListSchema,
    execute: async (input: AgentsListInput) => {
      try {
        return await executeAgentsList(input);
      } catch (error) {
        logger.error("Failed to list agents", { error });
        throw new Error(`Failed to list agents: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });
}
