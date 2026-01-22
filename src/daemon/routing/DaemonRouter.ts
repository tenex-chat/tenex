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
        // 1. Boot events (kind:24000) must be able to start projects
        // 2. Regular events should only trace if we have an active runtime (prevents "other backend" noise)

        // kind:24000 (TenexBootProject) is an EXPLICIT boot request - always allow if project is known
        const isExplicitBootRequest = event.kind === 24000;

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
                // 2. This is an explicit boot request (kind:24000)
                const hasRuntime = activeRuntimes.has(aTagValue);
                if (hasRuntime || isExplicitBootRequest) {
                    logger.debug("shouldTraceEvent: accepting via A-tag", {
                        kind: event.kind,
                        projectId: aTagValue.slice(0, 30),
                        hasRuntime,
                        isExplicitBootRequest,
                    });
                    return true;
                }
                // Known project but no active runtime and not a boot request - don't trace
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

            // Check if this pubkey belongs to any active project's agents
            const projectIds = agentPubkeyToProjects.get(pubkey as Hexpubkey);
            if (projectIds && projectIds.size > 0) {
                // Use the first project (in practice, agents should belong to one project)
                const projectId = Array.from(projectIds)[0];

                const project = knownProjects.get(projectId);
                if (!project) {
                    throw new Error(
                        `Project ${projectId} not found in knownProjects despite being in agentPubkeyToProjects mapping`
                    );
                }

                const runtime = activeRuntimes.get(projectId);
                if (!runtime) {
                    throw new Error(
                        `Runtime for project ${projectId} not found in activeRuntimes despite being in agentPubkeyToProjects mapping`
                    );
                }

                // Get agent from runtime - it MUST exist since we found it in agentPubkeyToProjects
                const context = runtime.getContext();
                if (!context) {
                    throw new Error(`Runtime for project ${projectId} has no context`);
                }

                const agent = context.agentRegistry.getAllAgents().find((a) => a.pubkey === pubkey);
                if (!agent) {
                    throw new Error(
                        `Agent ${pubkey.slice(0, 8)} not found in project ${projectId} despite being in agentPubkeyToProjects mapping`
                    );
                }

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