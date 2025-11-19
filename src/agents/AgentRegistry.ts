import type { AgentInstance } from "@/agents/types";
import { createAgentInstance, loadAgentIntoRegistry } from "@/agents/agent-loader";
import { normalizePhase } from "@/conversations/utils/phaseUtils";
import { logger } from "@/utils/logger";
import type { NDKProject } from "@nostr-dev-kit/ndk";
import { agentStorage } from "./AgentStorage";

/**
 * AgentRegistry manages agent configuration and instances for a project.
 * All agents are stored in unified ~/.tenex/agents/ storage (not per-project).
 * Project-specific data (conversations, logs, events) stored in ~/.tenex/projects/{dTag}/
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

        logger.info(`Loaded ${this.agents.size} agents for project ${this.projectDTag}`);
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
            return agents.filter((agent) => !agent.phase);
        }

        // Return agents matching the phase or universal agents
        const normalizedPhase = normalizePhase(phase);

        return agents.filter((agent) => {
            if (!agent.phase) return true; // Universal agents work in all phases
            const agentPhase = normalizePhase(agent.phase);
            return agentPhase === normalizedPhase;
        });
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
        return true;
    }

    /**
     * Reload an agent from storage into the registry
     * Used after storage updates to refresh in-memory state
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
        const instance = createAgentInstance(storedAgent, this);
        this.addAgent(instance);

        logger.debug(`Reloaded agent ${storedAgent.name} (${storedAgent.slug})`);
        return true;
    }


}
