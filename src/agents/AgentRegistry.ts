import type {
  AgentConfigOptionalNsec,
  AgentInstance,
} from "@/agents/types";
import { DEFAULT_AGENT_LLM_CONFIG } from "@/llm/constants";
import { AgentPublisher } from "@/nostr/AgentPublisher";
import { getProjectContext } from "@/services";
import { formatAnyError } from "@/utils/error-formatter";
import { logger } from "@/utils/logger";
import { type NDKProject, type NDKEvent } from "@nostr-dev-kit/ndk";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { CORE_AGENT_TOOLS, getDefaultToolsForAgent, DELEGATE_TOOLS, getDelegateToolsForAgent, PHASE_MANAGEMENT_TOOLS } from "./constants";
import { isValidToolName } from "@/tools/registry";
import { mcpService } from "@/services/mcp/MCPManager";
import { normalizePhase } from "@/conversations/utils/phaseUtils";
import { AgentMetadataStore } from "@/conversations/services/AgentMetadataStore";
import { agentStorage, type StoredAgent } from "./AgentStorage";
import { configService } from "@/services";
import { installAgentFromEvent } from "@/utils/agentInstaller";
import { getNDK } from "@/nostr";

/**
 * AgentRegistry manages agent configuration and instances for a project.
 * Uses the new simplified storage model where all agents are stored in ~/.tenex/agents/
 */
export class AgentRegistry {
  private agents: Map<string, AgentInstance> = new Map();
  private agentsByPubkey: Map<string, AgentInstance> = new Map();
  private projectDTag: string | undefined;
  private projectPath: string;
  private ndkProject?: NDKProject;
  private pmPubkey?: string;

  /**
   * Creates a new AgentRegistry instance.
   * @param projectPath - Base directory path for the project
   */
  constructor(projectPath: string) {
    this.projectPath = projectPath;
  }

  /**
   * Get the base path for this project
   */
  getBasePath(): string {
    return this.projectPath;
  }

  /**
   * Load agents for a project from storage and Nostr.
   * This method handles the complete agent loading workflow:
   * 1. Load agents from local storage
   * 2. For missing agents, fetch from Nostr and install
   * 3. Load newly installed agents
   */
  async loadFromProject(ndkProject: NDKProject): Promise<void> {
    this.ndkProject = ndkProject;
    this.projectDTag = ndkProject.dTag;

    if (!this.projectDTag) {
      logger.error("Project missing dTag", { projectId: ndkProject.id });
      return;
    }

    // Clear existing agents to ensure fresh load from project tags
    this.agents.clear();
    this.agentsByPubkey.clear();

    // Initialize storage
    await agentStorage.initialize();

    // Get agent event IDs from project tags
    const agentEventIds = ndkProject.tags
      .filter((t) => t[0] === "agent" && t[1])
      .map((t) => t[1])
      .filter(Boolean) as string[];

    logger.info(`Loading ${agentEventIds.length} agents for project ${this.projectDTag}`);

    const ndk = getNDK();
    const failedAgents: string[] = [];
    const projectDTag = this.projectDTag; // Capture for type safety

    // Load or install each agent
    for (const eventId of agentEventIds) {
      try {
        let storedAgent = await agentStorage.getAgentByEventId(eventId);

        // If agent not in storage, fetch from Nostr and install
        if (!storedAgent) {
          logger.debug(`Agent ${eventId} not in storage, installing from Nostr`);

          const result = await installAgentFromEvent(
            eventId,
            this.projectPath,
            ndkProject,
            undefined,
            ndk,
            this
          );

          if (!result.success) {
            logger.error(`Failed to install agent ${eventId}: ${result.error}`);
            failedAgents.push(eventId);
            continue;
          }

          // Now it should be in storage
          storedAgent = await agentStorage.getAgentByEventId(eventId);
        }

        if (storedAgent) {
          // Add project to agent if not already there
          if (!storedAgent.projects.includes(projectDTag)) {
            storedAgent.projects.push(projectDTag);
            await agentStorage.saveAgent(storedAgent);
          }

          // Create agent instance
          const instance = await this.createAgentInstance(storedAgent);
          this.agents.set(storedAgent.slug, instance);
          this.agentsByPubkey.set(instance.pubkey, instance);

          logger.debug(`Loaded agent ${storedAgent.slug} for project ${this.projectDTag}`);
        }
      } catch (error) {
        logger.error(`Failed to load agent ${eventId}`, { error });
        failedAgents.push(eventId);
      }
    }

    // Check if critical agents failed
    if (failedAgents.length > 0) {
      // PM is the first agent in tags
      const pmEventId = agentEventIds[0];
      if (failedAgents.includes(pmEventId)) {
        throw new Error(
          "Critical agent failed to load. " +
          `Agent event ID ${pmEventId} could not be fetched. ` +
          "This might be due to network issues or the event not being available on the configured relays."
        );
      }
      logger.warn(`${failedAgents.length} agent(s) could not be installed but continuing with available agents`);
    }

    logger.info(`Loaded ${this.agents.size} agents for project ${this.projectDTag}`);
  }

  /**
   * Ensure an agent exists in the registry and storage
   */
  async ensureAgent(
    slug: string,
    config: AgentConfigOptionalNsec,
    ndkProject?: NDKProject
  ): Promise<AgentInstance> {
    // Check if agent already exists in memory
    const existingAgent = this.agents.get(slug);
    if (existingAgent) {
      return existingAgent;
    }

    // Check storage by slug
    let storedAgent = await agentStorage.getAgentBySlug(slug);

    if (!storedAgent) {
      // Check by eventId if provided
      if (config.eventId) {
        storedAgent = await agentStorage.getAgentByEventId(config.eventId);
      }

      if (!storedAgent) {
        // Create new agent
        const signer = config.nsec
          ? new NDKPrivateKeySigner(config.nsec)
          : NDKPrivateKeySigner.generate();

        storedAgent = {
          eventId: config.eventId,
          nsec: signer.nsec,
          slug,
          name: config.name,
          role: config.role,
          description: config.description,
          instructions: config.instructions,
          useCriteria: config.useCriteria,
          llmConfig: config.llmConfig || DEFAULT_AGENT_LLM_CONFIG,
          tools: config.tools || getDefaultToolsForAgent(config),
          phase: config.phase,
          phases: config.phases,
          projects: this.projectDTag ? [this.projectDTag] : []
        };

        await agentStorage.saveAgent(storedAgent);
        logger.info(`Created new agent "${slug}"`);

        // Publish agent events if we have a project
        if (ndkProject || this.ndkProject) {
          const project = ndkProject || this.ndkProject;
          await this.publishAgentEvents(signer, config, config.eventId, project);
        }
      }
    }

    // Ensure agent is associated with this project
    if (this.projectDTag && !storedAgent.projects.includes(this.projectDTag)) {
      storedAgent.projects.push(this.projectDTag);
      await agentStorage.saveAgent(storedAgent);
    }

    // Create and store agent instance
    const instance = await this.createAgentInstance(storedAgent);
    this.agents.set(slug, instance);
    this.agentsByPubkey.set(instance.pubkey, instance);

    return instance;
  }

  /**
   * Create an AgentInstance from stored agent data
   */
  private async createAgentInstance(storedAgent: StoredAgent): Promise<AgentInstance> {
    const signer = new NDKPrivateKeySigner(storedAgent.nsec);
    const pubkey = signer.pubkey;

    // Normalize tools
    const toolNames = this.normalizeAgentTools(
      storedAgent.tools || [],
      storedAgent
    );

    // Validate and filter tools
    const validToolNames: string[] = [];
    const requestedMcpTools: string[] = [];

    for (const toolName of toolNames) {
      if (isValidToolName(toolName)) {
        validToolNames.push(toolName);
      } else if (toolName.startsWith("mcp__")) {
        requestedMcpTools.push(toolName);
      }
    }

    // Add MCP tools if available
    if (requestedMcpTools.length > 0) {
      try {
        const allMcpTools = mcpService.getCachedTools();
        for (const toolName of requestedMcpTools) {
          if (allMcpTools[toolName]) {
            validToolNames.push(toolName);
          }
        }
      } catch (error) {
        logger.debug(`Could not load MCP tools for agent "${storedAgent.slug}":`, error);
      }
    }

    const agent: AgentInstance = {
      name: storedAgent.name,
      pubkey,
      signer,
      role: storedAgent.role,
      description: storedAgent.description,
      instructions: storedAgent.instructions,
      useCriteria: storedAgent.useCriteria,
      llmConfig: storedAgent.llmConfig || DEFAULT_AGENT_LLM_CONFIG,
      tools: validToolNames,
      eventId: storedAgent.eventId,
      slug: storedAgent.slug,
      phase: storedAgent.phase,
      phases: storedAgent.phases,
      createMetadataStore: (conversationId: string) => {
        return new AgentMetadataStore(conversationId, storedAgent.slug, this.projectPath);
      },
      createLLMService: (options) => {
        const projectCtx = getProjectContext();
        const llmLogger = projectCtx.llmLogger.withAgent(storedAgent.name);
        return configService.createLLMService(
          llmLogger,
          agent.llmConfig || DEFAULT_AGENT_LLM_CONFIG,
          {
            tools: options?.tools ?? {},
            agentName: storedAgent.name,
            sessionId: options?.sessionId
          }
        );
      },
      sign: async (event: NDKEvent) => {
        await event.sign(signer, { pTags: false });
      }
    };

    return agent;
  }

  /**
   * Get an agent by slug
   */
  getAgent(slug: string): AgentInstance | undefined {
    return this.agents.get(slug);
  }

  /**
   * Get an agent by public key
   */
  getAgentByPubkey(pubkey: string): AgentInstance | undefined {
    return this.agentsByPubkey.get(pubkey);
  }

  /**
   * Get all agents for the current project
   */
  getAllAgents(): AgentInstance[] {
    return Array.from(this.agents.values());
  }

  /**
   * Get all agents as a map
   */
  getAllAgentsMap(): Map<string, AgentInstance> {
    return new Map(this.agents);
  }

  /**
   * Get agents filtered by phase
   */
  getAgentsByPhase(phase: string | undefined): AgentInstance[] {
    const agents = Array.from(this.agents.values());

    if (phase === undefined) {
      // Return agents without a specific phase (universal agents)
      return agents.filter(agent => !agent.phase);
    }

    // Return agents matching the phase or universal agents
    const normalizedPhase = normalizePhase(phase);

    return agents.filter(agent => {
      if (!agent.phase) return true; // Universal agents work in all phases
      const agentPhase = normalizePhase(agent.phase);
      return agentPhase === normalizedPhase;
    });
  }

  /**
   * Get the Project Manager (PM) for this project
   * PM is the first agent in the project's agent tags
   */
  getProjectPM(): AgentInstance | undefined {
    if (!this.ndkProject) return undefined;

    const firstAgentEventId = this.ndkProject.tags
      .find(t => t[0] === "agent" && t[1])?.[1];

    if (!firstAgentEventId) return undefined;

    // Find agent with this eventId
    for (const agent of this.agents.values()) {
      if (agent.eventId === firstAgentEventId) {
        return agent;
      }
    }

    return undefined;
  }

  /**
   * Set which agent is the Project Manager and update delegate tools accordingly
   * This method is called by ProjectContext to inform the registry of the PM
   */
  setPMPubkey(pubkey: string): void {
    this.pmPubkey = pubkey;

    // Update delegate tools for all agents based on PM status
    for (const agent of this.agents.values()) {
      if (agent.pubkey === pubkey) {
        // This is the PM - ensure they have delegate tools based on phases
        const delegateTools = getDelegateToolsForAgent(agent);

        // Add delegate tools if not already present
        for (const tool of delegateTools) {
          if (!agent.tools.includes(tool)) {
            agent.tools.push(tool);
          }
        }
      } else {
        // Not the PM - remove delegate tools if present
        agent.tools = agent.tools.filter(tool => !DELEGATE_TOOLS.includes(tool));
      }
    }

    logger.debug(`Set PM pubkey: ${pubkey} and updated delegate tools`);
  }

  /**
   * Persist PM status to storage
   * In the new architecture, PM status is derived from project tags, not stored.
   * However, we still need to persist the updated tool assignments for agents.
   */
  async persistPMStatus(): Promise<void> {
    if (!this.pmPubkey) {
      logger.debug("No PM pubkey set, skipping persist");
      return;
    }

    // Save updated tool assignments for all agents in this project
    for (const agent of this.agents.values()) {
      try {
        const storedAgent = await agentStorage.loadAgent(agent.pubkey);
        if (storedAgent) {
          storedAgent.tools = agent.tools;
          await agentStorage.saveAgent(storedAgent);
        }
      } catch (error) {
        logger.error(`Failed to persist tools for agent ${agent.slug}`, { error });
      }
    }

    logger.debug("Persisted PM status and tool assignments");
  }

  /**
   * Remove an agent from the current project
   */
  async removeAgentFromProject(slug: string): Promise<boolean> {
    const agent = this.agents.get(slug);
    if (!agent || !this.projectDTag) {
      return false;
    }

    // Remove from storage
    await agentStorage.removeAgentFromProject(agent.pubkey, this.projectDTag);

    // Remove from memory
    this.agents.delete(slug);
    this.agentsByPubkey.delete(agent.pubkey);

    logger.info(`Removed agent ${slug} from project ${this.projectDTag}`);
    return true;
  }

  /**
   * Update an agent's LLM configuration
   */
  async updateAgentLLMConfig(agentPubkey: string, newLLMConfig: string): Promise<boolean> {
    const agent = this.agentsByPubkey.get(agentPubkey);
    if (!agent) {
      logger.warn(`Agent with pubkey ${agentPubkey} not found`);
      return false;
    }

    // Update in memory
    agent.llmConfig = newLLMConfig;

    // Update in storage
    const storedAgent = await agentStorage.loadAgent(agentPubkey);
    if (storedAgent) {
      storedAgent.llmConfig = newLLMConfig;
      await agentStorage.saveAgent(storedAgent);
      logger.info(`Updated LLM config for agent ${agent.name}`);
      return true;
    }

    return false;
  }

  /**
   * Update an agent's tools
   */
  async updateAgentTools(agentPubkey: string, newToolNames: string[]): Promise<boolean> {
    const agent = this.agentsByPubkey.get(agentPubkey);
    if (!agent) {
      logger.warn(`Agent with pubkey ${agentPubkey} not found`);
      return false;
    }

    // Normalize tools
    const normalizedTools = this.normalizeAgentTools(newToolNames, agent);
    const validToolNames = normalizedTools.filter(isValidToolName);

    // Update in memory
    agent.tools = validToolNames;

    // Update in storage (save the original requested tools)
    const storedAgent = await agentStorage.loadAgent(agentPubkey);
    if (storedAgent) {
      storedAgent.tools = newToolNames;
      await agentStorage.saveAgent(storedAgent);
      logger.info(`Updated tools for agent ${agent.name}`);
      return true;
    }

    return false;
  }

  /**
   * Normalize agent tools by applying business rules
   */
  private normalizeAgentTools(requestedTools: string[], agent: { phases?: Record<string, string> }): string[] {
    // Filter out delegation and phase management tools
    const toolNames = requestedTools.filter(tool =>
      !DELEGATE_TOOLS.includes(tool) &&
      !PHASE_MANAGEMENT_TOOLS.includes(tool)
    );

    // Add delegation tools based on phases
    const delegateTools = getDelegateToolsForAgent(agent);
    toolNames.push(...delegateTools);

    // Ensure core tools are included
    for (const coreTool of CORE_AGENT_TOOLS) {
      if (!toolNames.includes(coreTool)) {
        toolNames.push(coreTool);
      }
    }

    return toolNames;
  }

  /**
   * Publish agent events to Nostr
   */
  private async publishAgentEvents(
    signer: NDKPrivateKeySigner,
    config: Omit<AgentConfigOptionalNsec, "nsec">,
    ndkAgentEventId?: string,
    ndkProject?: NDKProject
  ): Promise<void> {
    try {
      if (!ndkProject) {
        logger.warn("No NDKProject provided, skipping agent event publishing");
        return;
      }

      const projectTitle = ndkProject.tagValue("title") || "Unknown Project";
      const projectEvent = ndkProject;

      // Load whitelisted pubkeys from config
      const { config: tenexConfig } = await configService.loadConfig(this.projectPath);
      const whitelistedPubkeys = tenexConfig.whitelistedPubkeys || [];

      await AgentPublisher.publishAgentCreation(
        signer,
        config,
        projectTitle,
        projectEvent,
        ndkAgentEventId,
        whitelistedPubkeys
      );
    } catch (error) {
      logger.error("Failed to publish agent events", { error: formatAnyError(error) });
      // Don't throw - agent creation should succeed even if publishing fails
    }
  }

  /**
   * Republish kind:0 events for all agents
   */
  async republishAllAgentProfiles(ndkProject: NDKProject): Promise<void> {
    const projectTitle = ndkProject.tagValue("title") || "Unknown Project";
    const projectEvent = ndkProject;

    // Collect all agent pubkeys in this project
    const projectAgentPubkeys: string[] = [];
    for (const agent of this.agents.values()) {
      projectAgentPubkeys.push(agent.pubkey);
    }

    // Load whitelisted pubkeys from config
    const { config } = await configService.loadConfig(this.projectPath);
    const whitelistedPubkeys = config.whitelistedPubkeys || [];

    // Combine project agents and whitelisted pubkeys for contact list
    const contactList = [...new Set([...projectAgentPubkeys, ...whitelistedPubkeys])];

    // Republish kind:0 and kind:3 for each agent
    for (const agent of this.agents.values()) {
      try {
        // Prepare metadata for agents without NDKAgentDefinition
        const agentMetadata = !agent.eventId ? {
          description: agent.description,
          instructions: agent.instructions,
          useCriteria: agent.useCriteria,
          phases: agent.phases
        } : undefined;

        AgentPublisher.publishAgentProfile(
          agent.signer,
          agent.name,
          agent.role,
          projectTitle,
          projectEvent,
          agent.eventId,
          agentMetadata,
          whitelistedPubkeys
        );

        // Publish contact list
        const agentContactList = contactList.filter(pubkey => pubkey !== agent.pubkey);
        AgentPublisher.publishContactList(
          agent.signer,
          agentContactList
        );
      } catch (error) {
        logger.error(`Failed to republish events for agent: ${agent.slug}`, {
          error: formatAnyError(error),
          agentName: agent.name,
        });
      }
    }
  }
}