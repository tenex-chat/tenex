import type { AgentInstance } from "@/agents/types";
import { getProjectContext } from "@/services/ProjectContext";
import { logger } from "@/utils/logger";

/**
 * Interface for resolving agents.
 * Allows for different implementations (project-based, standalone, etc.)
 */
export interface IAgentResolver {
    getAgent(slug: string): AgentInstance | undefined;
    getAgentByPubkey(pubkey: string): AgentInstance | undefined;
    getAllAgents(): Map<string, AgentInstance>;
}

/**
 * Project-based agent resolver that uses the project context.
 */
export class ProjectAgentResolver implements IAgentResolver {
    getAgent(slug: string): AgentInstance | undefined {
        const projectCtx = getProjectContext();
        const agent = projectCtx.agents.get(slug);

        if (agent) {
            logger.debug(`[ProjectAgentResolver] Resolved agent ${slug}`);
        } else {
            logger.warn(`[ProjectAgentResolver] Agent ${slug} not found`);
        }

        return agent;
    }

    getAgentByPubkey(pubkey: string): AgentInstance | undefined {
        const projectCtx = getProjectContext();
        const agent = projectCtx.getAgentByPubkey(pubkey);

        if (agent) {
            logger.debug("[ProjectAgentResolver] Resolved agent by pubkey", {
                pubkey: pubkey.substring(0, 8),
                slug: agent.slug,
            });
        }

        return agent;
    }

    getAllAgents(): Map<string, AgentInstance> {
        const projectCtx = getProjectContext();
        return projectCtx.agents;
    }
}

/**
 * Standalone agent resolver for non-project contexts.
 * Agents are provided directly to the resolver.
 */
export class StandaloneAgentResolver implements IAgentResolver {
    private agents: Map<string, AgentInstance>;
    private pubkeyToSlug: Map<string, string>;

    constructor(agents: Map<string, AgentInstance>) {
        this.agents = agents;
        this.pubkeyToSlug = new Map();

        // Build pubkey lookup map
        for (const [slug, agent] of agents) {
            if (agent.pubkey) {
                this.pubkeyToSlug.set(agent.pubkey, slug);
            }
        }

        logger.info(`[StandaloneAgentResolver] Initialized with ${agents.size} agents`);
    }

    getAgent(slug: string): AgentInstance | undefined {
        const agent = this.agents.get(slug);

        if (agent) {
            logger.debug(`[StandaloneAgentResolver] Resolved agent ${slug}`);
        } else {
            logger.warn(`[StandaloneAgentResolver] Agent ${slug} not found`);
        }

        return agent;
    }

    getAgentByPubkey(pubkey: string): AgentInstance | undefined {
        const slug = this.pubkeyToSlug.get(pubkey);
        if (!slug) {
            logger.warn("[StandaloneAgentResolver] No agent found for pubkey", {
                pubkey: pubkey.substring(0, 8),
            });
            return undefined;
        }

        return this.getAgent(slug);
    }

    getAllAgents(): Map<string, AgentInstance> {
        return new Map(this.agents);
    }

    /**
     * Add or update an agent
     */
    addAgent(agent: AgentInstance): void {
        this.agents.set(agent.slug, agent);
        if (agent.pubkey) {
            this.pubkeyToSlug.set(agent.pubkey, agent.slug);
        }

        logger.info(`[StandaloneAgentResolver] Added agent ${agent.slug}`);
    }

    /**
     * Remove an agent
     */
    removeAgent(slug: string): void {
        const agent = this.agents.get(slug);
        if (agent?.pubkey) {
            this.pubkeyToSlug.delete(agent.pubkey);
        }
        this.agents.delete(slug);

        logger.info(`[StandaloneAgentResolver] Removed agent ${slug}`);
    }
}

/**
 * Mock agent resolver for testing
 */
export class MockAgentResolver implements IAgentResolver {
    private agents: Map<string, AgentInstance> = new Map();
    private pubkeyToSlug: Map<string, string> = new Map();

    constructor(agents?: AgentInstance[]) {
        if (agents) {
            for (const agent of agents) {
                this.agents.set(agent.slug, agent);
                if (agent.pubkey) {
                    this.pubkeyToSlug.set(agent.pubkey, agent.slug);
                }
            }
        }
    }

    getAgent(slug: string): AgentInstance | undefined {
        return this.agents.get(slug);
    }

    getAgentByPubkey(pubkey: string): AgentInstance | undefined {
        const slug = this.pubkeyToSlug.get(pubkey);
        return slug ? this.agents.get(slug) : undefined;
    }

    getAllAgents(): Map<string, AgentInstance> {
        return new Map(this.agents);
    }

    // Test helper methods
    addMockAgent(agent: AgentInstance): void {
        this.agents.set(agent.slug, agent);
        if (agent.pubkey) {
            this.pubkeyToSlug.set(agent.pubkey, agent.slug);
        }
    }

    clear(): void {
        this.agents.clear();
        this.pubkeyToSlug.clear();
    }
}
