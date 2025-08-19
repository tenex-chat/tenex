import { STATUS_INTERVAL_MS, STATUS_KIND } from "@/commands/run/constants";
import { getNDK } from "@/nostr/ndkClient";
import { configService, getProjectContext, isProjectContextInitialized } from "@/services";
import { mcpService } from "@/services/mcp/MCPService";
import { formatAnyError } from "@/utils/error-formatter";
import { logWarning } from "@/utils/logger";
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

    private async publishStatusEvent(projectPath: string): Promise<void> {
        try {
            const ndk = getNDK();
            const event = new NDKEvent(ndk);
            event.kind = STATUS_KIND;

            event.content = "";

            // Tag the project event properly
            const projectCtx = getProjectContext();
            event.tag(projectCtx.project);

            await this.addAgentPubkeys(event, projectPath);
            await this.addModelTags(event, projectPath);
            await this.addToolTags(event);

            // Sign the event with the project's signer
            await event.sign(projectCtx.signer);
            await event.publish();
        } catch (err) {
            const errorMessage = formatAnyError(err);
            logWarning(`Failed to publish status event: ${errorMessage}`);
        }
    }

    private async addAgentPubkeys(event: NDKEvent, _projectPath: string): Promise<void> {
        try {
            if (isProjectContextInitialized()) {
                const projectCtx = getProjectContext();
                for (const [agentSlug, agent] of projectCtx.agents) {
                    // Add "global" as fourth element for global agents
                    if (agent.isGlobal) {
                        event.tags.push(["agent", agent.pubkey, agentSlug, "global"]);
                    } else {
                        event.tags.push(["agent", agent.pubkey, agentSlug]);
                    }
                }
            } else {
                logWarning("ProjectContext not initialized for status event");
            }
        } catch (err) {
            logWarning(`Could not load agent information for status event: ${formatAnyError(err)}`);
        }
    }

    private async addModelTags(event: NDKEvent, projectPath: string): Promise<void> {
        try {
            const { llms } = await configService.loadConfig(projectPath);

            if (!llms) return;

            // Build a map of models to agents that use them
            const modelToAgents = new Map<string, Set<string>>();

            // Process agent-specific defaults
            if (llms.defaults) {
                for (const [agentSlug, configName] of Object.entries(llms.defaults)) {
                    if (!configName || agentSlug === "agents" || agentSlug === "routing") continue;

                    const config = llms.configurations[configName];
                    if (config?.model) {
                        if (!modelToAgents.has(config.model)) {
                            modelToAgents.set(config.model, new Set());
                        }
                        modelToAgents.get(config.model)!.add(agentSlug);
                    }
                }
            }

            // If there's a global default, apply it to all agents that don't have specific configs
            const globalDefault = llms.defaults?.agents || llms.defaults?.routing;
            if (globalDefault && llms.configurations[globalDefault]) {
                const config = llms.configurations[globalDefault];
                if (config?.model && isProjectContextInitialized()) {
                    const projectCtx = getProjectContext();
                    if (!modelToAgents.has(config.model)) {
                        modelToAgents.set(config.model, new Set());
                    }
                    // Add all agents that don't have specific model configs
                    for (const [agentSlug] of projectCtx.agents) {
                        if (!llms.defaults?.[agentSlug]) {
                            modelToAgents.get(config.model)!.add(agentSlug);
                        }
                    }
                }
            }

            // Add model tags in the new format: ["model", "<model-slug>", ...agent-slugs]
            for (const [modelSlug, agentSet] of modelToAgents) {
                const agentSlugs = Array.from(agentSet);
                if (agentSlugs.length > 0) {
                    event.tags.push(["model", modelSlug, ...agentSlugs]);
                }
            }
        } catch (err) {
            logWarning(`Could not load LLM information for status event model tags: ${formatAnyError(err)}`);
        }
    }

    private async addToolTags(event: NDKEvent): Promise<void> {
        try {
            if (!isProjectContextInitialized()) {
                logWarning("ProjectContext not initialized for tool tags");
                return;
            }

            const projectCtx = getProjectContext();
            const toolAgentMap = new Map<string, Set<string>>();

            // Build a map of tool name -> set of agent slugs that have access
            for (const [agentSlug, agent] of projectCtx.agents) {
                // Get the agent's configured tools
                const agentTools = agent.tools || [];
                
                for (const tool of agentTools) {
                    const toolName = tool.name;
                    if (!toolAgentMap.has(toolName)) {
                        toolAgentMap.set(toolName, new Set());
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
                            const toolName = mcpTool.name;
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

            // Convert the map to tool tags
            for (const [toolName, agentSlugs] of toolAgentMap) {
                // Create a tool tag with format: ["tool", "<tool-name>", "agent1", "agent2", ...]
                const agentArray = Array.from(agentSlugs).sort(); // Sort for consistency
                event.tags.push(["tool", toolName, ...agentArray]);
            }
        } catch (err) {
            logWarning(`Could not add tool tags to status event: ${formatAnyError(err)}`);
        }
    }
}
