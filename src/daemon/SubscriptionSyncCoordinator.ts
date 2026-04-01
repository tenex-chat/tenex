import { logger } from "@/utils/logger";
import { getTrustPubkeyService } from "@/services/trust-pubkeys";
import { OwnerAgentListService } from "@/services/OwnerAgentListService";
import type { AgentInstance } from "@/agents/types";
import type { Hexpubkey } from "@nostr-dev-kit/ndk";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ProjectDTag } from "@/types/project-ids";
import type { ProjectRuntime } from "./ProjectRuntime";
import type { RuntimeLifecycle } from "./RuntimeLifecycle";
import type { SubscriptionManager } from "./SubscriptionManager";

const daemonTracer = trace.getTracer("tenex.daemon");

export interface SubscriptionSyncCoordinatorDeps {
    getRuntimeLifecycle: () => RuntimeLifecycle | null;
    getSubscriptionManager: () => SubscriptionManager | null;
    getStoredAgentPubkeys: () => Set<Hexpubkey>;
    addStoredAgentPubkey: (pubkey: Hexpubkey) => void;
    getAgentPubkeyToProjects: () => Map<Hexpubkey, Set<ProjectDTag>>;
    clearAgentPubkeyToProjects: () => void;
    setAgentPubkeyInProjects: (pubkey: Hexpubkey, projects: Set<ProjectDTag>) => void;
}

/**
 * Keeps Nostr subscriptions in sync with current agent/project state.
 *
 * Responsibilities:
 * - updateSubscriptionWithProjectAgents: rebuild routing maps and push to SubscriptionManager
 * - updateSubscriptionAfterRuntimeRemoved: clean up after a runtime stops
 * - handleDynamicAgentAdded: immediately route a newly created agent
 * - syncLessonSubscriptions: add/remove per-agent lesson subscriptions
 * - syncTrustServiceAgentPubkeys: keep trust service in sync
 * - collectAgentData: enumerate all agent pubkeys and definition IDs from active runtimes
 */
export class SubscriptionSyncCoordinator {
    private trackedLessonDefinitionIds = new Set<string>();

    constructor(private readonly deps: SubscriptionSyncCoordinatorDeps) {}

    /**
     * Update subscription with agent pubkeys and definition IDs from all active runtimes.
     * Also sets up the onAgentAdded callback to keep routing synchronized when
     * agents are created dynamically via agents_write tool.
     */
    async updateSubscriptionWithProjectAgents(
        projectId: ProjectDTag,
        runtime: ProjectRuntime
    ): Promise<void> {
        const subscriptionManager = this.deps.getSubscriptionManager();
        if (!subscriptionManager) return;

        await daemonTracer.startActiveSpan(
            "tenex.daemon.update_agent_subscriptions",
            async (span) => {
                span.setAttribute("project.id", projectId);

                try {
                    const { pubkeys: allAgentPubkeys, definitionIds: allAgentDefinitionIds } =
                        this.collectAgentData();

                    span.setAttributes({
                        "agents.pubkeys.total": allAgentPubkeys.size,
                        "agents.definition_ids.total": allAgentDefinitionIds.size,
                    });

                    // Rebuild the routing map from scratch
                    this.deps.clearAgentPubkeyToProjects();

                    // Track which projects each agent belongs to
                    const runtimeLifecycle = this.deps.getRuntimeLifecycle();
                    const activeRuntimes = runtimeLifecycle?.getActiveRuntimes() || new Map();
                    span.setAttribute("projects.active_count", activeRuntimes.size);
                    for (const [pid, rt] of activeRuntimes) {
                        const context = rt.getContext();
                        if (!context) {
                            throw new Error(
                                `Runtime for project ${pid} has no context during subscription update`
                            );
                        }

                        const agents = context.agentRegistry.getAllAgents();
                        for (const agent of agents) {
                            const agentPubkeyToProjects = this.deps.getAgentPubkeyToProjects();
                            if (!agentPubkeyToProjects.has(agent.pubkey)) {
                                this.deps.setAgentPubkeyInProjects(agent.pubkey, new Set());
                            }

                            const projectSet = agentPubkeyToProjects.get(agent.pubkey);
                            if (!projectSet) {
                                throw new Error(
                                    `Agent pubkey ${agent.pubkey.slice(0, 8)} missing from agentPubkeyToProjects after set`
                                );
                            }
                            projectSet.add(pid);
                        }
                    }

                    // Update agent mentions subscription
                    subscriptionManager.updateAgentMentions(Array.from(allAgentPubkeys));

                    // Sync per-agent lesson subscriptions: add new, remove stale
                    this.syncLessonSubscriptions(allAgentDefinitionIds);

                    // Sync trust service with all known agent pubkeys (cross-project trust)
                    this.syncTrustServiceAgentPubkeys();

                    // Set up callback for dynamic agent additions (e.g., via agents_write tool)
                    // This ensures new agents are immediately routable without requiring a restart
                    const context = runtime.getContext();
                    if (context) {
                        context.setOnAgentAdded((agent) => {
                            this.handleDynamicAgentAdded(projectId, agent);
                        });
                    }

                    span.addEvent("daemon.agent_subscriptions_updated", {
                        "agents.pubkeys.total": allAgentPubkeys.size,
                        "agents.definition_ids.total": allAgentDefinitionIds.size,
                        "projects.active_count": activeRuntimes.size,
                    });
                    span.setStatus({ code: SpanStatusCode.OK });
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);

                    span.recordException(error as Error);
                    span.setStatus({
                        code: SpanStatusCode.ERROR,
                        message: errorMessage,
                    });
                    logger.error("Failed to update subscription with project agents", {
                        projectId,
                        error: errorMessage,
                    });
                } finally {
                    span.end();
                }
            }
        );
    }

    /**
     * Update subscription after a runtime has been removed.
     */
    async updateSubscriptionAfterRuntimeRemoved(projectId: ProjectDTag): Promise<void> {
        const subscriptionManager = this.deps.getSubscriptionManager();
        if (!subscriptionManager) return;

        try {
            // Rebuild agent pubkey mapping without the removed project
            const agentPubkeyToProjects = this.deps.getAgentPubkeyToProjects();
            agentPubkeyToProjects.forEach((projectSet, agentPubkey) => {
                projectSet.delete(projectId);
                if (projectSet.size === 0) {
                    agentPubkeyToProjects.delete(agentPubkey);
                }
            });

            // Collect all agent pubkeys and definition IDs from remaining active runtimes
            const { pubkeys: allAgentPubkeys, definitionIds: allAgentDefinitionIds } =
                this.collectAgentData();

            subscriptionManager.updateAgentMentions(Array.from(allAgentPubkeys));
            this.syncLessonSubscriptions(allAgentDefinitionIds);

            // Sync trust service with remaining agent pubkeys (cross-project trust)
            this.syncTrustServiceAgentPubkeys();
        } catch (error) {
            logger.error("Failed to update subscription after runtime removed", {
                projectId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    /**
     * Handle a dynamically added agent (e.g., created via agents_write tool).
     * Updates the routing map and subscription to make the agent immediately routable.
     */
    handleDynamicAgentAdded(projectId: ProjectDTag, agent: AgentInstance): void {
        const agentPubkeyToProjects = this.deps.getAgentPubkeyToProjects();
        // Add to routing map
        if (!agentPubkeyToProjects.has(agent.pubkey)) {
            this.deps.setAgentPubkeyInProjects(agent.pubkey, new Set());
        }
        const projectSet = agentPubkeyToProjects.get(agent.pubkey);
        if (projectSet) {
            projectSet.add(projectId);
        }

        // Persist in stored set so trust survives if this project later stops
        this.deps.addStoredAgentPubkey(agent.pubkey);

        // Update subscriptions
        const subscriptionManager = this.deps.getSubscriptionManager();
        if (subscriptionManager) {
            const allPubkeys = Array.from(agentPubkeyToProjects.keys());
            subscriptionManager.updateAgentMentions(allPubkeys);

            // Add lesson subscription if this agent has a definition ID
            if (agent.eventId) {
                subscriptionManager.addLessonSubscription(agent.eventId);
                this.trackedLessonDefinitionIds.add(agent.eventId);
            }
        }

        // Register with global 14199 service
        OwnerAgentListService.getInstance().registerAgents(projectId, [agent.pubkey]);

        // Sync trust service with updated agent pubkeys (cross-project trust)
        this.syncTrustServiceAgentPubkeys();

        logger.info("Dynamic agent added to routing", {
            projectId,
            agentSlug: agent.slug,
            agentPubkey: agent.pubkey.slice(0, 8),
        });
    }

    /**
     * Sync per-agent lesson subscriptions: add subscriptions for new definition IDs,
     * remove subscriptions for definition IDs no longer active.
     */
    syncLessonSubscriptions(currentDefinitionIds: Set<string>): void {
        const subscriptionManager = this.deps.getSubscriptionManager();
        if (!subscriptionManager) return;

        // Collect existing lesson subscription IDs from the subscription manager
        const existingIds = this.trackedLessonDefinitionIds;

        // Add new
        for (const id of currentDefinitionIds) {
            if (!existingIds.has(id)) {
                subscriptionManager.addLessonSubscription(id);
            }
        }

        // Remove stale
        for (const id of existingIds) {
            if (!currentDefinitionIds.has(id)) {
                subscriptionManager.removeLessonSubscription(id);
            }
        }

        this.trackedLessonDefinitionIds = new Set(currentDefinitionIds);
    }

    /**
     * Push current agent pubkeys to TrustPubkeyService for cross-project trust.
     * Unions the daemon-level runtime pubkeys (from currently running projects)
     * with the stored pubkeys seeded from AgentStorage at startup (covers
     * not-yet-running projects), so trust is never dropped for known agents.
     */
    syncTrustServiceAgentPubkeys(): void {
        const agentPubkeyToProjects = this.deps.getAgentPubkeyToProjects();
        const allPubkeys = new Set<Hexpubkey>(agentPubkeyToProjects.keys());

        // Union with stored pubkeys so non-running projects retain trust
        for (const pubkey of this.deps.getStoredAgentPubkeys()) {
            allPubkeys.add(pubkey);
        }

        getTrustPubkeyService().setGlobalAgentPubkeys(allPubkeys);
    }

    /**
     * Collect all agent pubkeys and definition IDs from active runtimes.
     */
    collectAgentData(): { pubkeys: Set<Hexpubkey>; definitionIds: Set<string> } {
        const pubkeys = new Set<Hexpubkey>();
        const definitionIds = new Set<string>();

        const runtimeLifecycle = this.deps.getRuntimeLifecycle();
        if (!runtimeLifecycle) {
            return { pubkeys, definitionIds };
        }

        const activeRuntimes = runtimeLifecycle.getActiveRuntimes();
        for (const [pid, rt] of activeRuntimes) {
            const context = rt.getContext();
            if (!context) {
                throw new Error(
                    `Runtime for project ${pid} has no context during agent collection`
                );
            }

            const agents = context.agentRegistry.getAllAgents();
            for (const agent of agents) {
                pubkeys.add(agent.pubkey);

                if (agent.eventId) {
                    definitionIds.add(agent.eventId);
                }
            }
        }

        return { pubkeys, definitionIds };
    }
}
