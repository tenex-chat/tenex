import type { AgentInstance } from "@/agents/types";
import { createAgentInstance, loadStoredAgentIntoRegistry } from "@/agents/agent-loader";
import { publishAgentProfile } from "@/nostr/AgentProfilePublisher";
import { config } from "@/services/ConfigService";
import { agentRuntimePolicyService } from "@/services/AgentRuntimePolicyService";
import { getConfiguredEscalationAgent } from "@/services/agents/EscalationService";
import { logger } from "@/utils/logger";
import { NDKPrivateKeySigner, type NDKProject } from "@nostr-dev-kit/ndk";
import { agentStorage, deriveAgentPubkeyFromNsec, type StoredAgent } from "./AgentStorage";

export interface ProjectAgentInfo {
    pubkey: string;
    slug: string;
    name: string;
    role: string;
    description?: string;
    useCriteria?: string;
}

function toProjectAgentInfo(pubkey: string, storedAgent: StoredAgent): ProjectAgentInfo {
    return {
        pubkey,
        slug: storedAgent.slug,
        name: storedAgent.name,
        role: storedAgent.role,
        description: storedAgent.description,
        useCriteria: storedAgent.useCriteria,
    };
}

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
 * // After the Rust daemon writes agent config (kind 24020), reload into the registry
 * await registry.reloadAgent(pubkey); // Refresh instance
 * ```
 *
 * @see AgentStorage for persistence operations
 * @see agent-loader for loading orchestration
 */
export class AgentRegistry {
    private agents: Map<string, AgentInstance> = new Map();
    private agentsByPubkey: Map<string, AgentInstance> = new Map();
    private projectAgentsByPubkey: Map<string, ProjectAgentInfo> = new Map();
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
     * Load agents for a project from authoritative project pubkey membership.
     *
     * Lowercase `p` tags on kind:31933 are the sole source of truth for
     * project membership. Storage mirrors those pubkeys for runtime boot and
     * non-running trust checks, but membership is never inferred from local state.
     */
    async loadFromProject(
        ndkProject: NDKProject,
        options: { publishProfiles?: boolean } = {}
    ): Promise<void> {
        this.ndkProject = ndkProject;
        this.projectDTag = ndkProject.dTag;

        if (!this.projectDTag) {
            logger.error("Project missing dTag", { projectId: ndkProject.id });
            return;
        }

        // Clear existing agents to ensure fresh load from project tags
        this.agents.clear();
        this.agentsByPubkey.clear();
        this.projectAgentsByPubkey.clear();

        // Initialize storage
        await agentStorage.initialize();

        // Lowercase `p` tags are assigned agent pubkeys.
        const assignedAgentPubkeys = ndkProject.tags
            .filter((t) => t[0] === "p" && t[1])
            .map((t) => t[1])
            .filter(Boolean) as string[];

        const { assignedPubkeys, skippedPubkeys } = await agentStorage.syncProjectAgents(
            this.projectDTag,
            assignedAgentPubkeys
        );

        const localPubkeys: string[] = [];
        const policy = agentRuntimePolicyService.getPolicy();

        for (const pubkey of assignedPubkeys) {
            const storedAgent = await agentStorage.loadAgent(pubkey);
            if (!storedAgent) {
                continue;
            }

            this.projectAgentsByPubkey.set(pubkey, toProjectAgentInfo(pubkey, storedAgent));
            if (agentRuntimePolicyService.shouldRunAgentSlug(storedAgent.slug)) {
                localPubkeys.push(pubkey);
            }
        }

        logger.info(`Loading ${localPubkeys.length}/${assignedPubkeys.length} local agents for project ${this.projectDTag}`, {
            requestedCount: assignedAgentPubkeys.length,
            skippedCount: skippedPubkeys.length,
            shardMode: policy.mode,
            shardSlugs: policy.slugs,
        });

        const failedPubkeys: string[] = [];

        for (const pubkey of localPubkeys) {
            try {
                await loadStoredAgentIntoRegistry(pubkey, this, {
                    publishProfile: options.publishProfiles !== false,
                });
            } catch (error) {
                logger.error(`Failed to load agent ${pubkey}`, { error });
                failedPubkeys.push(pubkey);
            }
        }

        // Log failed agents but don't block project boot
        if (failedPubkeys.length > 0) {
            const pmPubkey = assignedPubkeys[0];
            if (pmPubkey && failedPubkeys.includes(pmPubkey)) {
                logger.error(
                    "PM agent (first lowercase p-tag) failed to load — project will boot without a PM.",
                    { pmPubkey, failedPubkeys }
                );
            } else {
                logger.warn(
                    `${failedPubkeys.length} assigned agent(s) could not be loaded but continuing with available agents`,
                    { failedPubkeys }
                );
            }
        }

        // Auto-add escalation agent if configured (regardless of 31933 p-tags)
        const escalationSlug = getConfiguredEscalationAgent();
        if (escalationSlug && !this.agents.has(escalationSlug)) {
            try {
                const storedAgent = await agentStorage.getAgentBySlug(escalationSlug);
                if (storedAgent) {
                    if (!agentRuntimePolicyService.shouldRunAgentSlug(storedAgent.slug)) {
                        logger.info(`Escalation agent ${escalationSlug} skipped by local agent runtime policy`, {
                            projectDTag: this.projectDTag,
                        });
                    } else {
                        const escalationPubkey = deriveAgentPubkeyFromNsec(storedAgent.nsec);
                        await loadStoredAgentIntoRegistry(escalationPubkey, this, {
                            publishProfile: options.publishProfiles !== false,
                        });
                        logger.info(`Auto-loaded escalation agent ${escalationSlug} for project ${this.projectDTag}`);
                    }
                } else {
                    logger.warn(`Escalation agent ${escalationSlug} configured but not found in storage`, {
                        projectDTag: this.projectDTag,
                    });
                }
            } catch (error) {
                logger.warn(`Failed to auto-load escalation agent ${escalationSlug}`, {
                    projectDTag: this.projectDTag,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }

        logger.info(`Loaded ${this.agents.size} total agents for project ${this.projectDTag}`);

        // Republish kind:0 profiles for all agents now that the project has booted
        // Fire-and-forget: don't block boot waiting for profile publishes (especially NIP-46 signing)
        if (options.publishProfiles !== false) {
            this.republishAgentProfiles(ndkProject).catch((error) => {
                logger.warn("Background agent profile republishing failed", {
                    projectDTag: this.projectDTag,
                    error: error instanceof Error ? error.message : String(error),
                });
            });
        }
    }

    /**
     * Republish kind:0 profiles for all agents in this project.
     * Called during project boot to ensure all agent profiles are up to date.
     */
    private async republishAgentProfiles(ndkProject: NDKProject): Promise<void> {
        const projectTitle = ndkProject.tagValue("title") || "Untitled Project";
        const whitelistedPubkeys = config.getWhitelistedPubkeys();
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

                await publishAgentProfile(
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
     * Get all assigned project agents, including agents intentionally not run
     * by this backend's local shard.
     */
    getAllProjectAgents(): ProjectAgentInfo[] {
        return Array.from(this.projectAgentsByPubkey.values());
    }

    getProjectAgentByPubkey(pubkey: string): ProjectAgentInfo | undefined {
        return this.projectAgentsByPubkey.get(pubkey);
    }

    getProjectAgentBySlug(slug: string): ProjectAgentInfo | undefined {
        const normalizedSlug = slug.trim().toLowerCase();
        return Array.from(this.projectAgentsByPubkey.values()).find(
            (agent) => agent.slug.toLowerCase() === normalizedSlug
        );
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
        if (!this.projectAgentsByPubkey.has(agent.pubkey)) {
            this.projectAgentsByPubkey.set(agent.pubkey, {
                pubkey: agent.pubkey,
                slug: agent.slug,
                name: agent.name,
                role: agent.role,
                description: agent.description,
                useCriteria: agent.useCriteria,
            });
        }
    }

    /**
     * Get the Project Manager (PM) for this project
     * PM is the first agent in the project's agent tags
     */
    getProjectPM(): AgentInstance | undefined {
        if (!this.ndkProject) return undefined;

        const firstAgentPubkey = this.ndkProject.tags.find((t) => t[0] === "p" && t[1])?.[1];

        if (!firstAgentPubkey) return undefined;

        // Find agent with this pubkey
        for (const agent of this.agents.values()) {
            if (agent.pubkey === firstAgentPubkey) {
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

        return true;
    }

    /**
     * Reload an agent from storage into the registry.
     *
     * Used after the Rust daemon rewrites an agent file (e.g. kind 24020 handler)
     * to refresh the in-memory runtime instance.
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
        const instance = await createAgentInstance(storedAgent, this, this.projectDTag);
        this.addAgent(instance);

        logger.debug(`Reloaded agent ${storedAgent.name} (${storedAgent.slug})`);
        return true;
    }


}
