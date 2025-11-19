import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { StoredAgentData } from "@/agents/types";
import { ensureDirectory, fileExists } from "@/lib/fs";
import { config } from "@/services/ConfigService";
import { logger } from "@/utils/logger";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";

/**
 * Agent data stored in ~/.tenex/agents/<pubkey>.json
 */
export interface StoredAgent extends StoredAgentData {
    eventId?: string;
    nsec: string;
    slug: string;
    projects: string[]; // Array of project dTags
}

/**
 * Factory function to create a StoredAgent object
 * Ensures consistent structure and defaults
 */
export function createStoredAgent(config: {
    nsec: string;
    slug: string;
    name: string;
    role: string;
    description?: string | null;
    instructions?: string | null;
    useCriteria?: string | null;
    llmConfig?: string;
    tools?: string[] | null;
    phases?: Record<string, string> | null;
    eventId?: string;
    projects?: string[];
}): StoredAgent {
    return {
        eventId: config.eventId,
        nsec: config.nsec,
        slug: config.slug,
        name: config.name,
        role: config.role,
        description: config.description ?? undefined,
        instructions: config.instructions ?? undefined,
        useCriteria: config.useCriteria ?? undefined,
        llmConfig: config.llmConfig,
        tools: config.tools ?? undefined,
        phases: config.phases ?? undefined,
        projects: config.projects ?? [],
    };
}

/**
 * Index structure for fast lookups
 */
interface AgentIndex {
    bySlug: Record<string, string>; // slug -> pubkey
    byEventId: Record<string, string>; // eventId -> pubkey
    byProject: Record<string, string[]>; // projectDTag -> pubkey[]
}

/**
 * Manages agent storage in ~/.tenex/agents/
 * Each agent is stored as <pubkey>.json with all data including nsec
 * An index.json file provides fast lookups by slug, eventId, and project
 */
export class AgentStorage {
    private agentsDir: string;
    private indexPath: string;
    private index: AgentIndex | null = null;

    constructor() {
        this.agentsDir = config.getConfigPath("agents");
        this.indexPath = path.join(this.agentsDir, "index.json");
    }

    /**
     * Ensure storage directory exists and load index
     */
    async initialize(): Promise<void> {
        await ensureDirectory(this.agentsDir);
        await this.loadIndex();
    }

    /**
     * Load the index file or create empty index if it doesn't exist
     */
    private async loadIndex(): Promise<void> {
        if (await fileExists(this.indexPath)) {
            try {
                const content = await fs.readFile(this.indexPath, "utf-8");
                this.index = JSON.parse(content);
            } catch (error) {
                logger.error("Failed to load agent index, creating new one", { error });
                this.index = { bySlug: {}, byEventId: {}, byProject: {} };
            }
        } else {
            this.index = { bySlug: {}, byEventId: {}, byProject: {} };
        }
    }

    /**
     * Save the index file
     */
    private async saveIndex(): Promise<void> {
        if (!this.index) return;
        await fs.writeFile(this.indexPath, JSON.stringify(this.index, null, 2));
    }

    /**
     * Rebuild index by scanning all agent files
     */
    async rebuildIndex(): Promise<void> {
        const index: AgentIndex = { bySlug: {}, byEventId: {}, byProject: {} };

        const files = await fs.readdir(this.agentsDir);
        for (const file of files) {
            if (!file.endsWith(".json") || file === "index.json") continue;

            const pubkey = file.slice(0, -5); // Remove .json
            try {
                const agent = await this.loadAgent(pubkey);
                if (!agent) continue;

                // Update slug index
                index.bySlug[agent.slug] = pubkey;

                // Update eventId index
                if (agent.eventId) {
                    index.byEventId[agent.eventId] = pubkey;
                }

                // Update project index
                for (const projectDTag of agent.projects) {
                    if (!index.byProject[projectDTag]) {
                        index.byProject[projectDTag] = [];
                    }
                    index.byProject[projectDTag].push(pubkey);
                }
            } catch (error) {
                logger.warn(`Failed to index agent file ${file}`, { error });
            }
        }

        this.index = index;
        await this.saveIndex();
        logger.info("Rebuilt agent index", {
            agents: Object.keys(index.bySlug).length,
            projects: Object.keys(index.byProject).length,
        });
    }

    /**
     * Load an agent by pubkey
     */
    async loadAgent(pubkey: string): Promise<StoredAgent | null> {
        const filePath = path.join(this.agentsDir, `${pubkey}.json`);

        if (!(await fileExists(filePath))) {
            return null;
        }

        try {
            const content = await fs.readFile(filePath, "utf-8");
            return JSON.parse(content);
        } catch (error) {
            logger.error(`Failed to load agent ${pubkey}`, { error });
            return null;
        }
    }

    /**
     * Save an agent and update index
     */
    async saveAgent(agent: StoredAgent): Promise<void> {
        // Get pubkey from nsec
        const signer = new NDKPrivateKeySigner(agent.nsec);
        const pubkey = signer.pubkey;

        const filePath = path.join(this.agentsDir, `${pubkey}.json`);

        // Load existing agent to check for changes
        const existing = await this.loadAgent(pubkey);

        // Save agent file
        await fs.writeFile(filePath, JSON.stringify(agent, null, 2));

        // Update index
        if (!this.index) await this.loadIndex();
        if (!this.index) return;

        // Remove old index entries if slug or eventId changed
        if (existing) {
            if (existing.slug !== agent.slug && this.index.bySlug[existing.slug] === pubkey) {
                delete this.index.bySlug[existing.slug];
            }
            if (
                existing.eventId &&
                existing.eventId !== agent.eventId &&
                this.index.byEventId[existing.eventId] === pubkey
            ) {
                delete this.index.byEventId[existing.eventId];
            }

            // Remove from old projects
            for (const projectDTag of existing.projects) {
                if (!agent.projects.includes(projectDTag)) {
                    const projectAgents = this.index.byProject[projectDTag];
                    if (projectAgents) {
                        this.index.byProject[projectDTag] = projectAgents.filter(
                            (p) => p !== pubkey
                        );
                        if (this.index.byProject[projectDTag].length === 0) {
                            delete this.index.byProject[projectDTag];
                        }
                    }
                }
            }
        }

        // Add new index entries
        this.index.bySlug[agent.slug] = pubkey;
        if (agent.eventId) {
            this.index.byEventId[agent.eventId] = pubkey;
        }

        // Update project index
        for (const projectDTag of agent.projects) {
            if (!this.index.byProject[projectDTag]) {
                this.index.byProject[projectDTag] = [];
            }
            if (!this.index.byProject[projectDTag].includes(pubkey)) {
                this.index.byProject[projectDTag].push(pubkey);
            }
        }

        await this.saveIndex();
        logger.debug(`Saved agent ${agent.slug} (${pubkey})`);
    }

    /**
     * Delete an agent and update index
     */
    async deleteAgent(pubkey: string): Promise<void> {
        const agent = await this.loadAgent(pubkey);
        if (!agent) return;

        // Delete file
        const filePath = path.join(this.agentsDir, `${pubkey}.json`);
        await fs.unlink(filePath);

        // Update index
        if (!this.index) await this.loadIndex();
        if (!this.index) return;

        // Remove from slug index
        if (this.index.bySlug[agent.slug] === pubkey) {
            delete this.index.bySlug[agent.slug];
        }

        // Remove from eventId index
        if (agent.eventId && this.index.byEventId[agent.eventId] === pubkey) {
            delete this.index.byEventId[agent.eventId];
        }

        // Remove from project index
        for (const projectDTag of agent.projects) {
            const projectAgents = this.index.byProject[projectDTag];
            if (projectAgents) {
                this.index.byProject[projectDTag] = projectAgents.filter((p) => p !== pubkey);
                if (this.index.byProject[projectDTag].length === 0) {
                    delete this.index.byProject[projectDTag];
                }
            }
        }

        await this.saveIndex();
        logger.info(`Deleted agent ${agent.slug} (${pubkey})`);
    }

    /**
     * Get agent by slug (uses index for O(1) lookup)
     */
    async getAgentBySlug(slug: string): Promise<StoredAgent | null> {
        if (!this.index) await this.loadIndex();
        if (!this.index) return null;

        const pubkey = this.index.bySlug[slug];
        if (!pubkey) return null;

        return this.loadAgent(pubkey);
    }

    /**
     * Get agent by eventId (uses index for O(1) lookup)
     */
    async getAgentByEventId(eventId: string): Promise<StoredAgent | null> {
        if (!this.index) await this.loadIndex();
        if (!this.index) return null;

        const pubkey = this.index.byEventId[eventId];
        if (!pubkey) return null;

        return this.loadAgent(pubkey);
    }

    /**
     * Get all agents for a project (uses index for O(1) lookup)
     */
    async getProjectAgents(projectDTag: string): Promise<StoredAgent[]> {
        if (!this.index) await this.loadIndex();
        if (!this.index) return [];

        const pubkeys = this.index.byProject[projectDTag] || [];
        const agents: StoredAgent[] = [];

        for (const pubkey of pubkeys) {
            const agent = await this.loadAgent(pubkey);
            if (agent) {
                agents.push(agent);
            }
        }

        return agents;
    }

    /**
     * Add an agent to a project
     */
    async addAgentToProject(pubkey: string, projectDTag: string): Promise<void> {
        const agent = await this.loadAgent(pubkey);
        if (!agent) {
            throw new Error(`Agent ${pubkey} not found`);
        }

        if (!agent.projects.includes(projectDTag)) {
            agent.projects.push(projectDTag);
            await this.saveAgent(agent);
        }
    }

    /**
     * Remove an agent from a project
     */
    async removeAgentFromProject(pubkey: string, projectDTag: string): Promise<void> {
        const agent = await this.loadAgent(pubkey);
        if (!agent) return;

        agent.projects = agent.projects.filter((p) => p !== projectDTag);

        if (agent.projects.length === 0) {
            // No projects left, delete the agent
            await this.deleteAgent(pubkey);
        } else {
            await this.saveAgent(agent);
        }
    }

    /**
     * Get all agents (for debugging/admin purposes)
     */
    async getAllAgents(): Promise<StoredAgent[]> {
        const files = await fs.readdir(this.agentsDir);
        const agents: StoredAgent[] = [];

        for (const file of files) {
            if (!file.endsWith(".json") || file === "index.json") continue;

            const pubkey = file.slice(0, -5);
            const agent = await this.loadAgent(pubkey);
            if (agent) {
                agents.push(agent);
            }
        }

        return agents;
    }
}

// Export singleton instance
export const agentStorage = new AgentStorage();
