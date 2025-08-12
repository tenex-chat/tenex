import { formatAnyError } from "@/utils/error-formatter";
import fs from "node:fs/promises";
import path from "node:path";
import { AgentPublisher } from "@/agents/AgentPublisher";
import type { AgentInstance, AgentConfig, AgentConfigOptionalNsec, StoredAgentData } from "@/agents/types";
import { ensureDirectory, fileExists, readFile, writeJsonFile } from "@/lib/fs";
import { DEFAULT_AGENT_LLM_CONFIG } from "@/llm/constants";
import { getNDK } from "@/nostr";
import { configService } from "@/services";
import { getProjectContext, isProjectContextInitialized } from "@/services";
import type { TenexAgents } from "@/services/config/types";
import { logger } from "@/utils/logger";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import type { NDKProject } from "@nostr-dev-kit/ndk";
import { getBuiltInAgents } from "./builtInAgents";
import { getDefaultToolsForAgent } from "./constants";
import { isToollessBackend } from "./utils";

export class AgentRegistry {
    private agents: Map<string, AgentInstance> = new Map();
    private agentsByPubkey: Map<string, AgentInstance> = new Map();
    private registryPath: string;
    private agentsDir: string;
    private registry: TenexAgents = {};
    private globalRegistry: TenexAgents = {};
    private isGlobal: boolean;

    constructor(
        private basePath: string,
        isGlobal = false
    ) {
        this.isGlobal = isGlobal;
        // If basePath already includes .tenex, use it as is
        if (basePath.endsWith(".tenex")) {
            this.registryPath = path.join(basePath, "agents.json");
            this.agentsDir = path.join(basePath, "agents");
        } else {
            this.registryPath = path.join(basePath, ".tenex", "agents.json");
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
                    logger.info(`Loaded ${Object.keys(this.globalRegistry).length} global agents`, {
                        globalAgents: Object.keys(this.globalRegistry),
                    });
                } catch (error) {
                    logger.debug("No global agents found or failed to load", { error });
                    this.globalRegistry = {};
                }
            }

            // Load project/local agents
            this.registry = await configService.loadTenexAgents(tenexDir);
            logger.info(
                `Loaded agent registry with ${Object.keys(this.registry).length} agents via ConfigService`,
                {
                    registryKeys: Object.keys(this.registry),
                    basePath: this.basePath,
                    isGlobal: this.isGlobal,
                }
            );

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
            logger.debug("Loading built-in agents");
            await this.ensureBuiltInAgents(ndkProject);

            logger.info(`Loaded ${this.agents.size} agents into runtime`, {
                agentSlugs: Array.from(this.agents.keys()),
                agentsByPubkey: this.agentsByPubkey.size,
            });
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
                backend: config.backend,
            };

            // Only include tools if explicitly provided
            if (config.tools && config.tools.length > 0) {
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
                        if (!agentDefinition.backend && builtInAgent.backend) {
                            agentDefinition.backend = builtInAgent.backend;
                        }
                        if (!agentDefinition.name) {
                            agentDefinition.name = builtInAgent.name;
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
                    backend: config.backend,
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
        const pubkey = signer.pubkey;

        // Determine agent name - use project name for project-manager agent
        let agentName = agentDefinition.name;
        const isProjectManager = name === "project-manager";
        
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
        } else if (registryEntry.orchestratorAgent && name !== "orchestrator") {
            // Keep support for custom orchestrator agents using project name
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

        // Determine if this is a built-in agent early
        const isBuiltIn = getBuiltInAgents().some((builtIn) => builtIn.slug === name);

        // Create Agent instance with all properties set
        const agent: AgentInstance = {
            name: agentName,
            pubkey,
            signer,
            role: agentDefinition.role,
            description: agentDefinition.description,
            instructions: agentDefinition.instructions,
            useCriteria: agentDefinition.useCriteria,
            llmConfig: agentDefinition.llmConfig || DEFAULT_AGENT_LLM_CONFIG,
            tools: [], // Will be set next
            mcp: agentDefinition.mcp ?? !registryEntry.orchestratorAgent, // Default to true for non-orchestrator agents
            eventId: registryEntry.eventId,
            slug: name,
            isOrchestrator: registryEntry.orchestratorAgent,
            isBuiltIn: isBuiltIn, // Set the isBuiltIn property here
            backend: agentDefinition.backend, // Propagate backend configuration
            isGlobal: fromGlobal, // Track if agent is from global configuration
        };

        // Set tools - use explicit tools if configured, otherwise use defaults
        let toolNames: string[];
        if (isToollessBackend(agent)) {
            // Claude and routing backend agents don't use tools through the traditional tool system
            toolNames = [];
        } else {
            toolNames =
                agentDefinition.tools !== undefined
                    ? agentDefinition.tools
                    : getDefaultToolsForAgent(agent);
        }

        // Convert tool names to Tool instances
        const { getTools } = await import("@/tools/registry");
        agent.tools = getTools(toolNames);

        // Store in both maps
        this.agents.set(name, agent);
        this.agentsByPubkey.set(pubkey, agent);

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
                    backend: agent.backend,
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
     * Get the orchestrator agent if one exists
     */
    getOrchestratorAgent(): AgentInstance | undefined {
        // Look for the orchestrator by slug first (for built-in orchestrator)
        const orchestrator = this.agents.get("orchestrator");
        if (orchestrator) return orchestrator;

        // Fallback to looking for any agent marked as orchestrator
        for (const [slug, registryEntry] of Object.entries(this.registry)) {
            if (registryEntry.orchestratorAgent) {
                return this.agents.get(slug);
            }
        }
        return undefined;
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

            const ndk = getNDK();

            // Create agent publisher
            const publisher = new AgentPublisher(ndk);

            // Publish agent profile (kind:0) and request event
            await publisher.publishAgentCreation(
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
                if (!agentDefinition.backend && builtInAgent.backend) {
                    agentDefinition.backend = builtInAgent.backend;
                }
                if (!agentDefinition.name) {
                    agentDefinition.name = builtInAgent.name;
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
            backend: agentDefinition.backend,
        };

        // If loading from global registry, create agent directly without recursive ensureAgent call
        if (fromGlobal) {
            return this.createAgentInstance(slug, config, registryEntry);
        }

        return this.ensureAgent(slug, config, undefined, fromGlobal);
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
        const pubkey = signer.pubkey;

        // Determine agent name
        let agentName = config.name;
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
                agentName = config.name;
            }
        }

        // Determine if this is a built-in agent
        const isBuiltIn = getBuiltInAgents().some((builtIn) => builtIn.slug === slug);

        // Create Agent instance
        const agent: AgentInstance = {
            name: agentName,
            pubkey,
            signer,
            role: config.role,
            description: config.description,
            instructions: config.instructions || "",
            useCriteria: config.useCriteria,
            llmConfig: config.llmConfig || DEFAULT_AGENT_LLM_CONFIG,
            tools: [], // Will be set next
            mcp: config.mcp ?? !registryEntry.orchestratorAgent,
            eventId: registryEntry.eventId,
            slug: slug,
            isOrchestrator: registryEntry.orchestratorAgent,
            isBuiltIn: isBuiltIn,
            backend: config.backend,
            isGlobal: true, // createAgentInstance is only called for global agents
        };

        // Set tools
        let toolNames: string[];
        if (isToollessBackend(agent)) {
            toolNames = [];
        } else {
            toolNames = config.tools !== undefined
                ? config.tools
                : getDefaultToolsForAgent(agent);
        }

        // Convert tool names to Tool instances
        const { getTools } = await import("@/tools/registry");
        agent.tools = getTools(toolNames);

        // Store in both maps
        this.agents.set(slug, agent);
        this.agentsByPubkey.set(pubkey, agent);

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
            // Check if this is the orchestrator
            const isOrchestrator = def.slug === "orchestrator";

            logger.debug(`Loading built-in agent: ${def.slug}`, {
                name: def.name,
                role: def.role,
                isOrchestrator,
            });

            // Use ensureAgent just like any other agent
            const agent = await this.ensureAgent(
                def.slug,
                {
                    name: def.name,
                    role: def.role,
                    instructions: def.instructions || "",
                    llmConfig: def.llmConfig || DEFAULT_AGENT_LLM_CONFIG,
                    mcp: !isOrchestrator, // Default: true for all agents except orchestrator
                    backend: def.backend,
                },
                ndkProject
            );

            // Mark as built-in and set orchestrator flag
            if (agent) {
                agent.isBuiltIn = true;
                agent.isOrchestrator = isOrchestrator;

                // Update registry to mark orchestrator
                const registryEntry = this.registry[def.slug];
                if (isOrchestrator && registryEntry) {
                    registryEntry.orchestratorAgent = true;
                    await this.saveRegistry();
                }
            } else {
                logger.error(`Failed to load built-in agent: ${def.slug}`);
            }
        }
    }

    /**
     * Republish kind:0 events for all agents
     * This is called when the project boots to ensure agents are discoverable
     */
    async republishAllAgentProfiles(ndkProject?: NDKProject): Promise<void> {
        logger.info("Republishing kind:0 events for all agents", {
            agentCount: this.agents.size,
        });

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
                    "ProjectContext not initialized and no NDKProject provided, skipping agent profile republishing"
                );
                return;
            }

            // Get project context for project event and name
            const projectCtx = getProjectContext();
            projectTitle = projectCtx.project.tagValue("title") || "Unknown Project";
            projectEvent = projectCtx.project;
        }

        const ndk = getNDK();
        const publisher = new AgentPublisher(ndk);

        // Republish kind:0 for each agent
        for (const [slug, agent] of this.agents) {
            try {
                await publisher.publishAgentProfile(
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
