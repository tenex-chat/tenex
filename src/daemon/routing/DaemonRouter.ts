import { AgentEventDecoder } from "@/nostr/AgentEventDecoder";
import { logger } from "@/utils/logger";
import type { Hexpubkey, NDKEvent } from "@nostr-dev-kit/ndk";
import type { NDKProject } from "@nostr-dev-kit/ndk";
import type { ProjectRuntime } from "../ProjectRuntime";

/**
 * Result of routing decision for an event
 */
export interface RoutingDecision {
    projectId: string | null;
    method: "a_tag" | "p_tag_agent" | "none";
    matchedTags: string[];
    reason: string;
}

/**
 * Static utility class for daemon-level event routing.
 * Determines which project an event should be routed to based on tags.
 *
 * This is daemon-level routing (event -> project), separate from
 * AgentRouter which handles project-level routing (event -> agent).
 */
export class DaemonRouter {
    /**
     * Check if this daemon should trace this event.
     *
     * This balances two concerns:
     * 1. Avoiding noisy traces when multiple daemons share relays
     * 2. Allowing project discovery (bootstrap problem)
     *
     * The key insight: only trace events that this daemon will actually process.
     * - Project events: Always trace from whitelisted authors (for discovery)
     * - Other events: Only trace if we have a runtime OR event can boot one
     *
     * @param event - The event to check
     * @param knownProjects - Map of project IDs this daemon controls
     * @param knownAgentPubkeys - Set of agent pubkeys from project definitions
     * @param whitelistedPubkeys - Array of pubkeys that can create projects
     * @param activeRuntimes - Map of currently active project runtimes
     * @returns true if the event should be traced by this daemon
     */
    static shouldTraceEvent(
        event: NDKEvent,
        knownProjects: Map<string, NDKProject>,
        knownAgentPubkeys: Set<Hexpubkey>,
        whitelistedPubkeys: Hexpubkey[],
        activeRuntimes: Map<string, ProjectRuntime>
    ): boolean {
        // Never-route kinds don't need tracing at all
        if (AgentEventDecoder.isNeverRouteKind(event)) {
            logger.debug("shouldTraceEvent: never-route kind", { kind: event.kind });
            return false;
        }

        // Project events from whitelisted authors should always be traced.
        // This includes new projects we haven't seen yet (avoiding bootstrap problem).
        if (AgentEventDecoder.isProjectEvent(event)) {
            const isWhitelisted = whitelistedPubkeys.includes(event.pubkey);
            logger.debug("shouldTraceEvent: project event", {
                kind: event.kind,
                author: event.pubkey.slice(0, 8),
                isWhitelisted,
                whitelistedCount: whitelistedPubkeys.length,
            });
            return isWhitelisted;
        }

        // Agent config updates (kind 24020) from whitelisted authors are handled
        // at daemon level (no project routing needed for global updates).
        if (AgentEventDecoder.isConfigUpdate(event)) {
            const isWhitelisted = whitelistedPubkeys.includes(event.pubkey);
            return isWhitelisted;
        }

        // Lesson events from our agents should be traced if we have a runtime
        // for at least one of their projects.
        if (AgentEventDecoder.isLessonEvent(event)) {
            // Check if this agent's project has an active runtime
            for (const [projectId] of activeRuntimes) {
                if (knownAgentPubkeys.has(event.pubkey)) {
                    // Agent is known, check if their project is running
                    const project = knownProjects.get(projectId);
                    if (project) {
                        return true;
                    }
                }
            }
            return false;
        }

        // For other events, we need to determine if we'd actually process them.
        // This balances two concerns:
        // 1. Boot events (kind:24000 and kind:1) must be able to start projects
        // 2. Regular events should only trace if we have an active runtime (prevents "other backend" noise)

        // kind:24000 (TenexBootProject) is an EXPLICIT boot request - always allow if project is known
        // kind:1 (Text) can also boot projects (per routeEventToProject logic)
        const isExplicitBootRequest = event.kind === 24000;
        const canBootProject = event.kind === 1 || event.kind === 24000;

        if (isExplicitBootRequest) {
            logger.debug("shouldTraceEvent: boot request event", {
                kind: event.kind,
                author: event.pubkey.slice(0, 8),
                aTags: event.tags.filter(t => t[0] === "A" || t[0] === "a").map(t => t[1]),
            });
        }

        // Check if event is authored by one of our agents with an active runtime
        if (knownAgentPubkeys.has(event.pubkey)) {
            // Find if any of our active runtimes contain this agent
            for (const [, runtime] of activeRuntimes) {
                const context = runtime.getContext();
                if (context) {
                    const agent = context.agentRegistry.getAllAgents().find(a => a.pubkey === event.pubkey);
                    if (agent) {
                        return true;
                    }
                }
            }
            // Agent known but no active runtime - don't trace
            return false;
        }

        // Check for A-tags to our projects
        const aTags = event.tags.filter((t) => t[0] === "A" || t[0] === "a");
        for (const tag of aTags) {
            const aTagValue = tag[1];
            if (aTagValue && knownProjects.has(aTagValue)) {
                // Project is known - trace if:
                // 1. We have an active runtime, OR
                // 2. This event can boot projects (kind:1 or kind:24000)
                // CRITICAL: kind:1 events with explicit A-tags MUST trace even without runtime
                // to prevent cross-project routing bugs when agents exist in multiple projects
                const hasRuntime = activeRuntimes.has(aTagValue);
                if (hasRuntime || canBootProject) {
                    logger.debug("shouldTraceEvent: accepting via A-tag", {
                        kind: event.kind,
                        projectId: aTagValue.slice(0, 30),
                        hasRuntime,
                        canBootProject,
                    });
                    return true;
                }
                // Known project but no active runtime and cannot boot - don't trace
                logger.debug("shouldTraceEvent: rejecting - known project but no runtime", {
                    kind: event.kind,
                    projectId: aTagValue.slice(0, 30),
                });
            }
        }

        // Check for P-tags to our agents
        const pTags = event.tags.filter((t) => t[0] === "p");
        for (const tag of pTags) {
            const pubkey = tag[1];
            if (pubkey && knownAgentPubkeys.has(pubkey as Hexpubkey)) {
                // Find if this agent's project has an active runtime
                for (const [, runtime] of activeRuntimes) {
                    const context = runtime.getContext();
                    if (context) {
                        const agent = context.agentRegistry.getAllAgents().find(a => a.pubkey === pubkey);
                        if (agent) {
                            return true;
                        }
                    }
                }
                // Agent known but no active runtime - don't trace
                return false;
            }
        }

        // No match - don't trace
        logger.debug("shouldTraceEvent: no match found", {
            kind: event.kind,
            author: event.pubkey.slice(0, 8),
            aTags: aTags.map(t => t[1]?.slice(0, 20)),
            pTags: pTags.map(t => t[1]?.slice(0, 8)),
            knownProjectsCount: knownProjects.size,
            activeRuntimesCount: activeRuntimes.size,
        });
        return false;
    }

    /**
     * Determine which project an event should be routed to
     * @param event - The event to route
     * @param knownProjects - Map of known project IDs to NDKProject instances
     * @param agentPubkeyToProjects - Map of agent pubkeys to their project IDs
     * @param activeRuntimes - Map of active project runtimes (for agent lookup)
     * @returns Routing decision with target project or null if no match
     */
    static determineTargetProject(
        event: NDKEvent,
        knownProjects: Map<string, NDKProject>,
        agentPubkeyToProjects: Map<Hexpubkey, Set<string>>,
        activeRuntimes: Map<string, ProjectRuntime>
    ): RoutingDecision {
        // Skip routing for global identity kinds (NIP-01, NIP-02)
        // kind:0 (profile metadata) and kind:3 (contact list) are global user/agent identity
        // and should never be routed to specific projects
        if (event.kind === 0 || event.kind === 3) {
            return {
                projectId: null,
                method: "none",
                matchedTags: [],
                reason: `Global identity kind (${event.kind}) - not project-specific`,
            };
        }

        // Check for explicit project A-tags first (highest priority)
        const routingByATag = this.routeByATag(event, knownProjects);
        if (routingByATag) {
            return routingByATag;
        }

        // Check for agent P-tags (find project by agent pubkey)
        const routingByPTag = this.routeByPTag(
            event,
            knownProjects,
            agentPubkeyToProjects,
            activeRuntimes
        );
        if (routingByPTag) {
            return routingByPTag;
        }

        // No match found
        const aTags = event.tags.filter((t) => t[0] === "a");
        const pTags = event.tags.filter((t) => t[0] === "p");
        const projectATags = aTags.filter((t) => t[1]?.startsWith("31933:"));

        const reason =
            projectATags.length > 0
                ? `A-tags found but no matching known projects: ${projectATags.map((t) => t[1]).join(", ")}`
                : pTags.length > 0
                  ? `P-tags found but no matching agents: ${pTags.map((t) => t[1]?.slice(0, 8)).join(", ")}`
                  : "No A-tags or P-tags found";

        logger.debug("No project match found", {
            eventId: event.id.slice(0, 8),
            reason,
        });

        return {
            projectId: null,
            method: "none",
            matchedTags: [],
            reason,
        };
    }

    /**
     * Route event based on A-tags (explicit project references)
     */
    private static routeByATag(
        event: NDKEvent,
        knownProjects: Map<string, NDKProject>
    ): RoutingDecision | null {
        const aTags = event.tags.filter((t) => t[0] === "a");
        const projectATags = aTags.filter((t) => t[1]?.startsWith("31933:"));

        logger.debug("Checking A-tags for project routing", {
            eventId: event.id.slice(0, 8),
            aTagsFound: projectATags.length,
            aTags: projectATags.map((t) => t[1]),
        });

        for (const tag of projectATags) {
            const aTagValue = tag[1];
            if (aTagValue && knownProjects.has(aTagValue)) {
                const project = knownProjects.get(aTagValue);
                if (!project) {
                    throw new Error(
                        `Project ${aTagValue} not found in knownProjects despite has() check`
                    );
                }

                logger.info("Routing event to project via A-tag", {
                    eventId: event.id.slice(0, 8),
                    eventKind: event.kind,
                    projectId: aTagValue,
                    projectTitle: project.tagValue("title"),
                });

                return {
                    projectId: aTagValue,
                    method: "a_tag",
                    matchedTags: [aTagValue],
                    reason: `Matched project A-tag: ${aTagValue}`,
                };
            }
        }

        if (projectATags.length > 0) {
            logger.debug("A-tags found but no matching known projects", {
                eventId: event.id.slice(0, 8),
                projectATags: projectATags.map((t) => t[1]),
                knownProjects: Array.from(knownProjects.keys()),
            });
        }

        return null;
    }

    /**
     * Route event based on P-tags (agent pubkey references)
     *
     * IMPORTANT: P-tag routing is fallback behavior when A-tag routing fails.
     * When an agent exists in multiple projects, we ONLY route via P-tag if
     * exactly one of those projects has an active runtime. This prevents
     * cross-project routing bugs where an event intended for project A gets
     * routed to project B because B happened to be running.
     */
    private static routeByPTag(
        event: NDKEvent,
        knownProjects: Map<string, NDKProject>,
        agentPubkeyToProjects: Map<Hexpubkey, Set<string>>,
        activeRuntimes: Map<string, ProjectRuntime>
    ): RoutingDecision | null {
        const pTags = event.tags.filter((t) => t[0] === "p");

        logger.debug("Checking P-tags for agent routing", {
            eventId: event.id.slice(0, 8),
            pTagsFound: pTags.length,
            pTags: pTags.map((t) => t[1]?.slice(0, 8)),
        });

        for (const tag of pTags) {
            const pubkey = tag[1];
            if (!pubkey) {
                continue;
            }

            // Check if this pubkey belongs to any project's agents
            const projectIds = agentPubkeyToProjects.get(pubkey as Hexpubkey);
            if (!projectIds || projectIds.size === 0) {
                continue;
            }

            // Find which of this agent's projects have active runtimes
            const activeProjectsForAgent: Array<{
                projectId: string;
                project: NDKProject;
                runtime: ProjectRuntime;
                agent: { slug: string; pubkey: string };
            }> = [];

            for (const projectId of projectIds) {
                const runtime = activeRuntimes.get(projectId);
                if (!runtime) {
                    continue; // Project not running - skip
                }

                const project = knownProjects.get(projectId);
                if (!project) {
                    logger.warn("routeByPTag: project in agentPubkeyToProjects but not in knownProjects", {
                        projectId: projectId.slice(0, 20),
                        agentPubkey: pubkey.slice(0, 8),
                    });
                    continue;
                }

                const context = runtime.getContext();
                if (!context) {
                    logger.warn("routeByPTag: runtime has no context", {
                        projectId: projectId.slice(0, 20),
                    });
                    continue;
                }

                const agent = context.agentRegistry.getAllAgents().find((a) => a.pubkey === pubkey);
                if (!agent) {
                    // Agent might have been removed from this project after mapping was created
                    logger.debug("routeByPTag: agent not found in project registry", {
                        projectId: projectId.slice(0, 20),
                        agentPubkey: pubkey.slice(0, 8),
                    });
                    continue;
                }

                activeProjectsForAgent.push({ projectId, project, runtime, agent });
            }

            // If no active projects found for this agent, skip to next P-tag
            if (activeProjectsForAgent.length === 0) {
                logger.debug("routeByPTag: no active projects for agent", {
                    agentPubkey: pubkey.slice(0, 8),
                    knownProjectCount: projectIds.size,
                });
                continue;
            }

            // CRITICAL: Only route via P-tag if there's exactly ONE active project
            // If multiple projects are active with this agent, we can't determine
            // the correct target - the event should have used an A-tag for disambiguation
            if (activeProjectsForAgent.length > 1) {
                logger.warn("routeByPTag: agent exists in multiple active projects - cannot disambiguate without A-tag", {
                    eventId: event.id?.slice(0, 8),
                    agentPubkey: pubkey.slice(0, 8),
                    activeProjects: activeProjectsForAgent.map(p => ({
                        projectId: p.projectId.slice(0, 20),
                        projectTitle: p.project.tagValue("title"),
                    })),
                });
                // Return null to indicate we couldn't route definitively
                return null;
            }

            // Exactly one active project - safe to route
            const { projectId, project, agent } = activeProjectsForAgent[0];

            logger.info("Routing event to project via agent P-tag", {
                eventId: event.id.slice(0, 8),
                eventKind: event.kind,
                projectId,
                projectTitle: project.tagValue("title"),
                agentPubkey: pubkey.slice(0, 8),
                agentSlug: agent.slug,
            });

            return {
                projectId,
                method: "p_tag_agent",
                matchedTags: [pubkey],
                reason: `Matched agent P-tag: ${pubkey.slice(0, 8)}`,
            };
        }

        return null;
    }

    /**
     * Check if an event was published by an agent in the system
     * @param event - The event to check
     * @param agentPubkeyToProjects - Map of agent pubkeys to their projects
     * @returns True if the event author is a known agent
     */
    static isAgentEvent(
        event: NDKEvent,
        agentPubkeyToProjects: Map<Hexpubkey, Set<string>>
    ): boolean {
        return agentPubkeyToProjects.has(event.pubkey);
    }

    /**
     * Check if an event has p-tags pointing to system entities (whitelisted pubkeys or other agents)
     * @param event - The event to check
     * @param whitelistedPubkeys - Set of whitelisted user pubkeys
     * @param agentPubkeyToProjects - Map of agent pubkeys to their projects
     * @returns True if the event has p-tags to system entities
     */
    static hasPTagsToSystemEntities(
        event: NDKEvent,
        whitelistedPubkeys: Hexpubkey[],
        agentPubkeyToProjects: Map<Hexpubkey, Set<string>>
    ): boolean {
        const pTags = event.tags.filter((t) => t[0] === "p");

        for (const tag of pTags) {
            const pubkey = tag[1];
            if (!pubkey) {
                continue;
            }

            // Check if p-tag points to a whitelisted pubkey
            if (whitelistedPubkeys.includes(pubkey as Hexpubkey)) {
                return true;
            }

            // Check if p-tag points to another agent in the system
            if (agentPubkeyToProjects.has(pubkey as Hexpubkey)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Build project ID from event
     * Format: "31933:authorPubkey:dTag"
     * @param event - Project event (kind 31933)
     * @returns Project ID string
     */
    static buildProjectId(event: NDKEvent): string {
        return event.tagId();
    }
}