import type { StoredAgent } from "@/agents/AgentStorage";
import { agentStorage } from "@/agents/AgentStorage";
import { NDKAgentDefinition } from "@/events/NDKAgentDefinition";
import { logger } from "@/utils/logger";
import type NDK from "@nostr-dev-kit/ndk";
import type { NDKEvent, NDKFilter, NDKSubscription } from "@nostr-dev-kit/ndk";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import type { ProjectRuntime } from "@/daemon/ProjectRuntime";

/**
 * Callback to get all active runtimes for reloading agents.
 * Injected by the Daemon to avoid circular dependencies.
 */
export type ActiveRuntimesProvider = () => Map<string, ProjectRuntime>;

/**
 * Configuration for the AgentDefinitionMonitor.
 */
export interface AgentDefinitionMonitorConfig {
    /** Pubkeys authorized to publish definition upgrades (in addition to original author) */
    whitelistedPubkeys: string[];
}

/**
 * Tracks which agents are being monitored, keyed by "definitionDTag:definitionAuthor".
 */
interface MonitoredAgent {
    pubkey: string;
    slug: string;
    definitionDTag: string;
    definitionAuthor: string;
    currentEventId?: string;
    currentCreatedAt?: number;
}

/**
 * AgentDefinitionMonitor - Watches for updated agent definition events (kind:4199)
 * and auto-upgrades active agents when newer definitions are published.
 *
 * ## How It Works
 * 1. On startup, scans all installed agents (regardless of active/inactive status)
 *    for those with `definitionDTag` + `definitionAuthor` metadata
 * 2. Creates an NDK subscription for kind:4199 events matching those d-tags
 * 3. When a new event arrives:
 *    - Verifies the author is authorized (original author or whitelisted)
 *    - Checks the event is actually newer (by `created_at` timestamp)
 *    - Updates the StoredAgent IN-PLACE (preserving nsec, slug, pmOverrides, etc.)
 *    - Reloads the agent in all active project registries
 * 4. Applies a 5000ms debounce to batch events during initial subscription catch-up
 *
 * ## Identity Preservation
 * The following fields are NEVER overwritten during an upgrade:
 * - nsec (agent's private key / identity)
 * - slug (agent's identifier in projects)
 * - pmOverrides (PM designations)
 * - isPM (global PM flag)
 * - projectOverrides (per-project config)
 * - status (active/inactive)
 *
 * ## Backward Compatibility
 * Agents without `definitionDTag` are silently ignored. They can be upgraded
 * by re-installing them, which will set the tracking fields.
 *
 * @see AgentStorage for persistence
 * @see AgentRegistry.reloadAgent for runtime refresh
 */
export class AgentDefinitionMonitor {
    private ndk: NDK;
    private config: AgentDefinitionMonitorConfig;
    private getActiveRuntimes: ActiveRuntimesProvider;

    private subscription: NDKSubscription | null = null;
    private monitoredAgents = new Map<string, MonitoredAgent>(); // key: "dTag:author"
    private isRunning = false;

    /** Debounce state */
    private pendingEvents = new Map<string, NDKEvent>(); // key: "dTag:author" -> latest event
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;
    private static readonly DEBOUNCE_MS = 5000;

    constructor(
        ndk: NDK,
        config: AgentDefinitionMonitorConfig,
        getActiveRuntimes: ActiveRuntimesProvider,
    ) {
        this.ndk = ndk;
        this.config = config;
        this.getActiveRuntimes = getActiveRuntimes;
    }

    /**
     * Start monitoring for agent definition updates.
     * Scans all stored agents and subscribes to relevant kind:4199 events.
     */
    async start(): Promise<void> {
        if (this.isRunning) {
            logger.warn("[AgentDefinitionMonitor] Already running");
            return;
        }

        logger.info("[AgentDefinitionMonitor] Starting agent definition monitor");

        // Collect all monitored agents from storage
        await this.collectMonitoredAgents();

        if (this.monitoredAgents.size === 0) {
            logger.info("[AgentDefinitionMonitor] No agents with definition tracking found, monitor idle");
            this.isRunning = true;
            return;
        }

        // Subscribe to kind:4199 events for the monitored d-tags
        this.subscribe();
        this.isRunning = true;

        logger.info("[AgentDefinitionMonitor] Started", {
            monitoredAgents: this.monitoredAgents.size,
            dTags: Array.from(this.monitoredAgents.values()).map(a => a.definitionDTag),
        });
    }

    /**
     * Stop monitoring and clean up.
     */
    stop(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }

        if (this.subscription) {
            this.subscription.stop();
            this.subscription = null;
        }

        this.pendingEvents.clear();
        this.monitoredAgents.clear();
        this.isRunning = false;

        logger.info("[AgentDefinitionMonitor] Stopped");
    }

    /**
     * Refresh the monitored agent list and resubscribe.
     * Call this when new agents are installed that have definition tracking.
     */
    async refresh(): Promise<void> {
        if (!this.isRunning) return;

        logger.debug("[AgentDefinitionMonitor] Refreshing monitored agent list");

        // Clear stale pending state from the previous subscription
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        this.pendingEvents.clear();

        // Stop existing subscription
        if (this.subscription) {
            this.subscription.stop();
            this.subscription = null;
        }

        // Recollect and resubscribe
        await this.collectMonitoredAgents();

        if (this.monitoredAgents.size > 0) {
            this.subscribe();
        }

        logger.info("[AgentDefinitionMonitor] Refreshed", {
            monitoredAgents: this.monitoredAgents.size,
        });
    }

    /**
     * Scan all stored agents and collect those with definition tracking metadata.
     */
    private async collectMonitoredAgents(): Promise<void> {
        this.monitoredAgents.clear();

        const allAgents = await agentStorage.getAllAgents();

        for (const agent of allAgents) {
            if (!agent.definitionDTag || !agent.definitionAuthor) {
                continue;
            }

            try {
                // Derive pubkey from nsec for the agent
                const signer = new NDKPrivateKeySigner(agent.nsec);
                const pubkey = signer.pubkey;

                const key = this.buildMonitorKey(agent.definitionDTag, agent.definitionAuthor);
                this.monitoredAgents.set(key, {
                    pubkey,
                    slug: agent.slug,
                    definitionDTag: agent.definitionDTag,
                    definitionAuthor: agent.definitionAuthor,
                    currentEventId: agent.eventId,
                    currentCreatedAt: agent.definitionCreatedAt,
                });
            } catch (error) {
                logger.warn("[AgentDefinitionMonitor] Failed to process agent, skipping", {
                    slug: agent.slug,
                    definitionDTag: agent.definitionDTag,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }

    /**
     * Create the NDK subscription for kind:4199 events matching monitored d-tags.
     */
    private subscribe(): void {
        // Collect unique d-tags
        const dTags = new Set<string>();
        for (const agent of this.monitoredAgents.values()) {
            dTags.add(agent.definitionDTag);
        }

        if (dTags.size === 0) return;

        const filter: NDKFilter = {
            kinds: [4199 as number],
            "#d": Array.from(dTags),
        };

        logger.info("[AgentDefinitionMonitor] Subscribing to definition events", {
            dTagCount: dTags.size,
            dTags: Array.from(dTags),
        });

        this.subscription = this.ndk.subscribe(filter, {
            closeOnEose: false,
            groupable: false,
        });

        this.subscription.on("event", (event: NDKEvent) => {
            this.handleIncomingEvent(event);
        });
    }

    /**
     * Handle an incoming kind:4199 event.
     * Filters unauthorized events before staging to prevent them from
     * resetting the debounce timer and deferring legitimate updates.
     * Applies debounce to batch events during initial catch-up.
     */
    private handleIncomingEvent(event: NDKEvent): void {
        const dTag = event.tagValue("d");
        if (!dTag) {
            logger.debug("[AgentDefinitionMonitor] Ignoring event without d-tag", {
                eventId: event.id?.substring(0, 12),
            });
            return;
        }

        const author = event.pubkey;

        // Check if this matches a monitored agent (by d-tag, author checked separately)
        const monitoredAgent = this.findMonitoredAgentByDTag(dTag);
        if (!monitoredAgent) {
            logger.debug("[AgentDefinitionMonitor] Event d-tag does not match any monitored agent", {
                dTag,
                author: author?.substring(0, 12),
            });
            return;
        }

        // Authorization check BEFORE staging — unauthorized events must not
        // reset the debounce timer or displace legitimate pending events
        if (!this.isAuthorized(author, monitoredAgent.definitionAuthor)) {
            logger.debug("[AgentDefinitionMonitor] Ignoring event from unauthorized author", {
                dTag,
                author: author?.substring(0, 12),
                expectedAuthor: monitoredAgent.definitionAuthor.substring(0, 12),
                agentSlug: monitoredAgent.slug,
            });
            return;
        }

        const key = this.buildMonitorKey(dTag, author);

        logger.debug("[AgentDefinitionMonitor] New definition event detected", {
            dTag,
            author: author?.substring(0, 12),
            eventId: event.id?.substring(0, 12),
            createdAt: event.created_at,
        });

        // Store in pending events (keep only the latest per key)
        const existingPending = this.pendingEvents.get(key);
        if (existingPending && existingPending.created_at && event.created_at) {
            if (event.created_at <= existingPending.created_at) {
                logger.debug("[AgentDefinitionMonitor] Skipping older pending event", {
                    dTag,
                    existingCreatedAt: existingPending.created_at,
                    newCreatedAt: event.created_at,
                });
                return;
            }
        }
        this.pendingEvents.set(key, event);

        // Reset debounce timer
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }

        this.debounceTimer = setTimeout(() => {
            this.processPendingEvents();
        }, AgentDefinitionMonitor.DEBOUNCE_MS);
    }

    /**
     * Process all pending events after the debounce period.
     */
    private async processPendingEvents(): Promise<void> {
        const pendingEntries = new Map(this.pendingEvents);
        this.pendingEvents.clear();
        this.debounceTimer = null;

        logger.info("[AgentDefinitionMonitor] Processing pending definition events", {
            count: pendingEntries.size,
        });

        for (const [key, event] of pendingEntries) {
            try {
                await this.processDefinitionEvent(key, event);
            } catch (error) {
                logger.error("[AgentDefinitionMonitor] Failed to process definition event", {
                    key,
                    eventId: event.id?.substring(0, 12),
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }

    /**
     * Process a single definition event: validate, check recency, upgrade, reload.
     * Authorization is already verified in handleIncomingEvent before staging.
     */
    private async processDefinitionEvent(key: string, event: NDKEvent): Promise<void> {
        const dTag = event.tagValue("d");
        const author = event.pubkey;

        if (!dTag || !author) {
            logger.warn("[AgentDefinitionMonitor] Event missing d-tag or author, skipping");
            return;
        }

        // Find the monitored agent by d-tag
        const monitoredAgent = this.findMonitoredAgentByDTag(dTag);
        if (!monitoredAgent) {
            logger.warn("[AgentDefinitionMonitor] No monitored agent found for d-tag", { dTag });
            return;
        }

        // Skip if this is the exact same event we already have
        if (monitoredAgent.currentEventId === event.id) {
            logger.debug("[AgentDefinitionMonitor] Event is the same as current, skipping", {
                dTag,
                eventId: event.id?.substring(0, 12),
            });
            return;
        }

        // Load current agent from storage to compare timestamps
        const storedAgent = await agentStorage.loadAgent(monitoredAgent.pubkey);
        if (!storedAgent) {
            logger.warn("[AgentDefinitionMonitor] Monitored agent not found in storage", {
                pubkey: monitoredAgent.pubkey.substring(0, 12),
                slug: monitoredAgent.slug,
            });
            return;
        }

        // Reject events that are not strictly newer than the stored definition.
        // This prevents out-of-order older events from rolling back fields.
        if (storedAgent.definitionCreatedAt && event.created_at) {
            if (event.created_at <= storedAgent.definitionCreatedAt) {
                logger.debug("[AgentDefinitionMonitor] Skipping event older than current definition", {
                    dTag,
                    eventId: event.id?.substring(0, 12),
                    eventCreatedAt: event.created_at,
                    storedCreatedAt: storedAgent.definitionCreatedAt,
                    agentSlug: monitoredAgent.slug,
                });
                return;
            }
        }

        // Apply the upgrade
        await this.upgradeAgent(storedAgent, monitoredAgent, event);
    }

    /**
     * Check if an author is authorized to publish definition updates.
     */
    private isAuthorized(author: string, originalAuthor: string): boolean {
        // Original author is always authorized
        if (author === originalAuthor) {
            return true;
        }

        // Check whitelist
        if (this.config.whitelistedPubkeys.includes(author)) {
            logger.debug("[AgentDefinitionMonitor] Author authorized via whitelist", {
                author: author.substring(0, 12),
            });
            return true;
        }

        return false;
    }

    /**
     * Upgrade an agent's definition in-place, preserving identity fields.
     */
    private async upgradeAgent(
        storedAgent: StoredAgent,
        monitoredAgent: MonitoredAgent,
        event: NDKEvent,
    ): Promise<void> {
        const agentDef = NDKAgentDefinition.from(event);

        // Capture before state for logging
        const beforeState = {
            eventId: storedAgent.eventId?.substring(0, 12),
            name: storedAgent.name,
            role: storedAgent.role,
        };

        // Track which fields actually change
        const changedFields: string[] = [];

        // Update definition fields (NEVER touch identity fields)
        const newName = agentDef.title || storedAgent.name;
        if (newName !== storedAgent.name) {
            storedAgent.name = newName;
            changedFields.push("name");
        }

        const newRole = agentDef.role || storedAgent.role;
        if (newRole !== storedAgent.role) {
            storedAgent.role = newRole;
            changedFields.push("role");
        }

        const newDescription = agentDef.description || undefined;
        if (newDescription !== storedAgent.description) {
            storedAgent.description = newDescription;
            changedFields.push("description");
        }

        const newInstructions = agentDef.instructions || undefined;
        if (newInstructions !== storedAgent.instructions) {
            storedAgent.instructions = newInstructions;
            changedFields.push("instructions");
        }

        const newUseCriteria = agentDef.useCriteria || undefined;
        if (newUseCriteria !== storedAgent.useCriteria) {
            storedAgent.useCriteria = newUseCriteria;
            changedFields.push("useCriteria");
        }

        // Update tool requirements
        const toolTags = event.tags
            .filter((tag) => tag[0] === "tool" && tag[1])
            .map((tag) => tag[1]);
        const newTools = toolTags.length > 0 ? toolTags : undefined;
        const currentTools = storedAgent.default?.tools;
        if (JSON.stringify(newTools) !== JSON.stringify(currentTools)) {
            if (!storedAgent.default) {
                storedAgent.default = {};
            }
            storedAgent.default.tools = newTools;
            changedFields.push("default.tools");
        }

        // Update eventId to the new event
        const oldEventId = storedAgent.eventId;
        storedAgent.eventId = event.id;
        if (oldEventId !== event.id) {
            changedFields.push("eventId");
        }

        // Update definitionCreatedAt for future recency checks
        if (event.created_at) {
            const oldCreatedAt = storedAgent.definitionCreatedAt;
            storedAgent.definitionCreatedAt = event.created_at;
            if (oldCreatedAt !== event.created_at) {
                changedFields.push("definitionCreatedAt");
            }
        }

        // Update the definition author if the event comes from a different (whitelisted) author
        if (event.pubkey !== storedAgent.definitionAuthor) {
            // Only update definitionAuthor if the event d-tag is from a whitelisted pubkey
            // The original author remains canonical unless explicitly overridden
            changedFields.push("definitionAuthor (noted, not overwritten)");
        }

        if (changedFields.length === 0) {
            logger.info("[AgentDefinitionMonitor] No changes detected in definition update", {
                agentSlug: monitoredAgent.slug,
                dTag: monitoredAgent.definitionDTag,
                eventId: event.id?.substring(0, 12),
            });
            return;
        }

        // Save the updated agent
        await agentStorage.saveAgent(storedAgent);

        // Update monitored agent tracking
        monitoredAgent.currentEventId = event.id;
        monitoredAgent.currentCreatedAt = event.created_at;

        // Capture after state for logging
        const afterState = {
            eventId: storedAgent.eventId?.substring(0, 12),
            name: storedAgent.name,
            role: storedAgent.role,
        };

        logger.info("[AgentDefinitionMonitor] Upgrading agent definition", {
            agentSlug: monitoredAgent.slug,
            agentPubkey: monitoredAgent.pubkey.substring(0, 12),
            dTag: monitoredAgent.definitionDTag,
            beforeState,
            afterState,
            changedFields,
            newEventId: event.id?.substring(0, 12),
            upgradeTimestamp: new Date().toISOString(),
        });

        // Reload agent in all active runtimes
        await this.reloadAgentInRuntimes(monitoredAgent.pubkey, monitoredAgent.slug);
    }

    /**
     * Reload an agent in all active project runtimes that contain it.
     */
    private async reloadAgentInRuntimes(pubkey: string, slug: string): Promise<void> {
        const activeRuntimes = this.getActiveRuntimes();
        let reloadCount = 0;

        for (const [projectId, runtime] of activeRuntimes) {
            const context = runtime.getContext();
            if (!context) continue;

            const agent = context.getAgentByPubkey(pubkey);
            if (!agent) continue;

            try {
                await context.agentRegistry.reloadAgent(pubkey);
                reloadCount++;

                if (context.statusPublisher) {
                    await context.statusPublisher.publishImmediately();
                }

                logger.debug("[AgentDefinitionMonitor] Reloaded agent in runtime", {
                    agentSlug: slug,
                    projectId,
                });
            } catch (error) {
                logger.error("[AgentDefinitionMonitor] Failed to reload agent in runtime", {
                    agentSlug: slug,
                    projectId,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }

        logger.info("[AgentDefinitionMonitor] Agent reloaded in runtimes", {
            agentSlug: slug,
            reloadCount,
            totalRuntimes: activeRuntimes.size,
        });
    }

    /**
     * Find a monitored agent by its d-tag (may match any author).
     */
    private findMonitoredAgentByDTag(dTag: string): MonitoredAgent | undefined {
        for (const agent of this.monitoredAgents.values()) {
            if (agent.definitionDTag === dTag) {
                return agent;
            }
        }
        return undefined;
    }

    /**
     * Build a unique key for a monitored agent.
     */
    private buildMonitorKey(dTag: string, author: string): string {
        return `${dTag}:${author}`;
    }
}
