import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  AgentConfig,
  AgentConfigOptionalNsec,
  AgentInstance,
  StoredAgentData,
} from "@/agents/types";
import { ensureDirectory, fileExists, readFile, writeJsonFile } from "@/lib/fs";
import { DEFAULT_AGENT_LLM_CONFIG } from "@/llm/constants";
import { AgentPublisher } from "@/nostr/AgentPublisher";
import { configService } from "@/services";
import type { TenexAgents } from "@/services/config/types";
// Tool type removed - using AI SDK tools only
import { formatAnyError } from "@/utils/error-formatter";
import { logger } from "@/utils/logger";
import { type NDKProject, type NDKEvent } from "@nostr-dev-kit/ndk";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { CORE_AGENT_TOOLS, getDefaultToolsForAgent, DELEGATE_TOOLS, getDelegateToolsForAgent, PHASE_MANAGEMENT_TOOLS } from "./constants";
import { isValidToolName } from "@/tools/registry";
import { mcpService } from "@/services/mcp/MCPManager";

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

  /**
   * Get the base path for the project
   */
  getBasePath(): string {
    // If basePath already includes .tenex, extract the project path
    if (this.basePath.endsWith(".tenex")) {
      return path.dirname(this.basePath);
    }
    return this.basePath;
  }

  async loadFromProject(ndkProject?: NDKProject): Promise<void> {
    // Ensure .tenex directory exists
    const tenexDir = this.basePath.endsWith(".tenex")
      ? this.basePath
      : path.join(this.basePath, ".tenex");
    await ensureDirectory(tenexDir);
    await ensureDirectory(this.agentsDir);

    // Store the NDKProject for PM determination
    this.ndkProject = ndkProject;

    // Load agents using ConfigService
    try {
      // Load global agents first if we're in a project context
      if (!this.isGlobal) {
        try {
          this.globalRegistry = await configService.loadTenexAgents(configService.getGlobalPath());
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
          await this.loadAgentBySlugInternal(slug, true);
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
        await this.loadAgentBySlugInternal(slug, false);
      }
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
            logger.info(
              `Agent with eventId ${config.eventId} already exists globally as "${globalSlug}", using global agent`,
              {
                localSlug: name,
                globalSlug,
              }
            );
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
      const nsec = signer.nsec;

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


      // Save agent definition to file
      agentDefinition = {
        name: config.name,
        role: config.role,
        description: config.description,
        instructions: config.instructions,
        useCriteria: config.useCriteria,
        llmConfig: config.llmConfig,
        phase: config.phase,
        phases: config.phases,
      };

      // Include tools if explicitly provided
      if (config.tools !== undefined) {
        agentDefinition.tools = config.tools;
      }

      const definitionPath = path.join(this.agentsDir, fileName);
      await writeJsonFile(definitionPath, agentDefinition);

      this.registry[name] = registryEntry;
      await this.saveRegistry();

      logger.info(`Created new agent "${name}" with nsec`);

      // Publish kind:0 and request events for new agent
      const { nsec: _, ...configWithoutNsec } = config;
      await this.publishAgentEvents(signer, configWithoutNsec, registryEntry.eventId, ndkProject);
    } else {
      // Load agent definition from file
      const definitionPath = path.join(this.agentsDir, registryEntry.file);
      if (await fileExists(definitionPath)) {
        const content = await readFile(definitionPath, "utf-8");
        try {
          agentDefinition = JSON.parse(content);


          this.validateAgentDefinition(agentDefinition);
        } catch (error) {
          logger.error("Failed to parse or validate agent definition", {
            file: registryEntry.file,
            error,
          });
          throw new Error(`Invalid agent definition in ${registryEntry.file}: ${error}`);
        }
      } else {

        // Fallback: create definition from config if file doesn't exist (only include defined fields)
        agentDefinition = {
          name: config.name,
          role: config.role,
          ...(config.description !== undefined && { description: config.description }),
          ...(config.instructions !== undefined && { instructions: config.instructions }),
          ...(config.useCriteria !== undefined && { useCriteria: config.useCriteria }),
          ...(config.llmConfig !== undefined && { llmConfig: config.llmConfig }),
          ...(config.phase !== undefined && { phase: config.phase }),
          ...(config.phases !== undefined && { phases: config.phases }),
        };
        await writeJsonFile(definitionPath, agentDefinition);
      }
    }

    // Create NDKPrivateKeySigner - generate new if nsec is empty
    let nsec = registryEntry.nsec;
    if (!nsec || nsec === "") {
      logger.warn(`Agent "${name}" has empty nsec, generating new one`);
      const newSigner = NDKPrivateKeySigner.generate();
      nsec = newSigner.nsec;
      
      // Update the registry with the new nsec
      registryEntry.nsec = nsec;
      this.registry[name] = registryEntry;
      await this.saveRegistry();
    }
    const signer = new NDKPrivateKeySigner(nsec);

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

  /**
   * Get agents filtered by phase
   * @param phase - The phase to filter by (undefined returns agents without a phase)
   * @returns Array of agents matching the phase
   */
  getAgentsByPhase(phase: string | undefined): AgentInstance[] {
    const agents = Array.from(this.agents.values());
    
    if (phase === undefined) {
      // Return agents without a specific phase (universal agents)
      return agents.filter(agent => !agent.phase);
    }
    
    // Return agents matching the phase or universal agents
    const { normalizePhase } = require("@/conversations/utils/phaseUtils");
    const normalizedPhase = normalizePhase(phase);
    
    return agents.filter(agent => {
      if (!agent.phase) return true; // Universal agents work in all phases
      const agentPhase = normalizePhase(agent.phase);
      return agentPhase === normalizedPhase;
    });
  }
  
  /**
   * Set the PM for this project - updates registry and reassigns delegate tools
   * Note: This is synchronous. Call persistPMStatus() to save to disk.
   */
  setPMPubkey(pubkey: string): void {
    // Clear any existing PM flags in both registries
    for (const entry of Object.values(this.registry)) {
      delete entry.isPM;
    }
    for (const entry of Object.values(this.globalRegistry)) {
      delete entry.isPM;
    }
    
    // Find the agent with this pubkey
    const agentToSetAsPM = this.agentsByPubkey.get(pubkey);
    if (!agentToSetAsPM) {
      logger.error(`Failed to set PM - no agent found with pubkey ${pubkey}`);
      return;
    }
    
    // Find which registry contains this agent and set the flag
    let foundPM = false;
    for (const [slug, agent] of this.agents) {
      if (agent.pubkey === pubkey) {
        // Check both registries
        const registry = agent.isGlobal ? this.globalRegistry : this.registry;
        const registryEntry = registry[slug];
        if (registryEntry) {
          registryEntry.isPM = true;
          foundPM = true;
          break;
        }
      }
    }
    
    if (!foundPM) {
      logger.error(`Failed to set PM - agent not found in registry`);
      return;
    }
    
    // Reassign delegate tools for all loaded agents
    for (const agent of this.agents.values()) {
      agent.tools = agent.tools.filter(t => !DELEGATE_TOOLS.includes(t));
      const delegateTools = getDelegateToolsForAgent(agent);
      agent.tools.push(...delegateTools);
    }
    
    logger.info(`Set PM to ${pubkey} and reassigned delegate tools`);
  }
  
  /**
   * Persist PM status to disk
   */
  async persistPMStatus(): Promise<void> {
    await this.saveRegistry();
    if (!this.isGlobal) {
      // Only save global registry if we modified it
      for (const entry of Object.values(this.globalRegistry)) {
        if (entry.isPM) {
          await this.saveGlobalRegistry();
          break;
        }
      }
    }
  }


  private async saveRegistry(): Promise<void> {
    if (this.isGlobal) {
      await configService.saveGlobalAgents(this.registry);
    } else {
      await configService.saveProjectAgents(this.basePath, this.registry);
    }
  }
  
  private async saveGlobalRegistry(): Promise<void> {
    await configService.saveGlobalAgents(this.globalRegistry);
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


    // Don't allow removing global agents from a project context
    if (agentToRemove.isGlobal && !this.isGlobal) {
      logger.warn(`Cannot remove global agent ${agentSlugToRemove} from project context. Remove it globally instead.`);
      return false;
    }

    // Remove from memory
    this.agents.delete(agentSlugToRemove);
    this.agentsByPubkey.delete(agentToRemove.pubkey);

    // Find registry info using pubkey to ensure we get the right registry
    const registryInfo = this.findRegistryEntryByPubkey(agentToRemove.pubkey);
    if (registryInfo) {
      // Delete the agent definition file
      try {
        const filePath = path.join(registryInfo.agentsDir, registryInfo.entry.file);
        await fs.unlink(filePath);
        logger.info(`Deleted agent definition file: ${filePath}`);
      } catch (error) {
        logger.warn("Failed to delete agent definition file", {
          error,
          slug: agentSlugToRemove,
        });
      }

      // Remove from the appropriate registry and save
      delete registryInfo.registry[agentSlugToRemove];
      
      // Save the appropriate registry
      if (registryInfo.registry === this.globalRegistry) {
        await this.saveGlobalRegistry();
      } else {
        await this.saveRegistry();
      }
    }

    logger.info(`Removed agent ${agentSlugToRemove} (eventId: ${eventId})`);
    return true;
  }


  /**
   * Find registry entry and path for an agent by its public key
   * Checks both local and global registries
   */
  private findRegistryEntryByPubkey(agentPubkey: string): {
    entry: TenexAgents[string];
    registry: TenexAgents;
    agentsDir: string;
    slug: string;
  } | null {
    // Check local registry first
    for (const [slug, entry] of Object.entries(this.registry)) {
      // Get the pubkey from the nsec
      try {
        const signer = new NDKPrivateKeySigner(entry.nsec);
        if (signer.pubkey === agentPubkey) {
          return {
            entry,
            registry: this.registry,
            agentsDir: this.agentsDir,
            slug,
          };
        }
      } catch (error) {
        logger.debug("Failed to decode nsec for registry entry", { slug, error });
      }
    }

    // Check global registry if not found locally
    if (!this.isGlobal) {
      for (const [slug, entry] of Object.entries(this.globalRegistry)) {
        try {
          const signer = new NDKPrivateKeySigner(entry.nsec);
          if (signer.pubkey === agentPubkey) {
            const globalPath = configService.getGlobalPath();
            return {
              entry,
              registry: this.globalRegistry,
              agentsDir: path.join(globalPath, "agents"),
              slug,
            };
          }
        } catch (error) {
          logger.debug("Failed to decode nsec for global registry entry", { slug, error });
        }
      }
    }

    return null;
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

    // Find the registry entry by pubkey
    const registryInfo = this.findRegistryEntryByPubkey(agentPubkey);
    if (!registryInfo) {
      logger.warn(`Registry entry not found for agent with pubkey ${agentPubkey}`);
      return false;
    }

    // Update the agent definition file
    try {
      const definitionPath = path.join(registryInfo.agentsDir, registryInfo.entry.file);

      // Read existing definition
      let agentDefinition: StoredAgentData;
      try {
        const content = await fs.readFile(definitionPath, "utf-8");
        agentDefinition = JSON.parse(content);
      } catch (error) {
        logger.warn("Failed to read agent definition, creating from current state", {
          file: registryInfo.entry.file,
          error,
        });
        // Create definition from current agent state
        agentDefinition = {
          name: agent.name,
          role: agent.role,
          description: agent.description,
          instructions: agent.instructions,
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
        file: registryInfo.entry.file,
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
   * Normalize agent tools by applying business rules:
   * - Remove delegation and phase management tools from requested tools (they're added based on phases)
   * - Add appropriate delegation and phase management tools based on phases
   * - Ensure core tools are always present
   * @param requestedTools - Tools requested/configured for the agent
   * @param agent - The agent instance (or partial agent with phases)
   * @returns Normalized array of tool names
   */
  private normalizeAgentTools(requestedTools: string[], agent: { phases?: Record<string, string> }): string[] {
    // Filter out delegation and phase management tools - they should never be in configuration
    const toolNames = requestedTools.filter(tool =>
      !DELEGATE_TOOLS.includes(tool) &&
      !PHASE_MANAGEMENT_TOOLS.includes(tool)
    );

    // Add the correct delegation and phase management tools based on phases
    const delegateTools = getDelegateToolsForAgent(agent);
    toolNames.push(...delegateTools);

    // Ensure core tools are always included for ALL agents
    for (const coreTool of CORE_AGENT_TOOLS) {
      if (!toolNames.includes(coreTool)) {
        toolNames.push(coreTool);
      }
    }

    return toolNames;
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

    // Find the registry entry by pubkey to get PM status
    const registryInfo = this.findRegistryEntryByPubkey(agentPubkey);
    if (!registryInfo) {
      logger.warn(`Registry entry not found for agent with pubkey ${agentPubkey}`);
      return false;
    }

    // Normalize tools according to business rules (delegation tools, core tools, etc.)
    const normalizedTools = this.normalizeAgentTools(newToolNames, agent);

    // Validate the normalized tool names
    const validToolNames = normalizedTools.filter(isValidToolName);
    
    // Update the agent tools in memory
    agent.tools = validToolNames;

    // Update the agent definition file
    try {
      const definitionPath = path.join(registryInfo.agentsDir, registryInfo.entry.file);

      // Read existing definition
      let agentDefinition: StoredAgentData;
      try {
        const content = await fs.readFile(definitionPath, "utf-8");
        agentDefinition = JSON.parse(content);
      } catch (error) {
        logger.warn("Failed to read agent definition, creating from current state", {
          file: registryInfo.entry.file,
          error,
        });
        // Create definition from current agent state
        agentDefinition = {
          name: agent.name,
          role: agent.role,
          description: agent.description,
          instructions: agent.instructions,
          useCriteria: agent.useCriteria,
          llmConfig: agent.llmConfig,
          tools: newToolNames,
        };
      }

      // Update the tools
      agentDefinition.tools = newToolNames;

      // Save the updated definition
      await writeJsonFile(definitionPath, agentDefinition);

      logger.debug(`Persisted tools to ${registryInfo.entry.file}`, {
        agent: agent.slug,
        toolCount: newToolNames.length,
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

      // Require NDKProject to be passed
      if (!ndkProject) {
        logger.warn(
          "No NDKProject provided, skipping agent event publishing"
        );
        return;
      }
      
      projectTitle = ndkProject.tagValue("title") || "Unknown Project";
      projectEvent = ndkProject;

      // Publish agent profile (kind:0) and request event using static method
      // The publishAgentCreation method now handles passing metadata for agents without eventId
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

  private async loadAgentBySlugInternal(
    slug: string,
    fromGlobal = false
  ): Promise<AgentInstance | null> {
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
      // Missing file is not an error - it's a cache miss that will trigger fetch from Nostr
      logger.debug(`Agent definition file not found (cache miss): ${definitionPath}`);
      return null;
    }

    const content = await readFile(definitionPath, "utf-8");
    let agentDefinition: StoredAgentData;
    try {
      agentDefinition = JSON.parse(content);


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
      instructions: agentDefinition.instructions,
      useCriteria: agentDefinition.useCriteria,
      nsec: registryEntry.nsec,
      eventId: registryEntry.eventId,
      tools: agentDefinition.tools, // Preserve explicit tools configuration
      mcp: agentDefinition.mcp, // Preserve MCP configuration
      llmConfig: agentDefinition.llmConfig,
      phase: agentDefinition.phase,
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

    // Create Agent instance with all properties set
    const agent: AgentInstance = {
      name: agentDefinition.name,
      pubkey,
      signer,
      role: agentDefinition.role,
      description: agentDefinition.description,
      instructions: agentDefinition.instructions,
      useCriteria: agentDefinition.useCriteria,
      llmConfig: agentDefinition.llmConfig || DEFAULT_AGENT_LLM_CONFIG,
      tools: [], // Will be set next
      mcp: agentDefinition.mcp ?? true, // Default to true for all agents
      eventId: registryEntry.eventId,
      slug: slug,
      isGlobal: isGlobal,
      phase: agentDefinition.phase,
      phases: agentDefinition.phases,
      createMetadataStore: (conversationId: string) => {
        const { AgentMetadataStore } = require('@/conversations/services/AgentMetadataStore');
        // Use the registry's basePath to get the project path
        const projectPath = this.getBasePath();
        return new AgentMetadataStore(conversationId, slug, projectPath);
      },
      sign: async (event: NDKEvent) => {
        // Sign the event with pTags: false to prevent automatic p-tag addition
        await event.sign(signer, { pTags: false });
      }
    };

    // Set tools - use explicit tools if configured, otherwise use defaults
    const requestedTools =
      agentDefinition.tools !== undefined ? agentDefinition.tools : getDefaultToolsForAgent(agent);
    
    // Normalize tools according to business rules (delegation tools, core tools, etc.)
    const toolNames = this.normalizeAgentTools(requestedTools, agent);

    // Validate tool names - we now store tool names as strings, not instances
    const validToolNames: string[] = [];
    const unknownTools: string[] = [];
    const requestedMcpTools: string[] = [];
    const unknownNonMcpTools: string[] = [];
    
    for (const toolName of toolNames) {
      if (isValidToolName(toolName)) {
        validToolNames.push(toolName);
      } else {
        // Check if it's an MCP tool (starts with "mcp__")
        if (toolName.startsWith("mcp__")) {
          requestedMcpTools.push(toolName);
        } else {
          unknownNonMcpTools.push(toolName);
          unknownTools.push(toolName);
        }
      }
    }
    
    // Handle MCP tools if agent has MCP access
    if (agent.mcp !== false && requestedMcpTools.length > 0) {
      try {
        const allMcpTools = mcpService.getCachedTools();
        
        // Check which requested MCP tools are available
        const availableMcpToolNames: string[] = [];
        const unavailableMcpTools: string[] = [];
        
        for (const toolName of requestedMcpTools) {
          if (allMcpTools[toolName]) {
            availableMcpToolNames.push(toolName);
            validToolNames.push(toolName);
          } else {
            unavailableMcpTools.push(toolName);
          }
        }
        
        if (unavailableMcpTools.length > 0) {
          logger.debug(`Agent "${slug}" requested MCP tools not yet available:`, unavailableMcpTools);
        }
      } catch (error) {
        logger.debug(`Could not load MCP tools for agent "${slug}":`, error);
      }
    } else if (agent.mcp !== false) {
      // Agent has MCP access but didn't request specific tools - give access to all
      try {
        const allMcpTools = mcpService.getCachedTools();
        for (const toolName of Object.keys(allMcpTools)) {
          validToolNames.push(toolName);
        }
      } catch (error) {
        logger.debug(`Could not load MCP tools for agent "${slug}":`, error);
      }
    }
    
    // Log warnings for unknown non-MCP tools
    if (unknownNonMcpTools.length > 0) {
      logger.warn(`Agent "${slug}" requested unknown tools:`, unknownNonMcpTools);
    }
    
    agent.tools = validToolNames;
    
    // Store the full list of requested tools (including unknown ones) in the agent definition
    // This ensures MCP tools are preserved even if not currently installed
    if (agentDefinition.tools !== undefined) {
      agentDefinition.tools = toolNames;
    }

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
    // Create NDKPrivateKeySigner - generate new if nsec is empty
    let nsec = registryEntry.nsec;
    if (!nsec || nsec === "") {
      logger.warn(`Agent "${slug}" has empty nsec in createAgentInstance, generating new one`);
      const newSigner = NDKPrivateKeySigner.generate();
      nsec = newSigner.nsec;
      
      // Update the registry with the new nsec
      registryEntry.nsec = nsec;
      this.registry[slug] = registryEntry;
      await this.saveRegistry();
    }
    const signer = new NDKPrivateKeySigner(nsec);

    // Create agent definition from config (only include defined fields)
    const agentDefinition: StoredAgentData = {
      name: config.name,
      role: config.role,
      ...(config.description !== undefined && { description: config.description }),
      ...(config.instructions !== undefined && { instructions: config.instructions }),
      ...(config.useCriteria !== undefined && { useCriteria: config.useCriteria }),
      ...(config.llmConfig !== undefined && { llmConfig: config.llmConfig }),
      ...(config.tools !== undefined && { tools: config.tools }),
      ...(config.mcp !== undefined && { mcp: config.mcp }),
      ...(config.phase !== undefined && { phase: config.phase }),
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

    // Optional fields with type validation (null is allowed for all nullable fields)
    if (def.instructions !== undefined && def.instructions !== null && typeof def.instructions !== "string") {
      throw new Error("Agent instructions must be a string");
    }

    if (def.useCriteria !== undefined && def.useCriteria !== null && typeof def.useCriteria !== "string") {
      throw new Error("Agent useCriteria must be a string");
    }

    if (def.description !== undefined && def.description !== null && typeof def.description !== "string") {
      throw new Error("Agent description must be a string");
    }

    if (def.backend !== undefined && def.backend !== null && typeof def.backend !== "string") {
      throw new Error("Agent backend must be a string");
    }

    if (def.tools !== undefined && def.tools !== null && !Array.isArray(def.tools)) {
      throw new Error("Agent tools must be an array");
    }

    if (def.mcp !== undefined && def.mcp !== null && typeof def.mcp !== "boolean") {
      throw new Error("Agent mcp must be a boolean");
    }

    if (def.llmConfig !== undefined && def.llmConfig !== null && typeof def.llmConfig !== "string") {
      throw new Error("Agent llmConfig must be a string");
    }
  }

  /**
   * Republish kind:0 events for all agents
   * This is called when the project boots to ensure agents are discoverable
   */
  async republishAllAgentProfiles(ndkProject: NDKProject): Promise<void> {
    let projectTitle: string;
    let projectEvent: NDKProject;

    // NDKProject is required
    projectTitle = ndkProject.tagValue("title") || "Unknown Project";
    projectEvent = ndkProject;

    // Republish kind:0 for each agent
    for (const [slug, agent] of Array.from(this.agents.entries())) {
      try {
        // Prepare metadata for agents without NDKAgentDefinition
        const agentMetadata = !agent.eventId ? {
          description: agent.description,
          instructions: agent.instructions,
          useCriteria: agent.useCriteria,
          phases: agent.phases
        } : undefined;

        await AgentPublisher.publishAgentProfile(
          agent.signer,
          agent.name,
          agent.role,
          projectTitle,
          projectEvent,
          agent.eventId,
          agentMetadata
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
