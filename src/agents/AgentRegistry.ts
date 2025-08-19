import { formatAnyError } from "@/utils/error-formatter";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AgentPublisher } from "@/nostr/AgentPublisher";
import type { AgentInstance, AgentConfig, AgentConfigOptionalNsec, StoredAgentData } from "@/agents/types";
import { ensureDirectory, fileExists, readFile, writeJsonFile } from "@/lib/fs";
import { DEFAULT_AGENT_LLM_CONFIG } from "@/llm/constants";
import { configService } from "@/services";
import { getProjectContext, isProjectContextInitialized } from "@/services";
import type { TenexAgents } from "@/services/config/types";
import { logger } from "@/utils/logger";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import type { NDKProject } from "@nostr-dev-kit/ndk";
import { getBuiltInAgents } from "./builtInAgents";
import { getDefaultToolsForAgent } from "./constants";

/**
 * AgentRegistry manages agent configuration and instances for a project.
 * Handles loading, saving, and publishing agents to the Nostr network.
 */
export class AgentRegistry {
    private agents: Map<string, AgentInstance> = new Map();
    private agentsByPubkey: Map<string, AgentInstance> = new Map();
    private agentsDir: string;
    private registry: TenexAgents = {};
    private globalRegistry: TenexAgents = {};
    private isGlobal: boolean;

    /**
     * Creates a new AgentRegistry instance.
     * @param basePath - Base directory path for the project
     * @param isGlobal - Whether this is the global agent registry
     */
    constructor(
        private basePath: string,
        isGlobal = false
    ) {
        this.isGlobal = isGlobal;
        // If basePath already includes .tenex, use it as is
        if (basePath.endsWith(".tenex")) {
            this.agentsDir = path.join(basePath, "agents");
        } else {
            this.agentsDir = path.join(basePath, ".tenex", "agents");
        }
    }

    async loadFromProject(ndkProject?: NDKProject): Promise<void> {
        // Ensure .tenex directory exists
        const tenexDir = this.basePath.endsWith(".tenex")
            ? this.basePath
            : path.join(this.basePath, ".tenex");
        await ensureDirectory(tenexDir);
        await ensureDirectory(this.agentsDir);

        // Load agents using ConfigService
        try {
            // Load global agents first if we're in a project context
            if (!this.isGlobal) {
                try {
                    this.globalRegistry = await configService.loadTenexAgents(
                        configService.getGlobalPath()
                    );
                } catch (error) {
                    logger.debug("No global agents found or failed to load", { error });
                    this.globalRegistry = {};
                }
            }

            // Load project/local agents
            this.registry = await configService.loadTenexAgents(tenexDir);

            // Load global agents first (if in project context)
            const loadedGlobalEventIds = new Set<string>();
            const loadedGlobalSlugs = new Set<string>();
            if (!this.isGlobal) {
                for (const [slug, registryEntry] of Object.entries(this.globalRegistry)) {
                    logger.debug(`Loading global agent: ${slug}`, { registryEntry });
                    await this.loadAgentBySlug(slug, true);
                    // Track global agent event IDs and slugs
                    if (registryEntry.eventId) {
                        loadedGlobalEventIds.add(registryEntry.eventId);
                    }
                    loadedGlobalSlugs.add(slug);
                }
            }

            // Load project/local agents (skip if they match a global agent's event ID or slug)
            for (const [slug, registryEntry] of Object.entries(this.registry)) {
                // Check if this project agent matches a global agent (same event ID or same slug)
                if (registryEntry.eventId && loadedGlobalEventIds.has(registryEntry.eventId)) {
                    logger.info(`Skipping project agent "${slug}" - using global agent with same event ID`, {
                        eventId: registryEntry.eventId,
                    });
                    continue;
                }
                if (loadedGlobalSlugs.has(slug)) {
                    logger.info(`Skipping project agent "${slug}" - using global agent with same slug`);
                    continue;
                }
                logger.debug(`Loading agent from registry: ${slug}`, { registryEntry });
                await this.loadAgentBySlug(slug, false);
            }

            // Load built-in agents
            await this.ensureBuiltInAgents(ndkProject);
        } catch (error) {
            logger.error("Failed to load agent registry", { error });
            this.registry = {};
        }
    }

    async ensureAgent(
        name: string,
        config: AgentConfigOptionalNsec,
        ndkProject?: NDKProject,
        fromGlobal = false
    ): Promise<AgentInstance> {
        // Check if agent already exists in memory
        const existingAgent = this.agents.get(name);
        if (existingAgent) {
            return existingAgent;
        }

        // Check if we're in a project context and this agent exists globally
        if (!this.isGlobal) {
            // Check by slug first (exact match)
            if (this.globalRegistry[name]) {
                logger.info(`Agent "${name}" already exists globally, using global agent`);
                // Load the global agent if not already loaded
                const globalAgent = this.agents.get(name);
                if (globalAgent) {
                    return globalAgent;
                }
                // Load the global agent - use internal method to avoid recursion
                const loadedAgent = await this.loadAgentBySlugInternal(name, true);
                if (loadedAgent) {
                    return loadedAgent;
                }
            }
            
            // Check by eventId if provided
            if (config.eventId) {
                for (const [globalSlug, globalEntry] of Object.entries(this.globalRegistry)) {
                    if (globalEntry.eventId === config.eventId) {
                        logger.info(`Agent with eventId ${config.eventId} already exists globally as "${globalSlug}", using global agent`, {
                            localSlug: name,
                            globalSlug,
                        });
                        // Load the global agent if not already loaded
                        const globalAgent = this.agents.get(globalSlug);
                        if (globalAgent) {
                            return globalAgent;
                        }
                        // Load the global agent - use internal method to avoid recursion
                        const loadedAgent = await this.loadAgentBySlugInternal(globalSlug, true);
                        if (loadedAgent) {
                            return loadedAgent;
                        }
                    }
                }
            }
        }

        // Check if we have it in local registry
        let registryEntry = this.registry[name];
        let agentDefinition: StoredAgentData;

        if (!registryEntry) {
            // Generate new nsec for agent
            const signer = NDKPrivateKeySigner.generate();
            const { nsec } = signer;

            // Create new registry entry
            const fileName = `${config.eventId || name.toLowerCase().replace(/[^a-z0-9]/g, "-")}.json`;
            registryEntry = {
                nsec,
                file: fileName,
            };

            // Only add eventId if it exists
            if (config.eventId) {
                registryEntry.eventId = config.eventId;
            }

            // Check if this is a built-in agent
            const isBuiltIn = getBuiltInAgents().some((agent) => agent.slug === name);

            // Save agent definition to file
            agentDefinition = {
                name: config.name,
                role: config.role,
                description: config.description,
                instructions: config.instructions || "",
                useCriteria: config.useCriteria,
                llmConfig: config.llmConfig,
                };

            // Include tools if explicitly provided
            // For built-in agents, always save tools even if empty array
            if (config.tools !== undefined) {
                agentDefinition.tools = config.tools;
            }

            const definitionPath = path.join(this.agentsDir, fileName);
            if (isBuiltIn) {
                // For built-in agents, we don't save instructions to the JSON file
                // This ensures built-in agents always use the up-to-date instructions
                // from the code rather than potentially outdated instructions in the file
                const { instructions: _, ...definitionWithoutInstructions } = agentDefinition;
                await writeJsonFile(definitionPath, definitionWithoutInstructions);
            } else {
                await writeJsonFile(definitionPath, agentDefinition);
            }

            this.registry[name] = registryEntry;
            await this.saveRegistry();

            logger.info(`Created new agent "${name}" with nsec`);

            // Publish kind:0 and request events for new agent
            const { nsec: _, ...configWithoutNsec } = config;
            await this.publishAgentEvents(
                signer,
                configWithoutNsec,
                registryEntry.eventId,
                ndkProject
            );
        } else {
            // Load agent definition from file
            const definitionPath = path.join(this.agentsDir, registryEntry.file);
            if (await fileExists(definitionPath)) {
                const content = await readFile(definitionPath, "utf-8");
                try {
                    agentDefinition = JSON.parse(content);
                    
                    // For built-in agents, merge missing fields from TypeScript definition before validation
                    const builtInAgents = getBuiltInAgents();
                    const builtInAgent = builtInAgents.find((agent) => agent.slug === name);
                    if (builtInAgent) {
                        // Fill in missing required fields from built-in definition
                        if (!agentDefinition.role) {
                            agentDefinition.role = builtInAgent.role;
                        }
                        if (!agentDefinition.useCriteria) {
                            agentDefinition.useCriteria = builtInAgent.useCriteria;
                        }
                        if (!agentDefinition.instructions) {
                            agentDefinition.instructions = builtInAgent.instructions || "";
                        }
                        if (!agentDefinition.name) {
                            agentDefinition.name = builtInAgent.name;
                        }
                        // Apply MCP setting from built-in definition
                        if (builtInAgent.mcp !== undefined) {
                            agentDefinition.mcp = builtInAgent.mcp;
                        }
                    }
                    
                    this.validateAgentDefinition(agentDefinition);
                } catch (error) {
                    logger.error("Failed to parse or validate agent definition", {
                        file: registryEntry.file,
                        error,
                    });
                    throw new Error(`Invalid agent definition in ${registryEntry.file}: ${error}`);
                }
            } else {
                // Check if this is a built-in agent
                const isBuiltIn = getBuiltInAgents().some((agent) => agent.slug === name);

                // Fallback: create definition from config if file doesn't exist
                agentDefinition = {
                    name: config.name,
                    role: config.role,
                    description: config.description,
                    instructions: config.instructions || "",
                    useCriteria: config.useCriteria,
                    llmConfig: config.llmConfig,
                        };
                if (isBuiltIn) {
                    const { instructions: _, ...definitionWithoutInstructions } = agentDefinition;
                    await writeJsonFile(definitionPath, definitionWithoutInstructions);
                } else {
                    await writeJsonFile(definitionPath, agentDefinition);
                }
            }
        }

        // Create NDKPrivateKeySigner
        const signer = new NDKPrivateKeySigner(registryEntry.nsec);

        // Use the helper to build the agent instance
        const agent = await this.buildAgentInstance(
            name,
            agentDefinition,
            registryEntry,
            signer,
            fromGlobal
        );

        // Store in both maps
        this.agents.set(name, agent);
        this.agentsByPubkey.set(agent.pubkey, agent);

        return agent;
    }

    getAgent(name: string): AgentInstance | undefined {
        return this.agents.get(name);
    }

    getAgentByPubkey(pubkey: string): AgentInstance | undefined {
        return this.agentsByPubkey.get(pubkey);
    }

    getAllAgents(): AgentInstance[] {
        return Array.from(this.agents.values());
    }

    getAllAgentsMap(): Map<string, AgentInstance> {
        return new Map(this.agents);
    }

    getAgentByName(name: string): AgentInstance | undefined {
        return Array.from(this.agents.values()).find((agent) => agent.name === name);
    }

    private async saveRegistry(): Promise<void> {
        if (this.isGlobal) {
            await configService.saveGlobalAgents(this.registry);
        } else {
            await configService.saveProjectAgents(this.basePath, this.registry);
        }
    }

    /**
     * Remove an agent by its event ID
     * This removes the agent from memory and deletes its definition file
     */
    async removeAgentByEventId(eventId: string): Promise<boolean> {
        // Find the agent with this event ID
        let agentSlugToRemove: string | undefined;
        let agentToRemove: AgentInstance | undefined;

        for (const [slug, agent] of this.agents) {
            if (agent.eventId === eventId) {
                agentSlugToRemove = slug;
                agentToRemove = agent;
                break;
            }
        }

        if (!agentSlugToRemove || !agentToRemove) {
            logger.warn(`Agent with eventId ${eventId} not found for removal`);
            return false;
        }

        // Don't allow removing built-in agents
        if (agentToRemove.isBuiltIn) {
            logger.warn(`Cannot remove built-in agent ${agentSlugToRemove}`);
            return false;
        }

        // Remove from memory
        this.agents.delete(agentSlugToRemove);
        this.agentsByPubkey.delete(agentToRemove.pubkey);

        // Remove from registry
        const registryEntry = this.registry[agentSlugToRemove];
        if (registryEntry) {
            // Delete the agent definition file
            try {
                const filePath = path.join(this.agentsDir, registryEntry.file);
                await fs.unlink(filePath);
                logger.info(`Deleted agent definition file: ${filePath}`);
            } catch (error) {
                logger.warn("Failed to delete agent definition file", {
                    error,
                    slug: agentSlugToRemove,
                });
            }

            // Remove from registry and save
            delete this.registry[agentSlugToRemove];
            await this.saveRegistry();
        }

        logger.info(`Removed agent ${agentSlugToRemove} (eventId: ${eventId})`);
        return true;
    }

    /**
     * Remove an agent by its slug
     * This removes the agent from memory and deletes its definition file
     */
    async removeAgentBySlug(slug: string): Promise<boolean> {
        const agent = this.agents.get(slug);
        if (!agent) {
            logger.warn(`Agent with slug ${slug} not found for removal`);
            return false;
        }

        // Don't allow removing built-in agents
        if (agent.isBuiltIn) {
            logger.warn(`Cannot remove built-in agent ${slug}`);
            return false;
        }

        // Remove from memory
        this.agents.delete(slug);
        this.agentsByPubkey.delete(agent.pubkey);

        // Remove from registry
        const registryEntry = this.registry[slug];
        if (registryEntry) {
            // Delete the agent definition file
            try {
                const filePath = path.join(this.agentsDir, registryEntry.file);
                await fs.unlink(filePath);
                logger.info(`Deleted agent definition file: ${filePath}`);
            } catch (error) {
                logger.warn("Failed to delete agent definition file", { error, slug });
            }

            // Remove from registry and save
            delete this.registry[slug];
            await this.saveRegistry();
        }

        logger.info(`Removed agent ${slug}`);
        return true;
    }

    /**
     * Update an agent's LLM configuration persistently
     */
    async updateAgentLLMConfig(agentPubkey: string, newLLMConfig: string): Promise<boolean> {
        // Find the agent by pubkey
        const agent = this.agentsByPubkey.get(agentPubkey);
        if (!agent) {
            logger.warn(`Agent with pubkey ${agentPubkey} not found for LLM config update`);
            return false;
        }

        // Update the agent in memory
        agent.llmConfig = newLLMConfig;

        // Find the registry entry by slug
        const registryEntry = this.registry[agent.slug];
        if (!registryEntry) {
            logger.warn(`Registry entry not found for agent ${agent.slug}`);
            return false;
        }

        // Update the agent definition file
        try {
            const definitionPath = path.join(this.agentsDir, registryEntry.file);
            
            // Read existing definition
            let agentDefinition: StoredAgentData;
            try {
                const content = await fs.readFile(definitionPath, "utf-8");
                agentDefinition = JSON.parse(content);
            } catch (error) {
                logger.warn("Failed to read agent definition, creating from current state", {
                    file: registryEntry.file,
                    error,
                });
                // Create definition from current agent state
                agentDefinition = {
                    name: agent.name,
                    role: agent.role,
                    description: agent.description,
                    instructions: agent.instructions || "",
                    useCriteria: agent.useCriteria,
                    llmConfig: newLLMConfig,
                        };
            }

            // Update the llmConfig
            agentDefinition.llmConfig = newLLMConfig;

            // Save the updated definition
            await writeJsonFile(definitionPath, agentDefinition);
            
            logger.info(`Updated LLM config for agent ${agent.name} (${agent.slug})`, {
                newLLMConfig,
                file: registryEntry.file,
            });

            return true;
        } catch (error) {
            logger.error("Failed to update agent LLM config", {
                agentSlug: agent.slug,
                error: formatAnyError(error),
            });
            return false;
        }
    }

    /**
     * Update an agent's tools configuration persistently
     * @param agentPubkey - The public key of the agent to update
     * @param newToolNames - Array of tool names the agent should have access to
     * @returns true if successful, false otherwise
     */
    async updateAgentTools(agentPubkey: string, newToolNames: string[]): Promise<boolean> {
        // Find the agent by pubkey
        const agent = this.agentsByPubkey.get(agentPubkey);
        if (!agent) {
            logger.warn(`Agent with pubkey ${agentPubkey} not found for tools update`);
            return false;
        }

        // Project Manager always keeps its hardcoded tools
        if (agent.slug === "project-manager") {
            logger.info("Ignoring tool configuration change for project-manager agent");
            return false;
        }

        // Ensure complete() is always present
        if (!newToolNames.includes("complete")) {
            newToolNames.push("complete");
        }

        // Update the agent tools in memory
        const { getTools } = await import("@/tools/registry");
        agent.tools = getTools(newToolNames as any);

        // Find the registry entry by slug
        const registryEntry = this.registry[agent.slug];
        if (!registryEntry) {
            logger.warn(`Registry entry not found for agent ${agent.slug}`);
            return false;
        }

        // Update the agent definition file
        try {
            const definitionPath = path.join(this.agentsDir, registryEntry.file);
            
            // Read existing definition
            let agentDefinition: StoredAgentData;
            try {
                const content = await fs.readFile(definitionPath, "utf-8");
                agentDefinition = JSON.parse(content);
            } catch (error) {
                logger.warn("Failed to read agent definition, creating from current state", {
                    file: registryEntry.file,
                    error,
                });
                // Create definition from current agent state
                agentDefinition = {
                    name: agent.name,
                    role: agent.role,
                    description: agent.description,
                    instructions: agent.instructions || "",
                    useCriteria: agent.useCriteria,
                    llmConfig: agent.llmConfig,
                    tools: newToolNames,
                };
            }

            // Update the tools
            agentDefinition.tools = newToolNames;

            // Save the updated definition
            await writeJsonFile(definitionPath, agentDefinition);
            
            logger.info(`Updated tools for agent ${agent.name} (${agent.slug})`, {
                newTools: newToolNames,
                file: registryEntry.file,
            });

            return true;
        } catch (error) {
            logger.error("Failed to update agent tools", {
                agentSlug: agent.slug,
                error: formatAnyError(error),
            });
            return false;
        }
    }


    private async publishAgentEvents(
        signer: NDKPrivateKeySigner,
        config: Omit<AgentConfig, "nsec">,
        ndkAgentEventId?: string,
        ndkProject?: NDKProject
    ): Promise<void> {
        try {
            let projectTitle: string;
            let projectEvent: NDKProject;

            // Use passed NDKProject if available, otherwise fall back to ProjectContext
            if (ndkProject) {
                projectTitle = ndkProject.tagValue("title") || "Unknown Project";
                projectEvent = ndkProject;
            } else {
                // Check if project context is initialized
                if (!isProjectContextInitialized()) {
                    logger.warn(
                        "ProjectContext not initialized and no NDKProject provided, skipping agent event publishing"
                    );
                    return;
                }

                // Get project context for project event and name
                const projectCtx = getProjectContext();
                projectTitle = projectCtx.project.tagValue("title") || "Unknown Project";
                projectEvent = projectCtx.project;
            }

            // Publish agent profile (kind:0) and request event using static method
            await AgentPublisher.publishAgentCreation(
                signer,
                config,
                projectTitle,
                projectEvent,
                ndkAgentEventId
            );
        } catch (error) {
            logger.error("Failed to publish agent events", { error });
            // Don't throw - agent creation should succeed even if publishing fails
        }
    }

    async loadAgentBySlug(slug: string, fromGlobal = false): Promise<AgentInstance | null> {
        return this.loadAgentBySlugInternal(slug, fromGlobal);
    }

    private async loadAgentBySlugInternal(slug: string, fromGlobal = false): Promise<AgentInstance | null> {
        const registryToUse = fromGlobal ? this.globalRegistry : this.registry;
        const registryEntry = registryToUse[slug];
        if (!registryEntry) {
            return null;
        }

        // Determine the correct agents directory
        const agentsDir = fromGlobal
            ? path.join(configService.getGlobalPath(), "agents")
            : this.agentsDir;

        // Load agent definition from file
        const definitionPath = path.join(agentsDir, registryEntry.file);
        if (!(await fileExists(definitionPath))) {
            logger.error(`Agent definition file not found: ${definitionPath}`);
            return null;
        }

        const content = await readFile(definitionPath, "utf-8");
        let agentDefinition: StoredAgentData;
        try {
            agentDefinition = JSON.parse(content);
            
            // For built-in agents, merge missing fields from TypeScript definition before validation
            const builtInAgents = getBuiltInAgents();
            const builtInAgent = builtInAgents.find((agent) => agent.slug === slug);
            if (builtInAgent) {
                // Fill in missing required fields from built-in definition
                if (!agentDefinition.role) {
                    agentDefinition.role = builtInAgent.role;
                }
                if (!agentDefinition.useCriteria) {
                    agentDefinition.useCriteria = builtInAgent.useCriteria;
                }
                if (!agentDefinition.instructions) {
                    agentDefinition.instructions = builtInAgent.instructions || "";
                }
                if (!agentDefinition.name) {
                    agentDefinition.name = builtInAgent.name;
                }
                // CRITICAL: Always use tools from built-in definition for built-in agents
                // This ensures built-in agents always have their correct tools
                if (builtInAgent.tools !== undefined) {
                    agentDefinition.tools = builtInAgent.tools;
                }
                // Also apply MCP setting from built-in definition
                if (builtInAgent.mcp !== undefined) {
                    agentDefinition.mcp = builtInAgent.mcp;
                }
            }
            
            this.validateAgentDefinition(agentDefinition);
        } catch (error) {
            logger.error("Failed to parse or validate agent definition", {
                file: definitionPath,
                error,
            });
            throw new Error(`Invalid agent definition in ${definitionPath}: ${error}`);
        }

        // Create AgentConfig from definition
        const config: AgentConfig = {
            name: agentDefinition.name,
            role: agentDefinition.role,
            instructions: agentDefinition.instructions || "",
            useCriteria: agentDefinition.useCriteria,
            nsec: registryEntry.nsec,
            eventId: registryEntry.eventId,
            tools: agentDefinition.tools, // Preserve explicit tools configuration
            mcp: agentDefinition.mcp, // Preserve MCP configuration
            llmConfig: agentDefinition.llmConfig,
        };

        // If loading from global registry, create agent directly without recursive ensureAgent call
        if (fromGlobal) {
            return this.createAgentInstance(slug, config, registryEntry);
        }

        return this.ensureAgent(slug, config, undefined, fromGlobal);
    }

    /**
     * Helper method to build an AgentInstance from configuration and registry data
     * Centralizes the logic for creating agent instances to avoid duplication
     */
    private async buildAgentInstance(
        slug: string,
        agentDefinition: StoredAgentData,
        registryEntry: TenexAgents[string],
        signer: NDKPrivateKeySigner,
        isGlobal: boolean
    ): Promise<AgentInstance> {
        const pubkey = signer.pubkey;

        // Determine agent name - use project name for project-manager agent
        let agentName = agentDefinition.name;
        const isProjectManager = slug === "project-manager";
        
        if (isProjectManager) {
            try {
                const { getProjectContext } = await import("@/services");
                const projectCtx = getProjectContext();
                const projectTitle = projectCtx.project.tagValue("title");
                if (projectTitle) {
                    agentName = projectTitle;
                }
            } catch {
                // If project context not available, use default name
                agentName = agentDefinition.name;
            }
        }

        // Determine if this is a built-in agent
        const isBuiltIn = getBuiltInAgents().some((builtIn) => builtIn.slug === slug);

        // Create Agent instance with all properties set
        const agent: AgentInstance = {
            name: agentName,
            pubkey,
            signer,
            role: agentDefinition.role,
            description: agentDefinition.description,
            instructions: agentDefinition.instructions || "",
            useCriteria: agentDefinition.useCriteria,
            llmConfig: agentDefinition.llmConfig || DEFAULT_AGENT_LLM_CONFIG,
            tools: [], // Will be set next
            mcp: agentDefinition.mcp ?? true, // Default to true for all agents
            eventId: registryEntry.eventId,
            slug: slug,
            isBuiltIn: isBuiltIn,
            isGlobal: isGlobal,
        };

        // Set tools - use explicit tools if configured, otherwise use defaults
        const toolNames =
            agentDefinition.tools !== undefined
                ? agentDefinition.tools
                : getDefaultToolsForAgent(agent);


        // Convert tool names to Tool instances
        const { getTools } = await import("@/tools/registry");
        // Cast to ToolName[] - tool names from storage are validated at runtime
        agent.tools = getTools(toolNames as any);

        return agent;
    }

    /**
     * Create an agent instance directly without going through ensureAgent
     * Used to avoid infinite recursion when loading global agents
     */
    private async createAgentInstance(
        slug: string,
        config: AgentConfig,
        registryEntry: TenexAgents[string]
    ): Promise<AgentInstance> {
        // Create NDKPrivateKeySigner
        const signer = new NDKPrivateKeySigner(registryEntry.nsec);
        
        // Create agent definition from config
        const agentDefinition: StoredAgentData = {
            name: config.name,
            role: config.role,
            description: config.description,
            instructions: config.instructions || "",
            useCriteria: config.useCriteria,
            llmConfig: config.llmConfig,
            tools: config.tools,
            mcp: config.mcp,
        };

        // Use the helper to build the agent instance
        const agent = await this.buildAgentInstance(
            slug,
            agentDefinition,
            registryEntry,
            signer,
            true // createAgentInstance is only called for global agents
        );

        // Store in both maps
        this.agents.set(slug, agent);
        this.agentsByPubkey.set(agent.pubkey, agent);

        return agent;
    }

    /**
     * Validate an agent definition has all required fields
     */
    private validateAgentDefinition(definition: unknown): asserts definition is StoredAgentData {
        if (!definition || typeof definition !== "object") {
            throw new Error("Agent definition must be an object");
        }

        const def = definition as Record<string, unknown>;

        if (!def.name || typeof def.name !== "string") {
            throw new Error("Agent definition must have a name property");
        }

        if (!def.role || typeof def.role !== "string") {
            throw new Error("Agent definition must have a role property");
        }

        // Optional fields with type validation
        // Note: instructions is optional for built-in agents
        if (def.instructions !== undefined && typeof def.instructions !== "string") {
            throw new Error("Agent instructions must be a string");
        }

        if (def.useCriteria !== undefined && typeof def.useCriteria !== "string") {
            throw new Error("Agent useCriteria must be a string");
        }

        if (def.description !== undefined && typeof def.description !== "string") {
            throw new Error("Agent description must be a string");
        }

        if (def.backend !== undefined && typeof def.backend !== "string") {
            throw new Error("Agent backend must be a string");
        }

        if (def.tools !== undefined && !Array.isArray(def.tools)) {
            throw new Error("Agent tools must be an array");
        }

        if (def.mcp !== undefined && typeof def.mcp !== "boolean") {
            throw new Error("Agent mcp must be a boolean");
        }

        if (def.llmConfig !== undefined && typeof def.llmConfig !== "string") {
            throw new Error("Agent llmConfig must be a string");
        }
    }

    /**
     * Ensure built-in agents are loaded
     */
    private async ensureBuiltInAgents(
        ndkProject?: NDKProject
    ): Promise<void> {
        const builtInAgents = getBuiltInAgents();
        logger.debug(`Loading ${builtInAgents.length} built-in agents`, {
            agentSlugs: builtInAgents.map((a) => a.slug),
        });

        for (const def of builtInAgents) {
            logger.debug(`Loading built-in agent: ${def.slug}`, {
                name: def.name,
                role: def.role,
                tools: def.tools,
            });

            // Check if agent was already loaded from registry
            const existingAgent = this.agents.get(def.slug);
            if (existingAgent) {
                // FIX: Force update the tools for built-in agents
                if (def.tools !== undefined) {
                    const { getTools } = await import("@/tools/registry");
                    existingAgent.tools = getTools(def.tools as any);
                }
                existingAgent.isBuiltIn = true;
            } else {
                // Use ensureAgent just like any other agent
                const agent = await this.ensureAgent(
                    def.slug,
                    {
                        name: def.name,
                        role: def.role,
                        instructions: def.instructions || "",
                        llmConfig: def.llmConfig || DEFAULT_AGENT_LLM_CONFIG,
                        mcp: def.mcp ?? true, // Use agent-specific MCP setting, default to true if not specified
                        tools: def.tools,
                    },
                    ndkProject
                );

                if (!agent) {
                    logger.error(`Failed to load built-in agent: ${def.slug}`);
                } else {
                    agent.isBuiltIn = true;
                }
            }
        }
    }

    /**
     * Republish kind:0 events for all agents
     * This is called when the project boots to ensure agents are discoverable
     */
    async republishAllAgentProfiles(ndkProject: NDKProject): Promise<void> {
        let projectTitle: string;
        let projectEvent: NDKProject;

        // Use passed NDKProject if available, otherwise fall back to ProjectContext
        if (ndkProject) {
            projectTitle = ndkProject.title || '';
            projectEvent = ndkProject;
        } else {
            // Check if project context is initialized
            if (!isProjectContextInitialized()) {
                logger.warn(
                    "ProjectContext not initialized and no NDKProject provided, skipping agent profile republishing"
                );
                return;
            }

            // Get project context for project event and name
            const projectCtx = getProjectContext();
            projectTitle = projectCtx.project.tagValue("title") || "Unknown Project";
            projectEvent = projectCtx.project;
        }

        // Republish kind:0 for each agent
        for (const [slug, agent] of Array.from(this.agents.entries())) {
            try {
                await AgentPublisher.publishAgentProfile(
                    agent.signer,
                    agent.name,
                    agent.role,
                    projectTitle,
                    projectEvent,
                    agent.eventId
                );
            } catch (error) {
                logger.error(`Failed to republish kind:0 for agent: ${slug}`, {
                    error,
                    agentName: agent.name,
                });
                // Continue with other agents even if one fails
            }
        }
    }
}
