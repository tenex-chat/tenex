import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { StoredAgentData, AgentDefaultConfig, AgentProjectConfig } from "@/agents/types";
import type { MCPServerConfig } from "@/llm/providers/types";
import { ensureDirectory, fileExists } from "@/lib/fs";
import { config } from "@/services/ConfigService";
import { logger } from "@/utils/logger";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { trace } from "@opentelemetry/api";
import { AgentSlugConflictError } from "@/agents/errors";
import {
    resolveEffectiveConfig,
    deduplicateProjectConfig,
    type ResolvedAgentConfig,
} from "@/agents/ConfigResolver";

/**
 * Agent data stored in ~/.tenex/agents/<pubkey>.json
 *
 * ## Configuration Schema
 * Agent config is split into:
 * - `default`: Global defaults (model, tools). Written by 24020 without a-tag.
 * - `projectOverrides`: Per-project overrides map. Written by 24020 with a-tag.
 *   Tools can use delta syntax (+tool / -tool) or full replacement.
 *
 * ## Configuration Priority
 * 1. projectOverrides[projectDTag].* (project-scoped override)
 * 2. default.* (global defaults)
 */
export interface StoredAgent extends StoredAgentData {
    eventId?: string;
    nsec: string;
    slug: string;
    /**
     * Project-scoped PM override flags.
     * Key is project dTag, value is true if this agent is PM for that project.
     * Only one agent per project should have this set to true.
     * Set via agent_configure tool.
     */
    pmOverrides?: Record<string, boolean>;
    /**
     * Global PM designation flag.
     * When true, this agent is designated as PM for ALL projects where it exists.
     * Set via kind 24020 TenexAgentConfigUpdate event with ["pm"] tag (without a-tag).
     * Takes precedence over pmOverrides and project tag designations.
     */
    isPM?: boolean;
}

/**
 * Factory function to create a StoredAgent object.
 *
 * Ensures consistent structure and defaults across the codebase.
 * Used by both agent-installer (Nostr agents) and agents_write (local agents).
 *
 * @param config - Agent configuration
 * @returns StoredAgent ready for saving to disk
 *
 * @example
 * const agent = createStoredAgent({
 *   nsec: signer.nsec,
 *   slug: 'my-agent',
 *   name: 'My Agent',
 *   role: 'assistant',
 *   defaultConfig: { model: 'anthropic:claude-sonnet-4', tools: ['fs_read', 'shell'] },
 *   eventId: 'nostr_event_id',
 * });
 * await agentStorage.saveAgent(agent);
 * await agentStorage.addAgentToProject(signer.pubkey, 'project-dtag');
 */
export function createStoredAgent(config: {
    nsec: string;
    slug: string;
    name: string;
    role: string;
    description?: string | null;
    instructions?: string | null;
    useCriteria?: string | null;
    eventId?: string;
    mcpServers?: Record<string, MCPServerConfig>;
    pmOverrides?: Record<string, boolean>;
    defaultConfig?: AgentDefaultConfig;
    projectOverrides?: Record<string, AgentProjectConfig>;
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
        mcpServers: config.mcpServers,
        pmOverrides: config.pmOverrides,
        default: config.defaultConfig,
        projectOverrides: config.projectOverrides,
    };
}

/**
 * Slug index entry
 */
interface SlugEntry {
    pubkey: string;
}

/**
 * Index structure for fast lookups
 */
interface AgentIndex {
    bySlug: Record<string, SlugEntry>; // slug -> { pubkey }
    byEventId: Record<string, string>; // eventId -> pubkey
    byProject: Record<string, string[]>; // projectDTag -> pubkey[]
}

/**
 * AgentStorage - Persistent storage layer for agent data
 *
 * ## Responsibility
 * Manages agent data persistence in ~/.tenex/agents/
 * - One JSON file per agent: <pubkey>.json (contains all data including private key)
 * - Fast lookups via index.json (slug → pubkey, eventId → pubkey, project → pubkeys)
 * - Project associations (which agents belong to which projects)
 *
 * ## Architecture
 * - **AgentStorage** (this): Handles ALL persistence operations
 * - **AgentRegistry**: Handles in-memory runtime instances (separate)
 * - **agent-loader**: Orchestrates loading from storage → registry (separate)
 *
 * ## Storage Structure
 * ```
 * ~/.tenex/agents/
 *   ├── index.json              # Fast lookup index
 *   ├── <pubkey1>.json          # Agent data + private key
 *   └── <pubkey2>.json          # Agent data + private key
 * ```
 *
 * ## Usage Pattern
 * 1. **Read operations**: Use load/get methods
 * 2. **Write operations**: Use save/update methods
 * 3. **After updates**: Call AgentRegistry.reloadAgent() to refresh in-memory instances
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
     * Load the index file or create empty index if it doesn't exist.
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
     * Rebuild index by scanning all agent files.
     * Preserves byProject (source of truth for associations) and rebuilds bySlug/byEventId.
     */
    async rebuildIndex(): Promise<void> {
        const preservedByProject = this.index?.byProject ?? {};
        const index: AgentIndex = { bySlug: {}, byEventId: {}, byProject: preservedByProject };

        const files = await fs.readdir(this.agentsDir);
        for (const file of files) {
            if (!file.endsWith(".json") || file === "index.json") continue;

            const pubkey = file.slice(0, -5); // Remove .json
            try {
                const agent = await this.loadAgent(pubkey);
                if (!agent) continue;

                // Update slug index
                const existingEntry = index.bySlug[agent.slug];
                if (existingEntry && existingEntry.pubkey !== pubkey) {
                    logger.warn(`Slug conflict during rebuild: '${agent.slug}'`, {
                        existingPubkey: existingEntry.pubkey.substring(0, 8),
                        newPubkey: pubkey.substring(0, 8),
                    });
                } else {
                    index.bySlug[agent.slug] = { pubkey };
                }

                // Update eventId index
                if (agent.eventId) {
                    index.byEventId[agent.eventId] = pubkey;
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
            const agent: StoredAgent = JSON.parse(content);
            return agent;
        } catch (error) {
            logger.error(`Failed to load agent ${pubkey}`, { error });
            return null;
        }
    }

    /**
     * Check if an agent has PM override for a specific project
     */
    hasPMOverride(agent: StoredAgent, projectDTag: string): boolean {
        return agent.pmOverrides?.[projectDTag] === true;
    }

    /**
     * Set PM override for an agent in a specific project.
     * Does NOT save the agent - caller must save after making all changes.
     */
    setPMOverride(agent: StoredAgent, projectDTag: string, isPM: boolean): void {
        if (!agent.pmOverrides) {
            agent.pmOverrides = {};
        }
        if (isPM) {
            agent.pmOverrides[projectDTag] = true;
        } else {
            delete agent.pmOverrides[projectDTag];
            // Clean up empty object
            if (Object.keys(agent.pmOverrides).length === 0) {
                delete agent.pmOverrides;
            }
        }
    }

    /**
     * Clear PM override for all agents in a project except the specified one.
     * Returns the list of agents that were modified.
     */
    async clearOtherPMOverrides(
        projectDTag: string,
        exceptPubkey: string
    ): Promise<StoredAgent[]> {
        const projectAgents = await this.getProjectAgents(projectDTag);
        const modifiedAgents: StoredAgent[] = [];

        for (const agent of projectAgents) {
            const signer = new NDKPrivateKeySigner(agent.nsec);
            const pubkey = signer.pubkey;

            if (pubkey !== exceptPubkey && this.hasPMOverride(agent, projectDTag)) {
                this.setPMOverride(agent, projectDTag, false);
                await this.saveAgent(agent);
                modifiedAgents.push(agent);
                logger.info(`Cleared PM override from agent "${agent.slug}" for project ${projectDTag}`);
            }
        }

        return modifiedAgents;
    }

    /**
     * Save an agent and update bySlug/byEventId index entries.
     * Does NOT modify byProject — project associations are managed exclusively
     * by addAgentToProject/removeAgentFromProject.
     */
    async saveAgent(agent: StoredAgent): Promise<void> {
        // Get pubkey from nsec
        const signer = new NDKPrivateKeySigner(agent.nsec);
        const pubkey = signer.pubkey;

        const filePath = path.join(this.agentsDir, `${pubkey}.json`);

        // Load existing agent to check for slug/eventId changes
        const existing = await this.loadAgent(pubkey);

        // Update index
        if (!this.index) await this.loadIndex();
        if (!this.index) return;

        // Save agent file
        await fs.writeFile(filePath, JSON.stringify(agent, null, 2));

        // Remove old slug entry if slug changed
        if (existing && existing.slug !== agent.slug) {
            const oldSlugEntry = this.index.bySlug[existing.slug];
            if (oldSlugEntry && oldSlugEntry.pubkey === pubkey) {
                delete this.index.bySlug[existing.slug];
            }
        }

        // Remove old eventId entry if eventId changed
        if (
            existing?.eventId &&
            existing.eventId !== agent.eventId &&
            this.index.byEventId[existing.eventId] === pubkey
        ) {
            delete this.index.byEventId[existing.eventId];
        }

        // Update bySlug
        this.index.bySlug[agent.slug] = { pubkey };

        // Update byEventId
        if (agent.eventId) {
            this.index.byEventId[agent.eventId] = pubkey;
        }

        // Emit agent.saved trace event
        trace.getActiveSpan()?.addEvent("agent.saved", {
            "agent.slug": agent.slug,
            "agent.pubkey": pubkey,
            "agent.eventId": agent.eventId || "local",
        });

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
        const slugEntry = this.index.bySlug[agent.slug];
        if (slugEntry && slugEntry.pubkey === pubkey) {
            delete this.index.bySlug[agent.slug];
        }

        // Remove from eventId index
        if (agent.eventId && this.index.byEventId[agent.eventId] === pubkey) {
            delete this.index.byEventId[agent.eventId];
        }

        // Remove from project index (scan byProject directly)
        for (const [projectDTag, pubkeys] of Object.entries(this.index.byProject)) {
            const pidx = pubkeys.indexOf(pubkey);
            if (pidx !== -1) {
                pubkeys.splice(pidx, 1);
                if (pubkeys.length === 0) delete this.index.byProject[projectDTag];
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

        const slugEntry = this.index.bySlug[slug];
        if (!slugEntry) return null;

        return this.loadAgent(slugEntry.pubkey);
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
     * Get all agents for a project (uses index for O(1) lookup).
     * Deduplicates by slug within the project.
     */
    async getProjectAgents(projectDTag: string): Promise<StoredAgent[]> {
        if (!this.index) await this.loadIndex();
        if (!this.index) return [];

        const pubkeys = this.index.byProject[projectDTag] || [];
        const agents: StoredAgent[] = [];
        const seenSlugs = new Set<string>();

        for (const pubkey of pubkeys) {
            const agent = await this.loadAgent(pubkey);
            if (!agent) continue;

            if (seenSlugs.has(agent.slug)) {
                logger.warn(`Duplicate slug '${agent.slug}' in project ${projectDTag}`, {
                    pubkey1: agents.find(a => a.slug === agent.slug)
                        ? new NDKPrivateKeySigner(agents.find(a => a.slug === agent.slug)!.nsec).pubkey.substring(0, 8)
                        : "unknown",
                    pubkey2: pubkey.substring(0, 8),
                });
                continue;
            }

            agents.push(agent);
            seenSlugs.add(agent.slug);
        }

        return agents;
    }

    /**
     * Get all projects for an agent (reverse lookup from index.byProject)
     */
    async getAgentProjects(pubkey: string): Promise<string[]> {
        if (!this.index) await this.loadIndex();
        if (!this.index) return [];
        return Object.entries(this.index.byProject)
            .filter(([, pubkeys]) => pubkeys.includes(pubkey))
            .map(([projectDTag]) => projectDTag);
    }

    /**
     * Add an agent to a project (index-only — no agent file modification).
     * Performs slug conflict check before adding.
     */
    async addAgentToProject(pubkey: string, projectDTag: string): Promise<void> {
        if (!this.index) await this.loadIndex();
        if (!this.index) throw new Error("Index not loaded");

        const agent = await this.loadAgent(pubkey);
        if (!agent) throw new Error(`Agent ${pubkey} not found`);

        const projectPubkeys = this.index.byProject[projectDTag] ?? [];
        if (!projectPubkeys.includes(pubkey)) {
            // Slug conflict check: is there already a different agent with the same slug in this project?
            for (const existingPubkey of projectPubkeys) {
                const existingAgent = await this.loadAgent(existingPubkey);
                if (existingAgent && existingAgent.slug === agent.slug) {
                    throw new AgentSlugConflictError(agent.slug, existingPubkey, pubkey);
                }
            }

            if (!this.index.byProject[projectDTag]) this.index.byProject[projectDTag] = [];
            this.index.byProject[projectDTag].push(pubkey);
            this.index.bySlug[agent.slug] = { pubkey };
            await this.saveIndex();
        }
    }

    /**
     * Remove an agent from a project (index-only — no agent file modification).
     * Deletes the agent entirely if it has no projects remaining.
     */
    async removeAgentFromProject(pubkey: string, projectDTag: string): Promise<void> {
        if (!this.index) await this.loadIndex();
        if (!this.index) return;

        const projectPubkeys = this.index.byProject[projectDTag];
        if (!projectPubkeys) return;
        const idx = projectPubkeys.indexOf(pubkey);
        if (idx === -1) return;

        projectPubkeys.splice(idx, 1);
        if (projectPubkeys.length === 0) delete this.index.byProject[projectDTag];

        const remainingProjects = await this.getAgentProjects(pubkey);
        if (remainingProjects.length === 0) {
            await this.deleteAgent(pubkey); // deleteAgent calls saveIndex
            return;
        }
        await this.saveIndex();
    }

    /**
     * Update an agent's default LLM model in persistent storage.
     *
     * @param pubkey - Agent's public key (hex string)
     * @param model - New model string (e.g., "anthropic:claude-sonnet-4")
     * @returns true if updated successfully, false if agent not found
     */
    async updateAgentLLMConfig(pubkey: string, model: string): Promise<boolean> {
        const agent = await this.loadAgent(pubkey);
        if (!agent) {
            logger.warn(`Agent with pubkey ${pubkey} not found`);
            return false;
        }

        if (!agent.default) agent.default = {};
        agent.default.model = model;
        await this.saveAgent(agent);
        logger.info(`Updated LLM config for agent ${agent.name}`);
        return true;
    }

    /**
     * Update an agent's default tools list in persistent storage.
     *
     * @param pubkey - Agent's public key (hex string)
     * @param tools - New tools array
     * @returns true if updated successfully, false if agent not found
     */
    async updateAgentTools(pubkey: string, tools: string[]): Promise<boolean> {
        const agent = await this.loadAgent(pubkey);
        if (!agent) {
            logger.warn(`Agent with pubkey ${pubkey} not found`);
            return false;
        }

        if (!agent.default) agent.default = {};
        agent.default.tools = tools;
        await this.saveAgent(agent);
        logger.info(`Updated tools for agent ${agent.name}`);
        return true;
    }

    /**
     * Update an agent's global PM designation flag.
     *
     * @param pubkey - Agent's public key (hex string)
     * @param isPM - Whether this agent is designated as PM (true/false/undefined to clear)
     * @returns true if updated successfully, false if agent not found
     */
    async updateAgentIsPM(pubkey: string, isPM: boolean | undefined): Promise<boolean> {
        const agent = await this.loadAgent(pubkey);
        if (!agent) {
            logger.warn(`Agent with pubkey ${pubkey} not found`);
            return false;
        }

        if (isPM === undefined || isPM === false) {
            delete agent.isPM;
        } else {
            agent.isPM = true;
        }

        await this.saveAgent(agent);
        logger.info(`Updated isPM flag for agent ${agent.name}`, { isPM: agent.isPM });
        return true;
    }

    /**
     * Get the effective (resolved) config for an agent, optionally scoped to a project.
     *
     * @param agent - The stored agent
     * @param projectDTag - Optional project dTag for project-scoped resolution
     * @returns ResolvedAgentConfig with effective model and tools
     */
    getEffectiveConfig(agent: StoredAgent, projectDTag?: string): ResolvedAgentConfig {
        const defaultConfig: AgentDefaultConfig = {
            model: agent.default?.model,
            tools: agent.default?.tools,
        };

        const projectConfig = projectDTag
            ? agent.projectOverrides?.[projectDTag]
            : undefined;

        return resolveEffectiveConfig(defaultConfig, projectConfig);
    }

    /**
     * Resolve the effective LLM config for an agent in a specific project.
     * Priority: projectOverrides[projectDTag].model > default.model
     */
    resolveEffectiveLLMConfig(agent: StoredAgent, projectDTag: string): string | undefined {
        return this.getEffectiveConfig(agent, projectDTag).model;
    }

    /**
     * Resolve the effective tools for an agent in a specific project.
     * Priority: projectOverrides[projectDTag].tools > default.tools
     * Supports delta syntax in projectOverrides (+tool / -tool).
     */
    resolveEffectiveTools(agent: StoredAgent, projectDTag: string): string[] | undefined {
        return this.getEffectiveConfig(agent, projectDTag).tools;
    }

    /**
     * Resolve the effective PM status for an agent in a specific project.
     * Priority:
     * 1. agent.isPM (global PM designation via kind 24020 without a-tag)
     * 2. projectOverrides[projectDTag].isPM (project-scoped PM via kind 24020 with a-tag)
     * 3. pmOverrides[projectDTag] (from agent_configure tool)
     */
    resolveEffectiveIsPM(agent: StoredAgent, projectDTag: string): boolean {
        if (agent.isPM === true) {
            return true;
        }
        if (agent.projectOverrides?.[projectDTag]?.isPM === true) {
            return true;
        }
        return agent.pmOverrides?.[projectDTag] === true;
    }

    // =========================================================================
    // NEW SCHEMA METHODS
    // =========================================================================

    /**
     * Update an agent's default configuration block.
     *
     * A 24020 event with NO a-tag should call this method.
     * Writes to the `default` block in the agent file.
     *
     * @param pubkey - Agent's public key
     * @param updates - Fields to update. Only defined fields are applied.
     * @returns true if updated successfully, false if agent not found
     */
    async updateDefaultConfig(
        pubkey: string,
        updates: AgentDefaultConfig
    ): Promise<boolean> {
        const agent = await this.loadAgent(pubkey);
        if (!agent) {
            logger.warn(`Agent with pubkey ${pubkey} not found`);
            return false;
        }

        if (!agent.default) {
            agent.default = {};
        }

        if (updates.model !== undefined) {
            agent.default.model = updates.model;
        }

        if (updates.tools !== undefined) {
            if (updates.tools.length > 0) {
                agent.default.tools = updates.tools;
            } else {
                delete agent.default.tools;
            }
        }

        // Clean up empty default block
        if (agent.default && Object.keys(agent.default).length === 0) {
            delete agent.default;
        }

        await this.saveAgent(agent);
        logger.info(`Updated default config for agent ${agent.name}`, { updates });
        return true;
    }

    /**
     * Update an agent's per-project override configuration.
     *
     * A 24020 event WITH an a-tag should call this method.
     * Writes to `projectOverrides[projectDTag]`.
     *
     * If any provided values equal the defaults after resolution, they are cleared
     * from the override (dedup logic) to keep overrides minimal.
     *
     * If `reset` is true, clears the entire project override.
     *
     * @param pubkey - Agent's public key
     * @param projectDTag - Project dTag to scope the config to
     * @param override - The new project override (full replacement, not merge)
     * @param reset - If true, clear the entire project override instead of setting it
     * @returns true if updated successfully, false if agent not found
     */
    async updateProjectOverride(
        pubkey: string,
        projectDTag: string,
        override: AgentProjectConfig,
        reset = false
    ): Promise<boolean> {
        const agent = await this.loadAgent(pubkey);
        if (!agent) {
            logger.warn(`Agent with pubkey ${pubkey} not found`);
            return false;
        }

        if (reset) {
            if (agent.projectOverrides) {
                delete agent.projectOverrides[projectDTag];
                if (Object.keys(agent.projectOverrides).length === 0) {
                    delete agent.projectOverrides;
                }
            }
            logger.info(`Cleared project override for agent ${agent.name}`, { projectDTag });
        } else {
            const defaultConfig: AgentDefaultConfig = {
                model: agent.default?.model,
                tools: agent.default?.tools,
            };

            const deduplicated = deduplicateProjectConfig(defaultConfig, override);

            if (!agent.projectOverrides) {
                agent.projectOverrides = {};
            }

            if (Object.keys(deduplicated).length === 0) {
                delete agent.projectOverrides[projectDTag];
                if (Object.keys(agent.projectOverrides).length === 0) {
                    delete agent.projectOverrides;
                }
                logger.info(`Project override for ${projectDTag} cleared (all fields match defaults)`, {
                    agentSlug: agent.slug,
                });
            } else {
                agent.projectOverrides[projectDTag] = deduplicated;
                logger.info(`Updated project override for agent ${agent.name}`, {
                    projectDTag,
                    override: deduplicated,
                });
            }
        }

        await this.saveAgent(agent);
        return true;
    }

    /**
     * Update an agent's project-scoped LLM configuration.
     *
     * @param pubkey - Agent's public key
     * @param projectDTag - Project dTag to scope the config to
     * @param model - New LLM configuration (undefined to clear)
     * @returns true if updated successfully, false if agent not found
     */
    async updateProjectScopedLLMConfig(
        pubkey: string,
        projectDTag: string,
        model: string | undefined
    ): Promise<boolean> {
        const agent = await this.loadAgent(pubkey);
        if (!agent) {
            logger.warn(`Agent with pubkey ${pubkey} not found`);
            return false;
        }

        if (!agent.projectOverrides) {
            agent.projectOverrides = {};
        }
        const existing = agent.projectOverrides[projectDTag] ?? {};
        if (model !== undefined) {
            existing.model = model;
        } else {
            delete existing.model;
        }
        if (Object.keys(existing).length > 0) {
            agent.projectOverrides[projectDTag] = existing;
        } else {
            delete agent.projectOverrides[projectDTag];
            if (Object.keys(agent.projectOverrides).length === 0) {
                delete agent.projectOverrides;
            }
        }

        await this.saveAgent(agent);
        logger.info(`Updated project-scoped LLM config for agent ${agent.name}`, {
            projectDTag,
            model,
        });
        return true;
    }

    /**
     * Update an agent's project-scoped tools list.
     *
     * @param pubkey - Agent's public key
     * @param projectDTag - Project dTag to scope the config to
     * @param tools - New tools array (undefined to clear)
     * @returns true if updated successfully, false if agent not found
     */
    async updateProjectScopedTools(
        pubkey: string,
        projectDTag: string,
        tools: string[] | undefined
    ): Promise<boolean> {
        const agent = await this.loadAgent(pubkey);
        if (!agent) {
            logger.warn(`Agent with pubkey ${pubkey} not found`);
            return false;
        }

        if (!agent.projectOverrides) {
            agent.projectOverrides = {};
        }
        const existing = agent.projectOverrides[projectDTag] ?? {};
        if (tools !== undefined && tools.length > 0) {
            existing.tools = tools;
        } else {
            delete existing.tools;
        }
        if (Object.keys(existing).length > 0) {
            agent.projectOverrides[projectDTag] = existing;
        } else {
            delete agent.projectOverrides[projectDTag];
            if (Object.keys(agent.projectOverrides).length === 0) {
                delete agent.projectOverrides;
            }
        }

        await this.saveAgent(agent);
        logger.info(`Updated project-scoped tools for agent ${agent.name}`, {
            projectDTag,
            toolCount: tools?.length,
        });
        return true;
    }

    /**
     * Update an agent's project-scoped PM designation.
     *
     * @param pubkey - Agent's public key
     * @param projectDTag - Project dTag to scope the config to
     * @param isPM - PM designation (true/false/undefined to clear)
     * @returns true if updated successfully, false if agent not found
     */
    async updateProjectScopedIsPM(
        pubkey: string,
        projectDTag: string,
        isPM: boolean | undefined
    ): Promise<boolean> {
        const agent = await this.loadAgent(pubkey);
        if (!agent) {
            logger.warn(`Agent with pubkey ${pubkey} not found`);
            return false;
        }

        if (!agent.projectOverrides) {
            agent.projectOverrides = {};
        }
        const existing = agent.projectOverrides[projectDTag] ?? {};

        if (isPM === true) {
            existing.isPM = true;
        } else {
            delete existing.isPM;
        }

        if (Object.keys(existing).length > 0) {
            agent.projectOverrides[projectDTag] = existing;
        } else {
            delete agent.projectOverrides[projectDTag];
            if (Object.keys(agent.projectOverrides).length === 0) {
                delete agent.projectOverrides;
            }
        }

        await this.saveAgent(agent);
        logger.info(`Updated project-scoped PM flag for agent ${agent.name}`, {
            projectDTag,
            isPM,
        });
        return true;
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
