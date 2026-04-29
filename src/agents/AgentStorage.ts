import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
    StoredAgentData,
    AgentDefaultConfig,
    TelegramAgentConfig,
} from "@/agents/types";
import type { AgentCategory } from "@/agents/role-categories";
import type { MCPServerConfig } from "@/llm/providers/types";
import { ensureDirectory, fileExists } from "@/lib/fs";
import { config } from "@/services/ConfigService";
import { logger } from "@/utils/logger";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { trace } from "@opentelemetry/api";

function stripUndefinedValues<T extends object>(value: T): Partial<T> {
    return Object.fromEntries(
        Object.entries(value).filter(([, entry]) => entry !== undefined)
    ) as Partial<T>;
}

function sanitizeTelegramConfig(
    telegram: TelegramAgentConfig | undefined
): TelegramAgentConfig | undefined {
    if (!telegram) {
        return undefined;
    }

    const { chatBindings: _chatBindings, ...rest } = telegram as TelegramAgentConfig & {
        chatBindings?: unknown;
    };
    const sanitized = stripUndefinedValues(rest) as TelegramAgentConfig;
    return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function sanitizeDefaultConfig(
    defaultConfig: AgentDefaultConfig | undefined
): AgentDefaultConfig | undefined {
    if (!defaultConfig) {
        return undefined;
    }

    const { telegram: _legacyTelegram, ...rest } = defaultConfig as AgentDefaultConfig & {
        telegram?: TelegramAgentConfig;
    };
    const sanitized = stripUndefinedValues(rest) as AgentDefaultConfig;
    return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function normalizeLoadedAgent(agent: StoredAgent): StoredAgent {
    const topLevelTelegram = sanitizeTelegramConfig(agent.telegram);
    const legacyDefaultTelegram = sanitizeTelegramConfig(
        (agent.default as (AgentDefaultConfig & { telegram?: TelegramAgentConfig }) | undefined)?.telegram
    );

    return {
        ...agent,
        telegram: topLevelTelegram ?? legacyDefaultTelegram,
        default: sanitizeDefaultConfig(agent.default),
    };
}

function sanitizeStoredAgentForPersistence(agent: StoredAgent): StoredAgent {
    return {
        ...agent,
        telegram: sanitizeTelegramConfig(agent.telegram),
        default: sanitizeDefaultConfig(agent.default),
    };
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
}

/**
 * Factory function to create a StoredAgent object.
 *
 * Ensures consistent structure and defaults across the codebase.
 * Used by agents_write and other local agent creation paths.
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
    category?: AgentCategory;
    description?: string | null;
    instructions?: string | null;
    useCriteria?: string | null;
    eventId?: string;
    mcpServers?: Record<string, MCPServerConfig>;
    defaultConfig?: AgentDefaultConfig & { telegram?: TelegramAgentConfig };
    isPM?: boolean;
    telegram?: TelegramAgentConfig;
}): StoredAgent {
    const legacyDefaultTelegram = sanitizeTelegramConfig(
        (config.defaultConfig as (AgentDefaultConfig & { telegram?: TelegramAgentConfig }) | undefined)?.telegram
    );
    const defaultConfig = sanitizeDefaultConfig(config.defaultConfig);

    return {
        eventId: config.eventId,
        nsec: config.nsec,
        slug: config.slug,
        name: config.name,
        role: config.role,
        category: config.category,
        description: config.description ?? undefined,
        instructions: config.instructions ?? undefined,
        useCriteria: config.useCriteria ?? undefined,
        status: "active",
        mcpServers: config.mcpServers,
        default: defaultConfig,
        isPM: config.isPM,
        telegram: sanitizeTelegramConfig(config.telegram ?? legacyDefaultTelegram),
    };
}

export function deriveAgentPubkeyFromNsec(nsec: string): string {
    return new NDKPrivateKeySigner(nsec).pubkey;
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
 * Index structure for fast lookups.
 *
 * Note: project membership (which pubkeys belong to which dTag) is no longer
 * stored here. The canonical source is the persisted kind:31933 event at
 * `~/.tenex/projects/<dTag>/event.json` — read it via
 * `services/projects/ProjectMembersReader`.
 */
interface AgentIndex {
    bySlug: Record<string, SlugEntry>; // slug -> { pubkey, projectIds[] }
    byEventId: Record<string, string>; // eventId -> pubkey
}

/**
 * AgentStorage - Persistent storage layer for agent data
 *
 * ## Responsibility
 * Manages agent data persistence in ~/.tenex/agents/
 * - One JSON file per agent: <pubkey>.json (contains all data including private key)
 * - Fast lookups via index.json (slug → pubkey, eventId → pubkey)
 *
 * Project membership (which pubkeys belong to which dTag) is NOT stored here —
 * it is derived from the persisted kind:31933 event at
 * `~/.tenex/projects/<dTag>/event.json`. Use
 * `services/projects/ProjectMembersReader` to read it.
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

type LegacyStoredAgent = StoredAgent & { projectOverrides?: unknown; pmOverrides?: unknown };

/**
 * Strip legacy per-project override fields from a parsed agent JSON object.
 * Returns true if the object was mutated (i.e., migration was needed).
 */
function migrateAgentData(agent: LegacyStoredAgent): boolean {
    let mutated = false;
    if ("projectOverrides" in agent) {
        delete agent.projectOverrides;
        mutated = true;
    }
    if ("pmOverrides" in agent) {
        delete agent.pmOverrides;
        mutated = true;
    }
    return mutated;
}

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
     *
     * Old on-disk indexes may carry an extra `byProject` field; it is silently
     * dropped on load. Old `bySlug` entries that are flat strings are migrated
     * to the SlugEntry structure.
     */
    private async loadIndex(): Promise<void> {
        if (await fileExists(this.indexPath)) {
            try {
                const content = await fs.readFile(this.indexPath, "utf-8");
                const rawIndex = JSON.parse(content);

                // Detect old format: bySlug is Record<string, string> instead of Record<string, SlugEntry>
                const needsMigration = rawIndex.bySlug &&
                    Object.values(rawIndex.bySlug).some((val: unknown) => typeof val === "string");

                if (needsMigration) {
                    logger.info("Migrating agent index from old format to SlugEntry structure");
                    this.index = this.migrateIndexFormat(rawIndex);
                    await this.saveIndex();
                    logger.info("Agent index migration complete", {
                        slugCount: Object.keys(this.index.bySlug).length,
                    });
                } else {
                    this.index = {
                        bySlug: (rawIndex.bySlug || {}) as Record<string, SlugEntry>,
                        byEventId: (rawIndex.byEventId || {}) as Record<string, string>,
                    };
                }
            } catch (error) {
                logger.error("Failed to load agent index, creating new one", { error });
                this.index = { bySlug: {}, byEventId: {} };
            }
        } else {
            this.index = { bySlug: {}, byEventId: {} };
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
     * Any legacy `byProject` field on the input is ignored; project membership
     * now lives in the on-disk kind:31933 event, not in this index.
     *
     * This function returns a new AgentIndex object and does NOT mutate the input.
     */
    private migrateIndexFormat(oldIndex: Record<string, unknown>): AgentIndex {
        const newIndex: AgentIndex = {
            bySlug: {},
            byEventId: (oldIndex.byEventId || {}) as Record<string, string>,
        };

        // Convert slug index
        for (const [slug, pubkey] of Object.entries(oldIndex.bySlug || {})) {
            if (typeof pubkey === "string") {
                newIndex.bySlug[slug] = {
                    pubkey,
                    projectIds: [],
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
     * Rebuilds bySlug and byEventId from agent files. Project membership is not
     * stored in this index; it is derived from the on-disk kind:31933 event.
     *
     * ## Slug Index Priority
     * Active agents take precedence over inactive agents for slug ownership.
     * If multiple agents share a slug, the active one becomes canonical.
     * If all agents with a slug are inactive, one is chosen arbitrarily.
     */
    async rebuildIndex(): Promise<void> {
        const index: AgentIndex = { bySlug: {}, byEventId: {} };
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
            const agent = JSON.parse(content) as LegacyStoredAgent;
            const normalized = normalizeLoadedAgent(agent as StoredAgent);
            const migrated = migrateAgentData(normalized as LegacyStoredAgent);
            if (migrated) {
                // Write directly to disk — do NOT call saveAgent() to avoid recursion
                // (saveAgent → loadAgent → migrateAgentData → saveAgent...)
                await fs.writeFile(filePath, JSON.stringify(normalized, null, 2));
            }
            return normalized;
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

        // Find overlapping projects using the slug's tracked projectIds
        const existingProjects = existingEntry.projectIds ?? [];
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
        const pubkey = deriveAgentPubkeyFromNsec(agent.nsec);

        const filePath = path.join(this.agentsDir, `${pubkey}.json`);
        const sanitizedAgent = sanitizeStoredAgentForPersistence(agent);

        // Load existing agent to check for changes
        const existing = await this.loadAgent(pubkey);

        // Get the agent's current projects from the index for duplicate slug cleanup
        const currentProjects = this.getIndexProjectsForAgent(pubkey);

        // Clean up old agents with same slug in overlapping projects
        await this.cleanupDuplicateSlugs(agent.slug, pubkey, currentProjects);

        // Save agent file
        await fs.writeFile(filePath, JSON.stringify(sanitizedAgent, null, 2));

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
     * This method permanently deletes agent identity (pubkey/nsec).
     * Prefer removeAgentFromProject(), which marks an agent inactive while preserving
     * its identity for later reactivation.
     *
     * Reserved for:
     * - Administrative cleanup of truly orphaned agents
     * - Test teardown
     * - Explicit user-requested deletion
     *
     * @param pubkey - Agent's public key to delete
     */
    async deleteAgent(
        pubkey: string,
        options?: {
            quiet?: boolean;
        }
    ): Promise<void> {
        const agent = await this.loadAgent(pubkey);
        if (!agent) return;

        if (!options?.quiet) {
            logger.warn(
                `deleteAgent called for ${agent.slug} (${pubkey.substring(0, 8)}) - this permanently destroys agent identity. Consider using removeAgentFromProject instead.`
            );
        }

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

        await this.saveIndex();
        if (!options?.quiet) {
            logger.info(`Deleted agent ${agent.slug} (${pubkey})`);
        }
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
     * Returns the agent regardless of project assignment.
     * Use getAgentBySlugForProject() when you need project-scoped lookups.
     */
    async getAgentBySlug(slug: string): Promise<StoredAgent | null> {
        if (!this.index) await this.loadIndex();
        if (!this.index) return null;

        const slugEntry = this.index.bySlug[slug];
        if (!slugEntry) return null;

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
     * Return all dTags where this pubkey is the canonical slug owner.
     *
     * Project membership lives in the on-disk kind:31933 event; this index only
     * tracks which projects each *slug owner* is associated with for slug-conflict
     * resolution. If a pubkey is not currently the canonical owner of its slug,
     * this returns an empty list — the caller has no project association recorded
     * in the index.
     */
    private getIndexProjectsForAgent(pubkey: string): string[] {
        if (!this.index) return [];
        const projects = new Set<string>();
        for (const slugEntry of Object.values(this.index.bySlug)) {
            if (slugEntry.pubkey !== pubkey) continue;
            for (const projectId of slugEntry.projectIds ?? []) {
                projects.add(projectId);
            }
        }
        return [...projects];
    }

    /**
     * Return every slug-owner pubkey currently recorded in the index for the given dTag.
     *
     * Used by `syncProjectAgents` to compute the previous-state diff before applying the
     * new desired membership. Project membership is canonically defined by the persisted
     * kind:31933 event; this lookup only inspects the locally-tracked slug index.
     */
    private getProjectMembersFromIndex(projectDTag: string): string[] {
        if (!this.index) return [];
        const pubkeys: string[] = [];
        for (const slugEntry of Object.values(this.index.bySlug)) {
            if (!(slugEntry.projectIds ?? []).includes(projectDTag)) continue;
            pubkeys.push(slugEntry.pubkey);
        }
        return pubkeys;
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

        // Clean up any agent with the same slug already in this project
        await this.cleanupDuplicateSlugs(agent.slug, pubkey, [projectDTag]);

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
     * Mirror authoritative project membership into local storage.
     *
     * Unknown pubkeys are skipped and logged; they are not added to storage.
     * Membership order is preserved in the returned assignedPubkeys array.
     */
    async syncProjectAgents(
        projectDTag: string,
        desiredPubkeys: string[]
    ): Promise<{
        assignedPubkeys: string[];
        skippedPubkeys: string[];
        removedPubkeys: string[];
    }> {
        if (!this.index) await this.loadIndex();
        const dedupedDesiredPubkeys = Array.from(
            new Set(desiredPubkeys.filter((pubkey): pubkey is string => Boolean(pubkey)))
        );
        const currentPubkeys = new Set(this.getProjectMembersFromIndex(projectDTag));
        const desiredPubkeySet = new Set(dedupedDesiredPubkeys);
        const removedPubkeys: string[] = [];
        const assignedPubkeys: string[] = [];
        const skippedPubkeys: string[] = [];

        for (const pubkey of currentPubkeys) {
            if (desiredPubkeySet.has(pubkey)) continue;
            await this.removeAgentFromProject(pubkey, projectDTag);
            removedPubkeys.push(pubkey);
        }

        for (const pubkey of dedupedDesiredPubkeys) {
            const storedAgent = await this.loadAgent(pubkey);
            if (!storedAgent) {
                skippedPubkeys.push(pubkey);
                logger.warn("Skipping unknown assigned agent pubkey", {
                    projectDTag,
                    agentPubkey: pubkey.substring(0, 8),
                });
                continue;
            }

            await this.addAgentToProject(pubkey, projectDTag);
            assignedPubkeys.push(pubkey);
        }

        return {
            assignedPubkeys,
            skippedPubkeys,
            removedPubkeys,
        };
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
     * - Retain their pubkey, nsec, slug, and all configuration
     * - Can be reactivated by addAgentToProject()
     */
    async removeAgentFromProject(pubkey: string, projectDTag: string): Promise<void> {
        const agent = await this.loadAgent(pubkey);
        if (!agent) return;

        if (!this.index) await this.loadIndex();
        if (!this.index) return;

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
     * Update an agent's inferred category without touching the authoritative category field.
     *
     * Updates ONLY the stored data on disk. To refresh the in-memory instance,
     * call AgentRegistry.reloadAgent() after this method when needed.
     *
     * @param pubkey - Agent's public key (hex string)
     * @param inferredCategory - Auto-inferred category to persist
     * @returns true if updated successfully, false if agent not found
     */
    async updateInferredCategory(pubkey: string, inferredCategory: AgentCategory): Promise<boolean> {
        const agent = await this.loadAgent(pubkey);
        if (!agent) {
            logger.warn(`Agent with pubkey ${pubkey} not found`);
            return false;
        }

        agent.inferredCategory = inferredCategory;

        await this.saveAgent(agent);
        logger.info(`Updated inferred category for agent ${agent.name}`, { inferredCategory });
        return true;
    }

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
                agent.default.tools = undefined;
            }
        }

        if (updates.blockedSkills !== undefined) {
            if (updates.blockedSkills.length > 0) {
                agent.default.blockedSkills = updates.blockedSkills;
            } else {
                agent.default.blockedSkills = undefined;
            }
        }

        if (updates.skills !== undefined) {
            if (updates.skills.length > 0) {
                agent.default.skills = updates.skills;
            } else {
                agent.default.skills = undefined;
            }
        }

        if (updates.mcp !== undefined) {
            if (updates.mcp.length > 0) {
                agent.default.mcp = updates.mcp;
            } else {
                agent.default.mcp = undefined;
            }
        }

        // Clean up empty default block
        if (agent.default && Object.keys(agent.default).length === 0) {
            agent.default = undefined;
        }

        await this.saveAgent(agent);
        logger.info(`Updated default config for agent ${agent.name}`, { updates });
        return true;
    }

    async resetDefaultConfig(pubkey: string): Promise<boolean> {
        const agent = await this.loadAgent(pubkey);
        if (!agent) {
            logger.warn(`Agent with pubkey ${pubkey} not found`);
            return false;
        }

        agent.default = undefined;
        agent.isPM = undefined;

        await this.saveAgent(agent);
        logger.info(`Reset default config for agent ${agent.name}`);
        return true;
    }

    async updateAgentIsPM(
        pubkey: string,
        isPM: boolean | undefined
    ): Promise<boolean> {
        const agent = await this.loadAgent(pubkey);
        if (!agent) {
            logger.warn(`Agent with pubkey ${pubkey} not found`);
            return false;
        }

        agent.isPM = isPM;

        await this.saveAgent(agent);
        logger.info(`Updated PM designation for agent ${agent.name}`, { isPM });
        return true;
    }

    async updateAgentTelegramConfig(
        pubkey: string,
        telegram?: TelegramAgentConfig
    ): Promise<boolean> {
        const agent = await this.loadAgent(pubkey);
        if (!agent) {
            logger.warn(`Agent with pubkey ${pubkey} not found`);
            return false;
        }

        agent.telegram = sanitizeTelegramConfig(telegram);
        await this.saveAgent(agent);
        logger.info(`Updated Telegram transport for agent ${agent.name}`, {
            enabled: Boolean(agent.telegram?.botToken),
        });
        return true;
    }

    /**
     * Get canonical active agents across the store.
     *
     * Returns one active agent per slug, using the current bySlug index owner.
     * This is the safe listing for operator-facing flows and agent selection UIs.
     */
    async getCanonicalActiveAgents(): Promise<StoredAgent[]> {
        if (!this.index) await this.loadIndex();
        if (!this.index) return [];

        const agents: StoredAgent[] = [];

        for (const slugEntry of Object.values(this.index.bySlug)) {
            const agent = await this.loadAgent(slugEntry.pubkey);
            if (!agent || !isAgentActive(agent)) {
                continue;
            }
            agents.push(agent);
        }

        return agents;
    }

    /**
     * Get every stored agent record from disk.
     *
     * This intentionally includes inactive agents, stale records, and duplicate
     * slugs. It exists for maintenance and repair flows that need raw storage
     * visibility rather than canonical runtime semantics.
     */
    async getAllStoredAgents(): Promise<StoredAgent[]> {
        await ensureDirectory(this.agentsDir);
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
