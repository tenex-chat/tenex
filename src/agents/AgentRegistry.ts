import type { AgentInstance } from "@/agents/types";
import { createAgentInstance, loadAgentIntoRegistry } from "@/agents/agent-loader";
import { AgentProfilePublisher } from "@/nostr/AgentProfilePublisher";
import { loadEscalationAgentIntoRegistry } from "@/services/agents/EscalationService";
import { config } from "@/services/ConfigService";
import { logger } from "@/utils/logger";
import { NDKPrivateKeySigner, type NDKProject } from "@nostr-dev-kit/ndk";
import { agentStorage } from "./AgentStorage";

/**
 * AgentRegistry - In-memory runtime instances for a specific project
 *
 * ## Responsibility
 * Manages runtime AgentInstance objects (with methods like sign(), createLLMService())
 * - Scoped to ONE project - each project runtime has its own registry
 * - Fast lookups by slug, pubkey, or eventId
 * - Loads agents from storage and hydrates them into runtime instances
 * - Can reload agents when storage updates
 *
 * ## Architecture
 * - **AgentStorage**: Handles ALL persistence operations (separate)
 * - **AgentRegistry** (this): Handles in-memory runtime instances only
 * - **agent-loader**: Orchestrates loading from storage → registry (separate)
 *
 * ## Key Distinction: AgentInstance vs StoredAgent
 * - **StoredAgent** (storage): Plain data object with no methods
 * - **AgentInstance** (registry): Runtime object with sign(), createLLMService(), etc.
 *
 * ## Lifecycle
 * 1. Project starts → registry created for that project
 * 2. Agents loaded → StoredAgent → AgentInstance → added to registry
 * 3. Project stops → registry discarded (instances are ephemeral)
 * 4. Next run → fresh registry created, agents reloaded
 *
 * ## Multi-Project Isolation
 * Each project has its own registry instance. One agent in storage can appear
 * in multiple project registries simultaneously.
 *
 * ## Usage Pattern
 * ```typescript
 * // Load agents from project
 * await registry.loadFromProject(ndkProject);
 *
 * // Get agent instance
 * const agent = registry.getAgent('my-agent-slug');
 *
 * // Use agent's runtime methods
 * await agent.sign(event);
 * const llm = agent.createLLMService();
 *
 * // After storage updates, reload
 * await agentStorage.updateDefaultConfig(pubkey, { tools: newTools });
 * await registry.reloadAgent(pubkey); // Refresh instance
 * ```
 *
 * @see AgentStorage for persistence operations
 * @see agent-loader for loading orchestration
 */
export class AgentRegistry {
    private agents: Map<string, AgentInstance> = new Map();
    private agentsByPubkey: Map<string, AgentInstance> = new Map();
    private projectDTag: string | undefined;
    private projectPath: string; // Git repo path
    private metadataPath: string; // TENEX metadata path
    private ndkProject?: NDKProject;

    /**
     * Creates a new AgentRegistry instance.
     * @param projectPath - The git repository path (e.g., ~/tenex/<dTag>/)
     * @param metadataPath - The metadata path (e.g., ~/.tenex/projects/<dTag>/)
     */
    constructor(projectPath: string, metadataPath: string) {
        if (!projectPath || projectPath === "undefined") {
            throw new Error(
                `AgentRegistry requires a valid projectPath. Received: ${String(projectPath)}`
            );
        }
        if (!metadataPath || metadataPath === "undefined") {
            throw new Error(
                `AgentRegistry requires a valid metadataPath. Received: ${String(metadataPath)}`
            );
        }
        this.projectPath = projectPath;
        this.metadataPath = metadataPath;
    }

    /**
     * Get the base path for this project (the git repository)
     */
    getBasePath(): string {
        return this.projectPath;
    }

    /**
     * Get the metadata path for this project (~/.tenex/projects/<dTag>/)
     */
    getMetadataPath(): string {
        return this.metadataPath;
    }

    /**
     * Load agents for a project from unified storage (~/.tenex/agents/) and Nostr.
     * Complete agent loading workflow:
     * 1. Load agents from unified ~/.tenex/agents/ storage by event ID
     * 2. For missing agents, fetch from Nostr and install to unified storage
     * 3. Load newly installed agents and associate with this project
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

        const failedAgents: string[] = [];

        // Load each agent using the new loader (no redundant checks!)
        for (const eventId of agentEventIds) {
            try {
                await loadAgentIntoRegistry(eventId, this);
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
                    `Critical agent failed to load. Agent event ID ${pmEventId} could not be fetched. This might be due to network issues or the event not being available on the configured relays.`
                );
            }
            logger.warn(
                `${failedAgents.length} agent(s) could not be installed but continuing with available agents`
            );
        }

        // Load locally-associated agents from storage
        const localAgents = await agentStorage.getProjectAgents(this.projectDTag);
        logger.info(`Found ${localAgents.length} locally-associated agents in storage for project ${this.projectDTag}`);

        for (const storedAgent of localAgents) {
            // Skip if already loaded (by eventId or slug)
            const existingBySlug = this.agents.get(storedAgent.slug);
            const existingByEventId = storedAgent.eventId
                ? this.getAgentByEventId(storedAgent.eventId)
                : undefined;

            if (existingBySlug || existingByEventId) {
                logger.debug(`Agent ${storedAgent.slug} already in registry, skipping`);
                continue;
            }

            // Load this locally-associated agent
            try {
                // Pass projectDTag for project-scoped config resolution
                const agentInstance = createAgentInstance(storedAgent, this, this.projectDTag);
                this.addAgent(agentInstance);
                logger.info(`Loaded locally-associated agent ${storedAgent.slug} into registry`);
            } catch (error) {
                logger.error(`Failed to load agent ${storedAgent.slug}`, { error });
            }
        }

        // Proactively load escalation agent if configured
        // This ensures the escalation agent appears in "Available Agents" for all projects
        await loadEscalationAgentIntoRegistry(this, this.projectDTag);

        logger.info(`Loaded ${this.agents.size} total agents for project ${this.projectDTag}`);

        // Republish kind:0 profiles for all agents now that the project has booted
        if (ndkProject) {
            await this.republishAgentProfiles(ndkProject);
        }
    }

    /**
     * Republish kind:0 profiles for all agents in this project.
     * Called during project boot to ensure all agent profiles are up to date.
     */
    private async republishAgentProfiles(ndkProject: NDKProject): Promise<void> {
        const projectTitle = ndkProject.tagValue("title") || "Untitled Project";
        const whitelistedPubkeys = config.getWhitelistedPubkeys(undefined, config.getConfig());
        const publishedCount = { success: 0, failed: 0 };

        for (const agent of this.agents.values()) {
            try {
                const storedAgent = await agentStorage.loadAgent(agent.pubkey);
                if (!storedAgent) {
                    logger.warn(`Could not load stored agent for profile republishing: ${agent.slug}`);
                    publishedCount.failed++;
                    continue;
                }

                const signer = new NDKPrivateKeySigner(storedAgent.nsec);

                await AgentProfilePublisher.publishAgentProfile(
                    signer,
                    agent.name,
                    agent.role,
                    projectTitle,
                    ndkProject,
                    agent.eventId,
                    {
                        description: agent.description,
                        instructions: agent.instructions,
                        useCriteria: agent.useCriteria,
                    },
                    whitelistedPubkeys
                );

                publishedCount.success++;
                logger.debug(`Republished kind:0 profile for agent ${agent.name}`);
            } catch (error) {
                publishedCount.failed++;
                logger.warn(`Failed to republish kind:0 profile for agent ${agent.name}`, { error });
            }
        }

        logger.info(
            `Republished kind:0 profiles for project ${this.projectDTag}: ${publishedCount.success} succeeded, ${publishedCount.failed} failed`
        );
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
     * Get an agent by event ID
     */
    getAgentByEventId(eventId: string): AgentInstance | undefined {
        for (const agent of this.agents.values()) {
            if (agent.eventId === eventId) {
                return agent;
            }
        }
        return undefined;
    }

    /**
     * Get the project dTag for this registry
     */
    getProjectDTag(): string | undefined {
        return this.projectDTag;
    }

    /**
     * Get the NDKProject for this registry
     */
    getNDKProject(): NDKProject | undefined {
        return this.ndkProject;
    }

    /**
     * Add an agent instance to the registry maps.
     * Simple state management - no validation or loading logic.
     */
    addAgent(agent: AgentInstance): void {
        this.agents.set(agent.slug, agent);
        this.agentsByPubkey.set(agent.pubkey, agent);
    }

    /**
     * Get the Project Manager (PM) for this project
     * PM is the first agent in the project's agent tags
     */
    getProjectPM(): AgentInstance | undefined {
        if (!this.ndkProject) return undefined;

        const firstAgentEventId = this.ndkProject.tags.find((t) => t[0] === "agent" && t[1])?.[1];

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

        // Re-publish 14199 snapshot so the removed agent's p-tag is dropped
        try {
            await AgentProfilePublisher.publishProjectAgentSnapshot(this.projectDTag);
        } catch (error) {
            logger.warn("Failed to re-publish 14199 snapshot after agent removal", {
                slug,
                projectDTag: this.projectDTag,
                error: error instanceof Error ? error.message : String(error),
            });
        }

        return true;
    }

    /**
     * Reload an agent from storage into the registry.
     *
     * Used after storage updates to refresh the in-memory instance.
     * This is the second half of the storage update pattern.
     *
     * ## When to use
     * Call this after any AgentStorage update method:
     * - updateDefaultConfig()
     * - updateProjectOverride()
     * - Or any direct modification to stored agent data
     *
     * ## What it does
     * 1. Load fresh StoredAgent from disk
     * 2. Remove old AgentInstance from registry
     * 3. Create new AgentInstance with fresh data
     * 4. Add new instance to registry
     *
     * @param pubkey - Agent's public key (hex string)
     * @returns true if reloaded successfully, false if agent not found in storage
     *
     * @example
     * // Update pattern
     * await agentStorage.updateDefaultConfig(pubkey, { model: 'anthropic:claude-opus-4' });
     * await registry.reloadAgent(pubkey); // Pick up changes
     *
     * @example
     * // Check if agent exists before using
     * const reloaded = await registry.reloadAgent(pubkey);
     * if (reloaded) {
     *   const agent = registry.getAgentByPubkey(pubkey);
     *   console.log('Agent reloaded:', agent.name);
     * }
     */
    async reloadAgent(pubkey: string): Promise<boolean> {
        const storedAgent = await agentStorage.loadAgent(pubkey);
        if (!storedAgent) {
            logger.warn(`Agent with pubkey ${pubkey} not found in storage`);
            return false;
        }

        // Remove old instance
        const oldAgent = this.agentsByPubkey.get(pubkey);
        if (oldAgent) {
            this.agents.delete(oldAgent.slug);
            this.agentsByPubkey.delete(pubkey);
        }

        // Create and add new instance
        // Pass projectDTag for project-scoped config resolution
        const instance = createAgentInstance(storedAgent, this, this.projectDTag);
        this.addAgent(instance);

        logger.debug(`Reloaded agent ${storedAgent.name} (${storedAgent.slug})`);
        return true;
    }


}
