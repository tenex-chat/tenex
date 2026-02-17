import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { StoredAgentData, ProjectScopedConfig, AgentDefaultConfig, AgentProjectConfig } from "@/agents/types";
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
 * ## New Configuration Schema (v1)
 * Agent config is split into:
 * - `default`: Global defaults (model, tools). Written by 24020 without a-tag.
 * - `projects`: Per-project overrides map. Written by 24020 with a-tag.
 *   Tools can use delta syntax (+tool / -tool) or full replacement.
 *
 * ## Legacy Fields (kept for migration compatibility)
 * - `llmConfig`: Old global model field → migrated to `default.model`
 * - `tools` (on StoredAgentData): Old global tools field → migrated to `default.tools`
 * - `projectConfigs`: Old per-project config → migrated to `projects`
 */
export interface StoredAgent extends StoredAgentData {
    eventId?: string;
    nsec: string;
    slug: string;
    projects: string[]; // Array of project dTags
    /**
     * @deprecated Use pmOverrides instead. Kept for backward compatibility.
     * Will be migrated to pmOverrides on first save.
     */
    isPMOverride?: boolean;
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
    /**
     * @deprecated Use `projects` map instead. Kept for backward compatibility / migration.
     * Project-scoped configuration overrides (old schema).
     * Migrated to `projects` on first load.
     */
    projectConfigs?: Record<string, ProjectScopedConfig>;

    // NOTE: `default` and `projectOverrides` are defined in StoredAgentData (new schema v1).
    // They are listed here as documentation of the priority chain:
    //
    // ## Configuration Priority
    // 1. projectOverrides[projectDTag].* (project-scoped override, new schema)
    // 2. default.* (global defaults, new schema)
    // 3. StoredAgentData top-level llmConfig/tools (legacy, deprecated)
}

/**
 * Factory function to create a StoredAgent object.
 *
 * Ensures consistent structure and defaults across the codebase.
 * Used by both agent-installer (Nostr agents) and agents_write (local agents).
 *
 * ## Why this exists
 * Before: StoredAgent objects were manually constructed in 2 places with slight differences
 * After: Single factory ensures consistency and makes schema changes easier
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
 *   tools: ['fs_read', 'shell'],
 *   eventId: 'nostr_event_id',
 *   projects: ['project-dtag']
 * });
 * await agentStorage.saveAgent(agent);
 */
export function createStoredAgent(config: {
    nsec: string;
    slug: string;
    name: string;
    role: string;
    description?: string | null;
    instructions?: string | null;
    useCriteria?: string | null;
    /** @deprecated Use defaultConfig.model instead */
    llmConfig?: string;
    /** @deprecated Use defaultConfig.tools instead */
    tools?: string[] | null;
    eventId?: string;
    projects?: string[];
    mcpServers?: Record<string, MCPServerConfig>;
    /** @deprecated Use pmOverrides instead */
    isPMOverride?: boolean;
    pmOverrides?: Record<string, boolean>;
    /** @deprecated Use projectOverrides instead */
    projectConfigs?: Record<string, ProjectScopedConfig>;
    /** New: default config block */
    defaultConfig?: AgentDefaultConfig;
    /** New: per-project overrides map */
    projectOverrides?: Record<string, AgentProjectConfig>;
}): StoredAgent {
    // Build default config block - prefer new defaultConfig, fall back to legacy llmConfig/tools
    const defaultConfig: AgentDefaultConfig | undefined =
        config.defaultConfig ??
        (config.llmConfig || config.tools
            ? {
                  model: config.llmConfig,
                  tools: config.tools ?? undefined,
              }
            : undefined);

    return {
        eventId: config.eventId,
        nsec: config.nsec,
        slug: config.slug,
        name: config.name,
        role: config.role,
        description: config.description ?? undefined,
        instructions: config.instructions ?? undefined,
        useCriteria: config.useCriteria ?? undefined,
        // Keep legacy fields for backward compat (will be migrated on load)
        llmConfig: config.llmConfig,
        tools: config.tools ?? undefined,
        projects: config.projects ?? [],
        mcpServers: config.mcpServers,
        pmOverrides: config.pmOverrides,
        projectConfigs: config.projectConfigs,
        // New schema fields
        default: defaultConfig,
        projectOverrides: config.projectOverrides,
    };
}

/**
 * Slug index entry tracking which projects use this slug
 */
interface SlugEntry {
    pubkey: string;
    projects: string[];
}

/**
 * Index structure for fast lookups
 */
interface AgentIndex {
    bySlug: Record<string, SlugEntry>; // slug -> { pubkey, projects[] }
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
 *
 * ## Separation of Concerns
 * - Storage (this class): Disk persistence only
 * - Registry (AgentRegistry): Runtime instances only
 * - Updates: storage.update() → registry.reload()
 *
 * @example
 * // Load agent from disk
 * const agent = await agentStorage.loadAgent(pubkey);
 *
 * // Update configuration
 * await agentStorage.updateAgentLLMConfig(pubkey, 'anthropic:claude-opus-4');
 *
 * // Refresh in-memory instance
 * await agentRegistry.reloadAgent(pubkey);
 *
 * @see AgentRegistry for in-memory runtime management
 * @see agent-loader for loading orchestration
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
     * Handles migration from old flat slug index to new SlugEntry structure.
     */
    private async loadIndex(): Promise<void> {
        if (await fileExists(this.indexPath)) {
            try {
                const content = await fs.readFile(this.indexPath, "utf-8");
                const rawIndex = JSON.parse(content);

                // Detect old format: bySlug is Record<string, string> instead of Record<string, SlugEntry>
                const needsMigration = rawIndex.bySlug &&
                    Object.values(rawIndex.bySlug).some((val: any) => typeof val === "string");

                if (needsMigration) {
                    logger.info("Migrating agent index from old format to multi-project slug structure");
                    this.index = this.migrateIndexFormat(rawIndex);
                    await this.saveIndex();
                    logger.info("Agent index migration complete", {
                        slugCount: Object.keys(this.index.bySlug).length,
                    });
                } else {
                    this.index = rawIndex;
                }
            } catch (error) {
                logger.error("Failed to load agent index, creating new one", { error });
                this.index = { bySlug: {}, byEventId: {}, byProject: {} };
            }
        } else {
            this.index = { bySlug: {}, byEventId: {}, byProject: {} };
        }
    }

    /**
     * Migrate index from old flat format to new SlugEntry structure.
     * Old format: bySlug[slug] = pubkey
     * New format: bySlug[slug] = { pubkey, projects: [] }
     */
    private migrateIndexFormat(oldIndex: any): AgentIndex {
        const newIndex: AgentIndex = {
            bySlug: {},
            byEventId: oldIndex.byEventId || {},
            byProject: oldIndex.byProject || {},
        };

        // Build reverse lookup: pubkey -> projects[]
        const pubkeyToProjects: Record<string, string[]> = {};
        for (const [projectDTag, pubkeys] of Object.entries(oldIndex.byProject || {})) {
            for (const pubkey of (pubkeys as string[])) {
                if (!pubkeyToProjects[pubkey]) {
                    pubkeyToProjects[pubkey] = [];
                }
                pubkeyToProjects[pubkey].push(projectDTag);
            }
        }

        // Convert slug index
        for (const [slug, pubkey] of Object.entries(oldIndex.bySlug || {})) {
            if (typeof pubkey === "string") {
                newIndex.bySlug[slug] = {
                    pubkey,
                    projects: pubkeyToProjects[pubkey] || [],
                };
            } else {
                // Already in new format
                newIndex.bySlug[slug] = pubkey as SlugEntry;
            }
        }

        return newIndex;
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

                // Update slug index with multi-project support
                const existingEntry = index.bySlug[agent.slug];
                if (existingEntry) {
                    if (existingEntry.pubkey !== pubkey) {
                        logger.warn(`Slug conflict during rebuild: '${agent.slug}'`, {
                            existingPubkey: existingEntry.pubkey.substring(0, 8),
                            newPubkey: pubkey.substring(0, 8),
                        });
                    } else {
                        // Same agent in multiple projects - add projects to list
                        existingEntry.projects = [
                            ...new Set([...existingEntry.projects, ...agent.projects]),
                        ];
                    }
                } else {
                    index.bySlug[agent.slug] = {
                        pubkey,
                        projects: [...agent.projects],
                    };
                }

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
            const agent: StoredAgent = JSON.parse(content);

            let needsSave = false;

            // Migration 1: legacy isPMOverride -> pmOverrides
            if (agent.isPMOverride !== undefined && !agent.pmOverrides) {
                // If the agent had a global PM override, apply it to all their projects
                if (agent.isPMOverride && agent.projects.length > 0) {
                    agent.pmOverrides = {};
                    for (const projectDTag of agent.projects) {
                        agent.pmOverrides[projectDTag] = true;
                    }
                    logger.info(`Migrated legacy isPMOverride for agent ${agent.slug} to pmOverrides`, {
                        projects: agent.projects,
                    });
                }
                // Clear legacy field
                delete agent.isPMOverride;
                needsSave = true;
            }

            // Migration 2: top-level llmConfig/tools -> default block
            // Also migrate projectConfigs -> projectOverrides
            if (!agent.default) {
                const oldLlmConfig = agent.llmConfig;
                const oldTools = agent.tools;

                if (oldLlmConfig || oldTools) {
                    agent.default = {};
                    if (oldLlmConfig) agent.default.model = oldLlmConfig;
                    if (oldTools) agent.default.tools = oldTools;
                    logger.info(`Migrated legacy llmConfig/tools to default block for agent ${agent.slug}`);
                    needsSave = true;
                }
            }

            // Migration 3: projectConfigs -> projectOverrides
            // Only migrate llmConfig and tools; isPM stays in projectConfigs since it's not in AgentProjectConfig
            if (agent.projectConfigs && !agent.projectOverrides) {
                agent.projectOverrides = {};
                const remainingProjectConfigs: Record<string, ProjectScopedConfig> = {};

                for (const [projectDTag, oldConfig] of Object.entries(agent.projectConfigs)) {
                    const newConfig: AgentProjectConfig = {};
                    if (oldConfig.llmConfig) newConfig.model = oldConfig.llmConfig;
                    if (oldConfig.tools && oldConfig.tools.length > 0) newConfig.tools = oldConfig.tools;
                    if (Object.keys(newConfig).length > 0) {
                        agent.projectOverrides[projectDTag] = newConfig;
                    }
                    // Keep isPM in projectConfigs (it's not part of AgentProjectConfig)
                    if (oldConfig.isPM === true) {
                        remainingProjectConfigs[projectDTag] = { isPM: true };
                    }
                }

                if (Object.keys(agent.projectOverrides).length === 0) {
                    delete agent.projectOverrides;
                }

                // Replace projectConfigs with only the isPM entries (if any)
                if (Object.keys(remainingProjectConfigs).length > 0) {
                    agent.projectConfigs = remainingProjectConfigs;
                } else {
                    delete agent.projectConfigs;
                }

                logger.info(`Migrated projectConfigs to projectOverrides for agent ${agent.slug}`);
                needsSave = true;
            }

            if (needsSave) {
                // Back up original before first migration save
                const backupPath = filePath + ".bak";
                if (!(await fileExists(backupPath))) {
                    await fs.copyFile(filePath, backupPath);
                    logger.info(`Backed up agent file before migration: ${agent.slug}`);
                }
                await fs.writeFile(filePath, JSON.stringify(agent, null, 2));
            }

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
     * Clean up old agents with the same slug in overlapping projects.
     * When a new agent is saved with a slug that already exists,
     * remove the old agent from projects that overlap with the new agent.
     */
    private async cleanupDuplicateSlugs(
        slug: string,
        newPubkey: string,
        newProjects: string[]
    ): Promise<void> {
        if (!this.index) await this.loadIndex();
        if (!this.index) return;

        const existingEntry = this.index.bySlug[slug];
        if (!existingEntry || existingEntry.pubkey === newPubkey) return;

        const existingAgent = await this.loadAgent(existingEntry.pubkey);
        if (!existingAgent) return;

        // Find overlapping projects
        const overlappingProjects = existingAgent.projects.filter((p) => newProjects.includes(p));
        if (overlappingProjects.length === 0) return;

        logger.info(`Cleaning up duplicate slug '${slug}'`, {
            oldPubkey: existingEntry.pubkey.substring(0, 8),
            newPubkey: newPubkey.substring(0, 8),
            overlappingProjects,
        });

        // Remove old agent from overlapping projects
        for (const projectDTag of overlappingProjects) {
            await this.removeAgentFromProject(existingEntry.pubkey, projectDTag);

            // Update slug entry's project list
            existingEntry.projects = existingEntry.projects.filter(p => p !== projectDTag);
        }

        // If old agent has no projects left, remove the slug entry entirely
        if (existingEntry.projects.length === 0) {
            delete this.index.bySlug[slug];
            logger.info(`Removed slug entry for '${slug}' - no projects remaining`);
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

        // Update index
        if (!this.index) await this.loadIndex();
        if (!this.index) return;

        // Clean up old agents with same slug in overlapping projects FIRST
        // This modifies the index to remove conflicts before we check
        await this.cleanupDuplicateSlugs(agent.slug, pubkey, agent.projects);

        // Check for slug conflicts AFTER cleanup
        // Re-fetch the slug entry since cleanup may have modified it
        const existingSlugEntry = this.index.bySlug[agent.slug];
        if (existingSlugEntry && existingSlugEntry.pubkey !== pubkey) {
            // Check if there are STILL overlapping projects after cleanup
            const overlappingProjects = agent.projects.filter(p =>
                existingSlugEntry.projects.includes(p)
            );

            if (overlappingProjects.length > 0) {
                // Different agent trying to use this slug in overlapping projects
                // This should only happen if cleanup failed or wasn't complete
                trace.getActiveSpan()?.addEvent("agent.slug_conflict_detected", {
                    "conflict.slug": agent.slug,
                    "conflict.existing_pubkey": existingSlugEntry.pubkey,
                    "conflict.attempted_pubkey": pubkey,
                    "conflict.overlapping_projects": overlappingProjects.join(", "),
                });

                throw new AgentSlugConflictError(
                    agent.slug,
                    existingSlugEntry.pubkey,
                    pubkey
                );
            }
        }

        // Save agent file
        await fs.writeFile(filePath, JSON.stringify(agent, null, 2));

        // Remove old index entries if slug or eventId changed
        if (existing) {
            if (existing.slug !== agent.slug) {
                const oldSlugEntry = this.index.bySlug[existing.slug];
                if (oldSlugEntry && oldSlugEntry.pubkey === pubkey) {
                    // Remove this agent's projects from the old slug entry
                    oldSlugEntry.projects = oldSlugEntry.projects.filter(
                        p => !agent.projects.includes(p)
                    );
                    // Delete entry if no projects remain
                    if (oldSlugEntry.projects.length === 0) {
                        delete this.index.bySlug[existing.slug];
                    }
                }
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

        // Update slug entry to match agent's CURRENT projects (not additive)
        // Re-fetch after cleanup since cleanup may have modified it
        const currentSlugEntry = this.index.bySlug[agent.slug];

        if (currentSlugEntry && currentSlugEntry.pubkey === pubkey) {
            // Same agent - SYNC to current projects (not additive)
            // This ensures projects are removed when agent leaves them
            const hadProjects = currentSlugEntry.projects;
            currentSlugEntry.projects = [...agent.projects];

            // Only emit event when projects actually increased (new project added)
            const addedProjects = agent.projects.filter(p => !hadProjects.includes(p));
            if (addedProjects.length > 0 && currentSlugEntry.projects.length > 1) {
                trace.getActiveSpan()?.addEvent("agent.slug_shared_across_projects", {
                    "slug.shared": agent.slug,
                    "slug.pubkey": pubkey,
                    "slug.projects_count": currentSlugEntry.projects.length,
                    "slug.projects": currentSlugEntry.projects.join(", "),
                    "slug.added_projects": addedProjects.join(", "),
                });
            }
        } else {
            // New slug entry (either brand new or cleanup removed old one)
            this.index.bySlug[agent.slug] = {
                pubkey,
                projects: [...agent.projects],
            };
        }

        // Update eventId index (for all agents, not just Nostr agents)
        if (agent.eventId) {
            this.index.byEventId[agent.eventId] = pubkey;
        }

        // Emit agent.saved for ALL agents (local and Nostr)
        trace.getActiveSpan()?.addEvent("agent.saved", {
            "agent.slug": agent.slug,
            "agent.pubkey": pubkey,
            "agent.eventId": agent.eventId || "local",
            "agent.projects": agent.projects.join(", "),
        });

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
        const slugEntry = this.index.bySlug[agent.slug];
        if (slugEntry && slugEntry.pubkey === pubkey) {
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
     *
     * Note: Multiple agents can have the same slug across different projects,
     * but within a single project, each slug should be unique. If somehow
     * multiple agents with the same slug are in the same project, we keep
     * only the first one encountered.
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

            // Skip if we've already seen this slug in THIS project
            // This handles the edge case of corrupted index where multiple
            // agents with same slug are in byProject[projectDTag]
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
     * Get all projects for an agent (reverse lookup by pubkey)
     */
    async getAgentProjects(pubkey: string): Promise<string[]> {
        const agent = await this.loadAgent(pubkey);
        return agent?.projects || [];
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
     * Update an agent's LLM configuration in persistent storage.
     *
     * Updates ONLY the stored data on disk. To refresh the in-memory instance,
     * call AgentRegistry.reloadAgent() after this method.
     *
     * ## Architecture Note
     * This is part of the clean separation between storage and runtime:
     * - Storage (this): Handles persistence
     * - Registry: Handles runtime instances
     * - Pattern: storage.update() → registry.reload()
     *
     * @param pubkey - Agent's public key (hex string)
     * @param llmConfig - New LLM configuration string (e.g., "anthropic:claude-sonnet-4")
     * @returns true if updated successfully, false if agent not found
     *
     * @example
     * // Update config
     * const success = await agentStorage.updateAgentLLMConfig(
     *   agentPubkey,
     *   'anthropic:claude-opus-4'
     * );
     *
     * if (success) {
     *   // Refresh in-memory instance
     *   await agentRegistry.reloadAgent(agentPubkey);
     * }
     */
    async updateAgentLLMConfig(pubkey: string, llmConfig: string): Promise<boolean> {
        const agent = await this.loadAgent(pubkey);
        if (!agent) {
            logger.warn(`Agent with pubkey ${pubkey} not found`);
            return false;
        }

        agent.llmConfig = llmConfig;
        await this.saveAgent(agent);
        logger.info(`Updated LLM config for agent ${agent.name}`);
        return true;
    }

    /**
     * Update an agent's tools list in persistent storage.
     *
     * Updates ONLY the stored data on disk. To refresh the in-memory instance,
     * call AgentRegistry.reloadAgent() after this method.
     *
     * ## Important
     * This stores the RAW tool list as-is. Tool normalization (adding core tools,
     * delegate tools, etc.) happens when creating AgentInstance in agent-loader.
     *
     * @param pubkey - Agent's public key (hex string)
     * @param tools - New tools array (will be normalized during instance creation)
     * @returns true if updated successfully, false if agent not found
     *
     * @example
     * // Update tools
     * const newTools = ['fs_read', 'shell', 'agents_write'];
     * const success = await agentStorage.updateAgentTools(agentPubkey, newTools);
     *
     * if (success) {
     *   // Refresh in-memory instance (will apply normalization)
     *   await agentRegistry.reloadAgent(agentPubkey);
     * }
     */
    async updateAgentTools(pubkey: string, tools: string[]): Promise<boolean> {
        const agent = await this.loadAgent(pubkey);
        if (!agent) {
            logger.warn(`Agent with pubkey ${pubkey} not found`);
            return false;
        }

        agent.tools = tools;
        await this.saveAgent(agent);
        logger.info(`Updated tools for agent ${agent.name}`);
        return true;
    }

    /**
     * Update an agent's global PM designation flag.
     *
     * When isPM is true, this agent becomes the PM for ALL projects where it exists.
     * This takes precedence over pmOverrides and project tag designations.
     *
     * Updates ONLY the stored data on disk. To refresh the in-memory instance,
     * call AgentRegistry.reloadAgent() after this method.
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
            // Clear the flag if it exists
            delete agent.isPM;
        } else {
            agent.isPM = true;
        }

        await this.saveAgent(agent);
        logger.info(`Updated isPM flag for agent ${agent.name}`, { isPM: agent.isPM });
        return true;
    }

    // =========================================================================
    // PROJECT-SCOPED CONFIGURATION METHODS
    // =========================================================================

    /**
     * Get project-scoped configuration for an agent.
     * Returns undefined if no project-scoped config exists.
     */
    getProjectConfig(agent: StoredAgent, projectDTag: string): ProjectScopedConfig | undefined {
        return agent.projectConfigs?.[projectDTag];
    }

    /**
     * Set project-scoped configuration for an agent.
     * Does NOT save the agent - caller must save after making all changes.
     *
     * @param agent - The agent to modify
     * @param projectDTag - The project dTag to set config for
     * @param config - The configuration to set (partial update - merges with existing)
     */
    setProjectConfig(
        agent: StoredAgent,
        projectDTag: string,
        config: Partial<ProjectScopedConfig>
    ): void {
        if (!agent.projectConfigs) {
            agent.projectConfigs = {};
        }

        const existing = agent.projectConfigs[projectDTag] || {};
        agent.projectConfigs[projectDTag] = { ...existing, ...config };

        // Clean up undefined values
        const projectConfig = agent.projectConfigs[projectDTag];
        if (projectConfig.llmConfig === undefined) delete projectConfig.llmConfig;
        if (projectConfig.tools === undefined) delete projectConfig.tools;
        if (projectConfig.isPM === undefined) delete projectConfig.isPM;

        // Clean up empty config
        if (Object.keys(projectConfig).length === 0) {
            delete agent.projectConfigs[projectDTag];
        }

        // Clean up empty projectConfigs
        if (Object.keys(agent.projectConfigs).length === 0) {
            delete agent.projectConfigs;
        }
    }

    /**
     * Clear project-scoped configuration for an agent.
     * Does NOT save the agent - caller must save after making all changes.
     */
    clearProjectConfig(agent: StoredAgent, projectDTag: string): void {
        if (agent.projectConfigs) {
            delete agent.projectConfigs[projectDTag];
            if (Object.keys(agent.projectConfigs).length === 0) {
                delete agent.projectConfigs;
            }
        }
    }

    /**
     * Get the effective (resolved) config for an agent, optionally scoped to a project.
     *
     * Merges default config with project override (using delta tool logic if needed).
     *
     * @param agent - The stored agent
     * @param projectDTag - Optional project dTag for project-scoped resolution
     * @returns ResolvedAgentConfig with effective model and tools
     */
    getEffectiveConfig(agent: StoredAgent, projectDTag?: string): ResolvedAgentConfig {
        // Build default config - prefer new `default` block, fall back to legacy fields
        const defaultConfig: AgentDefaultConfig = {
            model: agent.default?.model ?? agent.llmConfig,
            tools: agent.default?.tools ?? agent.tools,
        };

        const projectConfig = projectDTag
            ? (agent.projectOverrides?.[projectDTag] ??
               // Also check legacy projectConfigs for backward compat
               (agent.projectConfigs?.[projectDTag]
                   ? {
                         model: agent.projectConfigs[projectDTag].llmConfig,
                         tools: agent.projectConfigs[projectDTag].tools,
                     }
                   : undefined))
            : undefined;

        return resolveEffectiveConfig(defaultConfig, projectConfig);
    }

    /**
     * Resolve the effective LLM config for an agent in a specific project.
     * Priority: projectOverrides[projectDTag].model > default.model > legacy llmConfig
     */
    resolveEffectiveLLMConfig(agent: StoredAgent, projectDTag: string): string | undefined {
        return this.getEffectiveConfig(agent, projectDTag).model;
    }

    /**
     * Resolve the effective tools for an agent in a specific project.
     * Priority: projectOverrides[projectDTag].tools > default.tools > legacy tools
     * Supports delta syntax in projectOverrides (+tool / -tool).
     */
    resolveEffectiveTools(agent: StoredAgent, projectDTag: string): string[] | undefined {
        return this.getEffectiveConfig(agent, projectDTag).tools;
    }

    /**
     * Resolve the effective PM status for an agent in a specific project.
     * Priority:
     * 1. agent.isPM (global PM designation via kind 24020 without a-tag)
     * 2. projectConfigs[projectDTag].isPM (project-scoped PM via kind 24020 with a-tag)
     * 3. pmOverrides[projectDTag] (legacy, from agent_configure tool)
     */
    resolveEffectiveIsPM(agent: StoredAgent, projectDTag: string): boolean {
        // Global PM takes highest priority
        if (agent.isPM === true) {
            return true;
        }
        // Project-scoped PM from kind 24020 with a-tag (legacy projectConfigs)
        if (agent.projectConfigs?.[projectDTag]?.isPM === true) {
            return true;
        }
        // Legacy pmOverrides (backward compatibility)
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
     * @param updates - Fields to update. Only defined fields are applied:
     *   - model: updated when defined; ignored (no change) when undefined
     *   - tools: updated when defined; empty array clears the tools list; ignored when undefined
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
            // Keep legacy field in sync for backward compat
            agent.llmConfig = updates.model;
        }

        if (updates.tools !== undefined) {
            if (updates.tools.length > 0) {
                agent.default.tools = updates.tools;
                // Keep legacy field in sync for backward compat
                agent.tools = updates.tools;
            } else {
                // Empty list clears the default
                delete agent.default.tools;
                delete agent.tools;
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
            // Clear the entire project override
            if (agent.projectOverrides) {
                delete agent.projectOverrides[projectDTag];
                if (Object.keys(agent.projectOverrides).length === 0) {
                    delete agent.projectOverrides;
                }
            }
            logger.info(`Cleared project override for agent ${agent.name}`, { projectDTag });
        } else {
            // Build the effective default for dedup comparison
            const defaultConfig: AgentDefaultConfig = {
                model: agent.default?.model ?? agent.llmConfig,
                tools: agent.default?.tools ?? agent.tools,
            };

            // Run dedup: remove fields that are identical to defaults
            const deduplicated = deduplicateProjectConfig(defaultConfig, override);

            if (!agent.projectOverrides) {
                agent.projectOverrides = {};
            }

            if (Object.keys(deduplicated).length === 0) {
                // All fields equal defaults - remove the override entirely
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
     * @param llmConfig - New LLM configuration (undefined to clear)
     * @returns true if updated successfully, false if agent not found
     */
    async updateProjectScopedLLMConfig(
        pubkey: string,
        projectDTag: string,
        llmConfig: string | undefined
    ): Promise<boolean> {
        const agent = await this.loadAgent(pubkey);
        if (!agent) {
            logger.warn(`Agent with pubkey ${pubkey} not found`);
            return false;
        }

        // Write to new schema (projectOverrides)
        if (!agent.projectOverrides) {
            agent.projectOverrides = {};
        }
        const existing = agent.projectOverrides[projectDTag] ?? {};
        if (llmConfig !== undefined) {
            existing.model = llmConfig;
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
            llmConfig,
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

        // Write to new schema (projectOverrides)
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

        if (isPM === true) {
            this.setProjectConfig(agent, projectDTag, { isPM: true });
        } else {
            // Clear the project-scoped PM flag
            const existing = agent.projectConfigs?.[projectDTag];
            if (existing) {
                delete existing.isPM;
                // Clean up if empty
                if (Object.keys(existing).length === 0) {
                    delete agent.projectConfigs![projectDTag];
                    if (Object.keys(agent.projectConfigs!).length === 0) {
                        delete agent.projectConfigs;
                    }
                }
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
     * Update an agent's complete project-scoped configuration.
     * This is an authoritative update - it replaces the entire project config.
     *
     * @deprecated Prefer using `updateProjectOverride()` which uses the new schema.
     * This method is kept for backward compatibility and migrates to projectOverrides.
     *
     * @param pubkey - Agent's public key
     * @param projectDTag - Project dTag to scope the config to
     * @param config - Complete configuration for this project (old ProjectScopedConfig format)
     * @returns true if updated successfully, false if agent not found
     */
    async updateProjectScopedConfig(
        pubkey: string,
        projectDTag: string,
        config: ProjectScopedConfig
    ): Promise<boolean> {
        const agent = await this.loadAgent(pubkey);
        if (!agent) {
            logger.warn(`Agent with pubkey ${pubkey} not found`);
            return false;
        }

        // Build new-schema override from legacy config
        const newOverride: AgentProjectConfig = {};
        if (config.llmConfig !== undefined) {
            newOverride.model = config.llmConfig;
        }
        if (config.tools !== undefined && config.tools.length > 0) {
            newOverride.tools = config.tools;
        }

        // isPM is still stored in legacy projectConfigs since it's not in AgentProjectConfig
        if (!agent.projectConfigs) {
            agent.projectConfigs = {};
        }

        // Write model/tools to new projectOverrides
        if (!agent.projectOverrides) {
            agent.projectOverrides = {};
        }

        if (Object.keys(newOverride).length === 0) {
            delete agent.projectOverrides[projectDTag];
            if (Object.keys(agent.projectOverrides).length === 0) {
                delete agent.projectOverrides;
            }
        } else {
            agent.projectOverrides[projectDTag] = newOverride;
        }

        // Handle isPM separately in legacy projectConfigs
        if (config.isPM === true) {
            const legacyConfig = agent.projectConfigs[projectDTag] ?? {};
            legacyConfig.isPM = true;
            agent.projectConfigs[projectDTag] = legacyConfig;
        } else {
            // Clear isPM from legacy config when not set
            const legacyConfig = agent.projectConfigs[projectDTag];
            if (legacyConfig) {
                delete legacyConfig.isPM;
                if (Object.keys(legacyConfig).length === 0) {
                    delete agent.projectConfigs[projectDTag];
                }
            }
        }

        // Clean up empty projectConfigs
        if (agent.projectConfigs && Object.keys(agent.projectConfigs).length === 0) {
            delete agent.projectConfigs;
        }

        await this.saveAgent(agent);
        logger.info(`Updated project-scoped config for agent ${agent.name}`, {
            projectDTag,
            config,
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
