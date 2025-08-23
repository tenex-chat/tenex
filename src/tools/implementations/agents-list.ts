import { AgentRegistry } from "@/agents/AgentRegistry";
import { fileExists, readFile } from "@/lib/fs";
import type { ExecutionContext, Result, Tool, ToolError, Validated } from "@/tools/types";
import { createZodSchema, failure, success } from "@/tools/types";
import { logger } from "@/utils/logger";
import * as path from "node:path";
import { z } from "zod";

// Define the input schema - no inputs needed
const agentsListSchema = z.object({
  includeGlobal: z
    .boolean()
    .optional()
    .describe("Whether to include global agents in the list (default: true)"),
  verbose: z
    .boolean()
    .optional()
    .describe("Whether to include full instructions and details (default: false)"),
});

type AgentsListInput = z.infer<typeof agentsListSchema>;

// Define the output type
interface AgentInfo {
  slug: string;
  name: string;
  role: string;
  description?: string;
  instructions?: string;
  useCriteria?: string;
  tools?: string[];
  mcp?: boolean;
  isGlobal?: boolean;
  isBuiltIn?: boolean;
  eventId?: string;
}

interface AgentsListOutput {
  success: boolean;
  message?: string;
  error?: string;
  agents: AgentInfo[];
  summary?: {
    total: number;
    project: number;
    global: number;
    builtIn: number;
  };
}

/**
 * Tool: agents_list
 * List all available agents in the project with their configurations and system prompts
 */
export const agentsList: Tool<AgentsListInput, AgentsListOutput> = {
  name: "agents_list",
  description:
    "List all available agents in the project, including their system prompts and configurations",
  parameters: createZodSchema(agentsListSchema),
  execute: async (
    input: Validated<AgentsListInput>,
    _context: ExecutionContext
  ): Promise<Result<ToolError, AgentsListOutput>> => {
    try {
      const { includeGlobal = true, verbose = false } = input.value;

      const projectPath = process.cwd();
      const agents: AgentInfo[] = [];
      
      // Load project agents
      const projectAgentsDir = path.join(projectPath, ".tenex", "agents");
      const projectRegistryPath = path.join(projectPath, ".tenex", "agents.json");
      
      let projectAgents = 0;
      let globalAgents = 0;
      let builtInAgents = 0;

      // Read project registry
      if (await fileExists(projectRegistryPath)) {
        try {
          const registryContent = await readFile(projectRegistryPath);
          const registry = JSON.parse(registryContent);
          
          for (const [slug, entry] of Object.entries(registry as Record<string, any>)) {
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
                  isBuiltIn: false,
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
            
            for (const [slug, entry] of Object.entries(registry as Record<string, any>)) {
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
                    isBuiltIn: false,
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

      // Load built-in agents from the active registry
      try {
        const registry = new AgentRegistry(projectPath, false);
        await registry.loadFromProject();
        
        const allAgents = registry.getAllAgents();
        for (const agent of allAgents) {
          if (agent.isBuiltIn) {
            // Skip if already loaded
            if (agents.some(a => a.slug === agent.slug)) {
              continue;
            }
            
            agents.push({
              slug: agent.slug,
              name: agent.name,
              role: agent.role,
              description: agent.description,
              instructions: verbose ? agent.instructions : undefined,
              useCriteria: agent.useCriteria,
              tools: agent.tools.map(t => t.name),
              mcp: agent.mcp,
              isGlobal: agent.isGlobal,
              isBuiltIn: true,
              eventId: agent.eventId,
            });
            builtInAgents++;
          }
        }
      } catch (error) {
        logger.debug("Failed to load built-in agents from registry", { error });
      }

      // Sort agents by type (built-in first, then project, then global) and name
      agents.sort((a, b) => {
        if (a.isBuiltIn !== b.isBuiltIn) return a.isBuiltIn ? -1 : 1;
        if (a.isGlobal !== b.isGlobal) return a.isGlobal ? 1 : -1;
        return a.name.localeCompare(b.name);
      });

      logger.info(`Listed ${agents.length} agents`);
      logger.info(`  Project: ${projectAgents}`);
      logger.info(`  Global: ${globalAgents}`);
      logger.info(`  Built-in: ${builtInAgents}`);

      return success({
        success: true,
        message: `Found ${agents.length} agents`,
        agents,
        summary: {
          total: agents.length,
          project: projectAgents,
          global: globalAgents,
          builtIn: builtInAgents,
        },
      });
    } catch (error) {
      logger.error("Failed to list agents", { error });
      return failure({
        kind: "execution",
        tool: "agents_list",
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      });
    }
  },
};