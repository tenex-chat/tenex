import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { StoredAgentData, ProjectScopedConfig, AgentDefaultConfig, AgentProjectConfig } from "@/agents/types";
import type { MCPServerConfig } from "@/llm/providers/types";
import {
    resolveEffectiveConfig,
    deduplicateProjectConfig,
    type ResolvedAgentConfig,
} from "@/agents/ConfigResolver";
import { ensureDirectory, fileExists } from "@/lib/fs";
import { config } from "@/services/ConfigService";
import { logger } from "@/utils/logger";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { trace } from "@opentelemetry/api";

/**
 * Options for `updateDefaultConfig()`.
 */
export interface UpdateDefaultConfigOptions {
    /** If true, clears all projectOverrides (default: false) */
    clearProjectOverrides?: boolean;
}

/**
 * Agent data stored in ~/.tenex/agents/<pubkey>.json
 */
export interface StoredAgent extends StoredAgentData {
    eventId?: string;
    nsec: string;
    slug: string;
    /**
     * Agent lifecycle status.
     * - 'active': Agent is assigned to at least one project (default behavior)
     * - 'inactive': Agent has been removed from all projects but identity preserved
     *
     * ## Identity Preservation Policy
     * Agent files are NEVER deleted when removed from projects. Instead, they become
     * 'inactive' and retain their pubkey/nsec for potential reactivation.
     */
    status?: "active" | "inactive";
    /**
     * @deprecated Use pmOverrides instead. Kept for backward compatibility.
     * Will be migrated to pmOverrides on first save.
     */
    isPMOverride?: boolean;
    /**
     * Project-scoped PM override flags.
     * Key is project dTag, value is true if this agent is PM for that project.
     * Only one agent per project should have this set to true.
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
     * Project-scoped configuration overrides.
     * Key is project dTag, value contains project-specific settings.
     * Set via kind 24020 TenexAgentConfigUpdate events WITH an a-tag specifying the project.
     *
     * ## Priority (highest to lowest)
     * 1. projectConfigs[projectDTag].* (project-scoped from kind 24020 with a-tag)
     * 2. Global fields (llmConfig, tools, isPM) (global from kind 24020 without a-tag)
     * 3. pmOverrides[projectDTag] (legacy, for backward compatibility)
     * 4. Project tag designations (from kind 31933)
     */
    projectConfigs?: Record<string, ProjectScopedConfig>;
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
 * });
 * await agentStorage.saveAgent(agent);
 * await agentStorage.addAgentToProject(pubkey, 'project-dtag');
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
    definitionDTag?: string;
    definitionAuthor?: string;
    definitionCreatedAt?: number;
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
        status: "active",
        mcpServers: config.mcpServers,
        pmOverrides: config.pmOverrides,
        default: config.defaultConfig,
        projectOverrides: config.projectOverrides,
        definitionDTag: config.definitionDTag,
        definitionAuthor: config.definitionAuthor,
        definitionCreatedAt: config.definitionCreatedAt,
    };
}

/**
 * Check if an agent is active.
 *
 * An agent is considered active if:
 * - It has `status: 'active'` explicitly set, OR
 * - It has no status field (treated as active by default)
 *
 * This helper centralizes the logic for determining agent activity status.
 */
export function isAgentActive(agent: StoredAgent): boolean {
    if (agent.status === "inactive") {
        return false;
    }
    return true;
}

/**
 * Slug index entry tracking which projects use this slug
 */
interface SlugEntry {
    pubkey: string;
    projectIds: string[];
}

/**
 * Index structure for fast lookups
 */
interface AgentIndex {
    bySlug: Record<string, SlugEntry>; // slug -> { pubkey, projectIds[] }
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
 * // Update default configuration
 * await agentStorage.updateDefaultConfig(pubkey, { model: 'anthropic:claude-opus-4' });
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
     * Load the index file or create empty index if it doesn't exist
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

                    // Verify byProject is populated after migration
                    const hasValidByProject = this.index.byProject &&
                        Object.keys(this.index.byProject).length > 0;

                    if (!hasValidByProject) {
                        logger.warn("Migration produced empty byProject index, rebuilding from agent files");
                        await this.rebuildIndex();
                    } else {
                        await this.saveIndex();
                    }

                    logger.info("Agent index migration complete", {
                        slugCount: Object.keys(this.index.bySlug).length,
                        projectCount: Object.keys(this.index.byProject).length,
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
     * Save the index file
     */
    private async saveIndex(): Promise<void> {
        if (!this.index) return;
        await fs.writeFile(this.indexPath, JSON.stringify(this.index, null, 2));
    }

    /**
     * Migrate index from old flat format to new SlugEntry structure.
     * Old format: bySlug[slug] = pubkey
     * New format: bySlug[slug] = { pubkey, projectIds: [] }
     *
     * This function returns a new AgentIndex object and does NOT mutate the input.
     */
    private migrateIndexFormat(oldIndex: any): AgentIndex {
        const newIndex: AgentIndex = {
            bySlug: {},
            byEventId: oldIndex.byEventId || {},
            byProject: oldIndex.byProject || {},
        };

        // Build reverse lookup: pubkey -> projectIds[]
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
                    projectIds: pubkeyToProjects[pubkey] || [],
                };
            } else {
                // Already in new format
                newIndex.bySlug[slug] = pubkey as SlugEntry;
            }
        }

        return newIndex;
    }

    /**
     * Rebuild index by scanning all agent files.
     *
     * Rebuilds bySlug and byEventId from agent files.
     * byProject cannot be rebuilt from agent files (project associations live only in the index),
     * so it is left empty.
     *
     * ## Slug Index Priority
     * Active agents take precedence over inactive agents for slug ownership.
     * If multiple agents share a slug, the active one becomes canonical.
     * If all agents with a slug are inactive, one is chosen arbitrarily.
     */
    async rebuildIndex(): Promise<void> {
        const index: AgentIndex = { bySlug: {}, byEventId: {}, byProject: {} };
        // Track which slugs are owned by active agents
        const activeSlugOwners = new Set<string>();

        const files = await fs.readdir(this.agentsDir);
        for (const file of files) {
            if (!file.endsWith(".json") || file === "index.json") continue;

            const pubkey = file.slice(0, -5); // Remove .json
            try {
                const agent = await this.loadAgent(pubkey);
                if (!agent) continue;

                const active = isAgentActive(agent);

                // Update slug index - active agents take precedence
                const existingEntry = index.bySlug[agent.slug];
                if (existingEntry) {
                    if (existingEntry.pubkey !== pubkey) {
                        // Different agent with same slug - active takes precedence
                        if (active && !activeSlugOwners.has(agent.slug)) {
                            index.bySlug[agent.slug] = { pubkey, projectIds: [] };
                            activeSlugOwners.add(agent.slug);
                        }
                    }
                    // Same agent already indexed - no merge needed (no projects in agent files)
                } else {
                    index.bySlug[agent.slug] = { pubkey, projectIds: [] };
                    if (active) {
                        activeSlugOwners.add(agent.slug);
                    }
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
        });
    }

    /**
     * Find an alternative active agent that can own a slug.
     * Used when the current slug owner becomes inactive.
     *
     * @param slug - The slug to find an alternative owner for
     * @param excludePubkey - Pubkey to exclude from consideration (the current/transitioning owner)
     * @returns The pubkey of an active agent with this slug, or null if none exists
     */
    private async findAlternativeSlugOwner(slug: string, excludePubkey: string): Promise<string | null> {
        const files = await fs.readdir(this.agentsDir);

        for (const file of files) {
            if (!file.endsWith(".json") || file === "index.json") continue;

            const pubkey = file.slice(0, -5); // Remove .json
            if (pubkey === excludePubkey) continue;

            try {
                const agent = await this.loadAgent(pubkey);
                if (!agent) continue;

                if (agent.slug === slug && isAgentActive(agent)) {
                    return pubkey;
                }
            } catch {
                // Skip agents that fail to load
            }
        }

        return null;
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

        // Find overlapping projects using the index (source of truth for project associations)
        const existingProjects = this.getIndexProjectsForAgent(existingEntry.pubkey);
        const overlappingProjects = existingProjects.filter((p) => newProjects.includes(p));
        if (overlappingProjects.length === 0) return;

        logger.info(`Cleaning up duplicate slug '${slug}'`, {
            oldPubkey: existingEntry.pubkey.substring(0, 8),
            newPubkey: newPubkey.substring(0, 8),
            overlappingProjects,
        });

        // Emit telemetry for agent eviction
        trace.getActiveSpan()?.addEvent("agent.slug_conflict_eviction", {
            "conflict.slug": slug,
            "conflict.evicted_pubkey": existingEntry.pubkey,
            "conflict.incoming_pubkey": newPubkey,
            "conflict.overlapping_projects": overlappingProjects.join(", "),
            "conflict.overlapping_count": overlappingProjects.length,
        });

        // Remove old agent from overlapping projects
        for (const projectDTag of overlappingProjects) {
            await this.removeAgentFromProject(existingEntry.pubkey, projectDTag);

            // Update slug entry's project list
            existingEntry.projectIds = (existingEntry.projectIds ?? []).filter(p => p !== projectDTag);

            // Emit per-project eviction event for granular tracking
            trace.getActiveSpan()?.addEvent("agent.evicted_from_project", {
                "eviction.slug": slug,
                "eviction.pubkey": existingEntry.pubkey,
                "eviction.project": projectDTag,
                "eviction.reason": "slug_conflict",
            });
        }

        // If old agent has no projects left, remove the slug entry entirely
        if ((existingEntry.projectIds ?? []).length === 0) {
            delete this.index.bySlug[slug];
            logger.info(`Removed slug entry for '${slug}' - no projects remaining`);

            trace.getActiveSpan()?.addEvent("agent.slug_entry_deleted", {
                "slug.deleted": slug,
                "slug.pubkey": existingEntry.pubkey,
                "slug.reason": "no_projects_remaining",
            });
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

        // Get the agent's current projects from the index for duplicate slug cleanup
        const currentProjects = this.getIndexProjectsForAgent(pubkey);

        // Clean up old agents with same slug in overlapping projects
        await this.cleanupDuplicateSlugs(agent.slug, pubkey, currentProjects);

        // Save agent file
        await fs.writeFile(filePath, JSON.stringify(agent, null, 2));

        // Update index
        if (!this.index) await this.loadIndex();
        if (!this.index) return;

        // Remove old slug entry if slug changed
        if (existing && existing.slug !== agent.slug) {
            const oldSlugEntry = this.index.bySlug[existing.slug];
            if (oldSlugEntry && oldSlugEntry.pubkey === pubkey) {
                delete this.index.bySlug[existing.slug];
                trace.getActiveSpan()?.addEvent("agent.slug_renamed_cleanup", {
                    "slug.old": existing.slug,
                    "slug.new": agent.slug,
                    "agent.pubkey": pubkey,
                });
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

        // Update bySlug index
        if (isAgentActive(agent)) {
            const agentProjects = this.getIndexProjectsForAgent(pubkey);
            const currentSlugEntry = this.index.bySlug[agent.slug];
            if (!currentSlugEntry || currentSlugEntry.pubkey === pubkey) {
                // Only update if we already own the slug or there's no current owner.
                // Slug takeover for new agents happens in addAgentToProject after cleanup.
                this.index.bySlug[agent.slug] = { pubkey, projectIds: agentProjects };
            }
        } else {
            // For inactive agents, handle slug ownership transition
            const currentOwner = this.index.bySlug[agent.slug];
            if (currentOwner?.pubkey === pubkey) {
                // This agent was the canonical owner but is now inactive
                // Find another active agent with the same slug to take ownership
                const alternativeOwner = await this.findAlternativeSlugOwner(agent.slug, pubkey);
                if (alternativeOwner) {
                    const altProjects = this.getIndexProjectsForAgent(alternativeOwner);
                    this.index.bySlug[agent.slug] = {
                        pubkey: alternativeOwner,
                        projectIds: altProjects,
                    };
                    logger.debug(`Reassigned slug '${agent.slug}' from inactive ${pubkey.substring(0, 8)} to active ${alternativeOwner.substring(0, 8)}`);
                } else {
                    // No alternative found - keep entry pointing to this agent with empty projects
                    currentOwner.projectIds = this.getIndexProjectsForAgent(pubkey);
                }
            } else if (!currentOwner) {
                // No owner yet - claim it for reactivation lookup purposes
                this.index.bySlug[agent.slug] = { pubkey, projectIds: [] };
            }
            // If another agent owns the slug, don't overwrite
        }

        if (agent.eventId) {
            this.index.byEventId[agent.eventId] = pubkey;
        }

        await this.saveIndex();
        logger.debug(`Saved agent ${agent.slug} (${pubkey})`);
    }

    /**
     * Delete an agent and update index.
     *
     * @deprecated This method permanently deletes agent identity (pubkey/nsec).
     * Prefer using removeAgentFromProject() which sets agents to 'inactive' status
     * while preserving their identity for potential reactivation.
     *
     * This method is kept for:
     * - Administrative cleanup of truly orphaned agents
     * - Test teardown
     * - Explicit user-requested deletion
     *
     * @param pubkey - Agent's public key to delete
     */
    async deleteAgent(pubkey: string): Promise<void> {
        const agent = await this.loadAgent(pubkey);
        if (!agent) return;

        logger.warn(
            `deleteAgent called for ${agent.slug} (${pubkey.substring(0, 8)}) - ` +
            `this permanently destroys agent identity. Consider using removeAgentFromProject instead.`
        );

        // Delete file
        const filePath = path.join(this.agentsDir, `${pubkey}.json`);
        await fs.unlink(filePath);

        // Update index
        if (!this.index) await this.loadIndex();
        if (!this.index) return;

        // Remove from slug index
        const slugEntry = this.index.bySlug[agent.slug];
        if (slugEntry?.pubkey === pubkey) {
            delete this.index.bySlug[agent.slug];
        }

        // Remove from eventId index
        if (agent.eventId && this.index.byEventId[agent.eventId] === pubkey) {
            delete this.index.byEventId[agent.eventId];
        }

        // Remove from project index by scanning byProject
        for (const projectDTag of Object.keys(this.index.byProject)) {
            const projectAgents = this.index.byProject[projectDTag];
            if (projectAgents.includes(pubkey)) {
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
     * Check if any agent (in any project) uses the given slug.
     * Used for global uniqueness checks (e.g., import commands).
     */
    async slugExists(slug: string): Promise<boolean> {
        if (!this.index) await this.loadIndex();
        return !!this.index?.bySlug[slug];
    }

    /**
     * Get agent by slug (uses index for O(1) lookup).
     *
     * **DEPRECATED**: Use getAgentBySlugForProject() instead for project-scoped lookups.
     * This method returns the LAST agent saved with this slug, which may not be the
     * correct agent when multiple agents use the same slug across different projects.
     *
     * @deprecated Use getAgentBySlugForProject(slug, projectDTag) instead
     */
    async getAgentBySlug(slug: string): Promise<StoredAgent | null> {
        if (!this.index) await this.loadIndex();
        if (!this.index) return null;

        const slugEntry = this.index.bySlug[slug];
        if (!slugEntry) return null;

        logger.warn("Using deprecated getAgentBySlug() - consider using getAgentBySlugForProject()", {
            slug,
            pubkey: slugEntry.pubkey.substring(0, 8),
        });

        return this.loadAgent(slugEntry.pubkey);
    }

    /**
     * Get agent by slug within a specific project context.
     * This is the correct method to use when slug may not be globally unique.
     *
     * @param slug - The agent slug to search for
     * @param projectDTag - The project context to search within
     * @returns The agent if found in this project, null otherwise
     */
    async getAgentBySlugForProject(slug: string, projectDTag: string): Promise<StoredAgent | null> {
        if (!this.index) await this.loadIndex();
        if (!this.index) return null;

        const slugEntry = this.index.bySlug[slug];
        if (!slugEntry) return null;

        // Check if this slug is used in the specified project
        if (!(slugEntry.projectIds ?? []).includes(projectDTag)) {
            return null;
        }

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
     * Deduplicates by slug, keeping only the agent currently in bySlug index.
     *
     * Only returns active agents - inactive agents (removed from all projects
     * but identity preserved) are filtered out.
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

            // Skip inactive agents - they shouldn't appear in project listings
            if (!isAgentActive(agent)) continue;

            // Skip if we've already seen this slug - keep only the canonical one
            if (seenSlugs.has(agent.slug)) continue;

            // Only include if this pubkey is the canonical one for this slug
            const slugEntry = this.index.bySlug[agent.slug];
            if (slugEntry?.pubkey === pubkey) {
                agents.push(agent);
                seenSlugs.add(agent.slug);
            }
        }

        return agents;
    }

    /**
     * Get all projects for an agent (reverse lookup by pubkey via index)
     */
    async getAgentProjects(pubkey: string): Promise<string[]> {
        if (!this.index) await this.loadIndex();
        return this.getIndexProjectsForAgent(pubkey);
    }

    /**
     * Scan byProject index and return all dTags where pubkey appears.
     */
    private getIndexProjectsForAgent(pubkey: string): string[] {
        if (!this.index) return [];
        return Object.entries(this.index.byProject)
            .filter(([, pubkeys]) => pubkeys.includes(pubkey))
            .map(([dTag]) => dTag);
    }

    /**
     * Add an agent to a project.
     *
     * If the agent was previously inactive (removed from all projects), this
     * reactivates the agent, preserving its original identity (pubkey/nsec).
     */
    async addAgentToProject(pubkey: string, projectDTag: string): Promise<void> {
        const agent = await this.loadAgent(pubkey);
        if (!agent) {
            throw new Error(`Agent ${pubkey} not found`);
        }

        if (!this.index) await this.loadIndex();
        if (!this.index) return;

        const wasInactive = !isAgentActive(agent);

        // Update byProject index
        // Clean up any agent with the same slug already in this project
        await this.cleanupDuplicateSlugs(agent.slug, pubkey, [projectDTag]);

        if (!this.index.byProject[projectDTag]) {
            this.index.byProject[projectDTag] = [];
        }
        if (!this.index.byProject[projectDTag].includes(pubkey)) {
            this.index.byProject[projectDTag].push(pubkey);
        }

        // Update bySlug index - the last agent added to a project claims slug ownership
        const slugEntry = this.index.bySlug[agent.slug];
        if (slugEntry?.pubkey === pubkey) {
            slugEntry.projectIds ??= [];
            if (!slugEntry.projectIds.includes(projectDTag)) {
                slugEntry.projectIds.push(projectDTag);
            }
        } else {
            // Take over slug ownership (cleanup already evicted any conflicting agents above)
            this.index.bySlug[agent.slug] = { pubkey, projectIds: [projectDTag] };
        }

        // Reactivate if agent was inactive
        agent.status = "active";
        await this.saveAgent(agent);

        if (wasInactive) {
            logger.info(`Reactivated agent ${agent.slug} (${pubkey.substring(0, 8)}) for project ${projectDTag}`);
        }
    }

    /**
     * Remove an agent from a project.
     *
     * ## Identity Preservation Policy
     * When an agent is removed from all projects, it becomes 'inactive' rather than
     * being deleted. This preserves the agent's identity (pubkey/nsec) so that if
     * the same agent is later assigned to a project, it retains its original keys.
     *
     * Inactive agents:
     * - Are NOT returned by getProjectAgents()
     * - Retain their pubkey, nsec, slug, and all configuration
     * - Can be reactivated by addAgentToProject()
     */
    async removeAgentFromProject(pubkey: string, projectDTag: string): Promise<void> {
        const agent = await this.loadAgent(pubkey);
        if (!agent) return;

        if (!this.index) await this.loadIndex();
        if (!this.index) return;

        // Update byProject index
        const projectAgents = this.index.byProject[projectDTag];
        if (projectAgents) {
            this.index.byProject[projectDTag] = projectAgents.filter((p) => p !== pubkey);
            if (this.index.byProject[projectDTag].length === 0) {
                delete this.index.byProject[projectDTag];
            }
        }

        // Update bySlug index projectIds
        const slugEntry = this.index.bySlug[agent.slug];
        if (slugEntry?.pubkey === pubkey) {
            slugEntry.projectIds = (slugEntry.projectIds ?? []).filter((p) => p !== projectDTag);
        }

        // Set status based on remaining projects - NEVER delete agent files
        const remainingProjects = this.getIndexProjectsForAgent(pubkey);
        agent.status = remainingProjects.length === 0 ? "inactive" : "active";
        await this.saveAgent(agent);

        if (agent.status === "inactive") {
            logger.info(`Agent ${agent.slug} (${pubkey.substring(0, 8)}) marked inactive - identity preserved`);
        }
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
     * Update an agent's default configuration block.
     *
     * A 24020 event with NO a-tag should call this method.
     * Writes to the `default` block in the agent file.
     *
     * @param pubkey - Agent's public key
     * @param updates - Fields to update. Only defined fields are applied.
     * @param options - Optional behavior flags
     * @param options.clearProjectOverrides - If true, clears all projectOverrides (default: false)
     * @returns true if updated successfully, false if agent not found
     */
    async updateDefaultConfig(
        pubkey: string,
        updates: AgentDefaultConfig,
        options?: UpdateDefaultConfigOptions
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

        // Clear all project overrides when a global config update is received
        if (options?.clearProjectOverrides && agent.projectOverrides) {
            delete agent.projectOverrides;
            logger.info(`Cleared projectOverrides for agent ${agent.name} (global config update)`);
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
     * Resolve the effective PM status for an agent in a specific project.
     * Priority:
     * 1. agent.isPM (global PM designation via kind 24020 without a-tag)
     * 2. projectOverrides[projectDTag].isPM (project-scoped PM via kind 24020 with a-tag)
     * 3. pmOverrides[projectDTag] (legacy, for backward compatibility)
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

    /**
     * Update an agent's project-scoped PM designation.
     * Writes to projectOverrides[projectDTag].isPM.
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
            if (!agent.projectOverrides) {
                agent.projectOverrides = {};
            }
            if (!agent.projectOverrides[projectDTag]) {
                agent.projectOverrides[projectDTag] = {};
            }
            agent.projectOverrides[projectDTag].isPM = true;
        } else {
            const override = agent.projectOverrides?.[projectDTag];
            if (override) {
                delete override.isPM;
                if (Object.keys(override).length === 0) {
                    delete agent.projectOverrides![projectDTag];
                    if (Object.keys(agent.projectOverrides!).length === 0) {
                        delete agent.projectOverrides;
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
