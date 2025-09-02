// Status publishing interval
const STATUS_INTERVAL_MS = 30_000; // 30 seconds

import { EVENT_KINDS } from "@/llm/types";
import type { StatusIntent } from "@/nostr/AgentEventEncoder";
import { getNDK } from "@/nostr/ndkClient";
import { configService, getProjectContext, isProjectContextInitialized } from "@/services";
import { mcpService } from "@/services/mcp/MCPService";
import { formatAnyError } from "@/utils/error-formatter";
import { logger, logWarning } from "@/utils/logger";
import { NDKEvent } from "@nostr-dev-kit/ndk";

/**
 * StatusPublisher handles periodic publishing of status events to Nostr.
 *
 * This class manages the lifecycle of status event publishing, including:
 * - Starting and stopping the periodic publishing interval
 * - Creating and publishing status events with agent and model information
 * - Handling errors gracefully to ensure the main process continues
 *
 * Status events are published at regular intervals (STATUS_INTERVAL_MS) and include:
 * - Project reference tags
 * - Agent pubkeys and slugs
 * - Model configurations
 *
 * @example
 * ```typescript
 * const publisher = new StatusPublisher();
 * await publisher.startPublishing('/path/to/project');
 * // ... later
 * publisher.stopPublishing();
 * ```
 */
export class StatusPublisher {
  private statusInterval?: NodeJS.Timeout;

  constructor() {
    // No dependencies needed
  }

  async startPublishing(projectPath: string): Promise<void> {
    await this.publishStatusEvent(projectPath);

    this.statusInterval = setInterval(async () => {
      await this.publishStatusEvent(projectPath);
    }, STATUS_INTERVAL_MS);
  }

  stopPublishing(): void {
    if (this.statusInterval) {
      clearInterval(this.statusInterval);
      this.statusInterval = undefined;
    }
  }

  /**
   * Create a status event from the intent.
   * Directly creates the event without depending on AgentPublisher.
   */
  private createStatusEvent(intent: StatusIntent): NDKEvent {
    const event = new NDKEvent(getNDK());
    event.kind = EVENT_KINDS.PROJECT_STATUS;
    event.content = "";

    // Add project tag
    const projectCtx = getProjectContext();
    event.tag(projectCtx.project.tagReference());

    // Add p-tag for the project owner's pubkey
    event.tag(["p", projectCtx.project.pubkey]);

    // Add agent pubkeys
    for (const agent of intent.agents) {
      event.tag(["agent", agent.pubkey, agent.slug]);
    }

    // Add model access tags
    for (const model of intent.models) {
      event.tag(["model", model.slug, ...model.agents]);
    }

    // Add tool access tags
    for (const tool of intent.tools) {
      event.tag(["tool", tool.name, ...tool.agents]);
    }


    return event;
  }

  private async publishStatusEvent(projectPath: string): Promise<void> {
    try {
      const projectCtx = getProjectContext();

      // Build status intent
      const intent: StatusIntent = {
        type: "status",
        agents: [],
        models: [],
        tools: [],
        queue: [],
      };

      // Gather agent info - preserve order from NDKProject
      if (isProjectContextInitialized()) {
        // Get agent tags from project in their original order
        const projectAgentTags = projectCtx.project.tags
          .filter((tag) => tag[0] === "agent" && tag[1]);
        
        // Track which agents we've already added (by slug)
        const addedAgentSlugs = new Set<string>();
        
        // First, add agents that have eventIds in the order they appear in the project
        for (const agentTag of projectAgentTags) {
          const eventId = agentTag[1];
          
          // Find agent with matching eventId
          for (const [agentSlug, agent] of projectCtx.agents) {
            if (agent.eventId === eventId) {
              intent.agents.push({
                pubkey: agent.pubkey,
                slug: agentSlug,
              });
              addedAgentSlugs.add(agentSlug);
              break;
            }
          }
        }
        
        // Then add any remaining agents (global or inline agents without eventIds)
        for (const [agentSlug, agent] of projectCtx.agents) {
          if (!addedAgentSlugs.has(agentSlug)) {
            intent.agents.push({
              pubkey: agent.pubkey,
              slug: agentSlug,
            });
          }
        }
      }

      // Gather model info
      await this.gatherModelInfo(intent, projectPath);

      // Gather tool info
      await this.gatherToolInfo(intent);

      // Gather queue info
      // Queue functionality removed

      // Create and publish the status event directly
      const event = this.createStatusEvent(intent);

      // Sign and publish with project signer
      await event.sign(projectCtx.signer);
      await event.publish();
    } catch (err) {
      const errorMessage = formatAnyError(err);
      logWarning(`Failed to publish status event: ${errorMessage}`);
    }
  }

  private async gatherModelInfo(intent: StatusIntent, projectPath: string): Promise<void> {
    try {
      const { llms } = await configService.loadConfig(projectPath);

      if (!llms || !llms.configurations) return;

      // Build a map of configuration slugs to agents that use them
      const configToAgents = new Map<string, Set<string>>();

      // First, add ALL configured models (even if not used by any agent)
      for (const configSlug of Object.keys(llms.configurations)) {
        configToAgents.set(configSlug, new Set());
      }

      // Process agent-specific defaults to map agents to their configurations
      if (llms.defaults && isProjectContextInitialized()) {
        const projectCtx = getProjectContext();

        // Get the global default configuration if it exists
        const globalDefault = llms.defaults?.agents || llms.defaults?.routing;

        // Map each agent to its configuration
        for (const [agentSlug] of projectCtx.agents) {
          // Check if this agent has a specific configuration
          const specificConfig = llms.defaults[agentSlug];

          if (specificConfig && llms.configurations[specificConfig]) {
            // Agent has a specific configuration
            configToAgents.get(specificConfig)?.add(agentSlug);
          } else if (globalDefault && llms.configurations[globalDefault]) {
            // Agent uses the global default
            configToAgents.get(globalDefault)?.add(agentSlug);
          }
          // If neither specific nor global default, agent doesn't get mapped to any config
        }
      }

      // Add models to intent
      for (const [configSlug, agentSet] of configToAgents) {
        const agentSlugs = Array.from(agentSet).sort(); // Sort for consistency
        intent.models.push({
          slug: configSlug,
          agents: agentSlugs,
        });
      }
    } catch (err) {
      logWarning(
        `Could not load LLM information for status event model tags: ${formatAnyError(err)}`
      );
    }
  }

  private async gatherToolInfo(intent: StatusIntent): Promise<void> {
    try {
      if (!isProjectContextInitialized()) {
        logWarning("ProjectContext not initialized for tool tags");
        return;
      }

      const projectCtx = getProjectContext();
      const toolAgentMap = new Map<string, Set<string>>();

      // First, add ALL tool names from the registry (even if unassigned)
      const { getAllToolNames } = await import("@/tools/registry");
      const allToolNames = getAllToolNames();
      for (const toolName of allToolNames) {
        toolAgentMap.set(toolName, new Set());
      }

      // Then build a map of tool name -> set of agent slugs that have access
      for (const [agentSlug, agent] of projectCtx.agents) {
        // Get the agent's configured tools
        const agentTools = agent.tools || [];

        for (const toolName of agentTools) {
          // Skip invalid tool names
          if (!toolName) {
            logWarning(`Agent ${agentSlug} has invalid tool name: ${toolName}`);
            continue;
          }
          const toolAgents = toolAgentMap.get(toolName);
          if (toolAgents) {
            toolAgents.add(agentSlug);
          }
        }

        // If agent has MCP access, add all MCP tools
        if (agent.mcp) {
          try {
            const mcpTools = mcpService.getCachedTools();
            for (const mcpTool of mcpTools) {
              let toolName = mcpTool.name;
              
              // If tool doesn't have a name, compute one from description
              if (!toolName && mcpTool.description) {
                // Generate a name from the description
                // Take first few words, lowercase, replace spaces with underscores
                const words = mcpTool.description.toLowerCase()
                  .replace(/[^a-z0-9\s]/g, '') // Remove special chars
                  .split(/\s+/)
                  .slice(0, 4); // Take first 4 words max
                toolName = `mcp_${words.join('_')}`;
                logger.debug(`Generated MCP tool name '${toolName}' from description: ${mcpTool.description}`);
              }
              
              // Still skip if we couldn't generate a name
              if (!toolName) {
                logWarning(`Skipping MCP tool without name or description: ${JSON.stringify(mcpTool)}`);
                continue;
              }
              
              if (!toolAgentMap.has(toolName)) {
                toolAgentMap.set(toolName, new Set());
              }
              const toolAgents = toolAgentMap.get(toolName);
              if (toolAgents) {
                toolAgents.add(agentSlug);
              }
            }
          } catch (err) {
            // MCP tools might not be available yet, that's okay
            logWarning(`Could not get MCP tools for status event: ${formatAnyError(err)}`);
          }
        }
      }

      // Convert the map to tool entries
      // Include ALL tools with valid names, even if no agents are assigned
      for (const [toolName, agentSlugs] of toolAgentMap) {
        if (toolName) {
          const agentArray = Array.from(agentSlugs).sort(); // Sort for consistency
          intent.tools.push({
            name: toolName,
            agents: agentArray, // Can be empty array for unassigned tools
          });
        }
      }
    } catch (err) {
      logWarning(`Could not add tool tags to status event: ${formatAnyError(err)}`);
    }
  }

}
