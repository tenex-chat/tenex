import {
    isNeverRouteKind,
    isProjectEvent,
    isConfigUpdate,
    isLessonEvent,
} from "@/nostr/AgentEventDecoder";
import { tryExtractDTagFromAddress, type ProjectDTag } from "@/types/project-ids";
import { logger } from "@/utils/logger";
import type { Hexpubkey, NDKEvent } from "@nostr-dev-kit/ndk";
import type { NDKProject } from "@nostr-dev-kit/ndk";
import type { ProjectRuntime } from "../ProjectRuntime";

/**
 * Result of routing decision for an event
 */
export interface RoutingDecision {
    projectId: ProjectDTag | null;
    method: "a_tag" | "p_tag_agent" | "none";
    matchedTags: string[];
    reason: string;
}

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
 */
export function shouldTraceEvent(
    event: NDKEvent,
    knownProjects: Map<ProjectDTag, NDKProject>,
    knownAgentPubkeys: Set<Hexpubkey>,
    whitelistedPubkeys: Hexpubkey[],
    activeRuntimes: Map<ProjectDTag, ProjectRuntime>
): boolean {
    // Never-route kinds don't need tracing at all
    if (isNeverRouteKind(event)) {
        logger.debug("shouldTraceEvent: never-route kind", { kind: event.kind });
        return false;
    }

    // Project events from whitelisted authors should always be traced.
    // This includes new projects we haven't seen yet (avoiding bootstrap problem).
    if (isProjectEvent(event)) {
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
    if (isConfigUpdate(event)) {
        const isWhitelisted = whitelistedPubkeys.includes(event.pubkey);
        return isWhitelisted;
    }

    // Lesson events from our agents should be traced if we have a runtime
    // for at least one of their projects.
    if (isLessonEvent(event)) {
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
            aTags: event.tags.filter((t) => t[0] === "a").map((t) => t[1]),
        });
    }

    // Check if event is authored by one of our agents with an active runtime
    if (knownAgentPubkeys.has(event.pubkey)) {
        // Find if any of our active runtimes contain this agent
        for (const [, runtime] of activeRuntimes) {
            const context = runtime.getContext();
            if (context) {
                const agent = context.agentRegistry
                    .getAllAgents()
                    .find((a) => a.pubkey === event.pubkey);
                if (agent) {
                    return true;
                }
            }
        }
        // Agent known but no active runtime - don't trace
        return false;
    }

    // Check for a-tags to our projects (NIP-33 addressable event references)
    // a-tag values are NIP-33 addresses ("31933:pubkey:dTag") — extract the d-tag for lookup
    const aTags = event.tags.filter((t) => t[0] === "a");
    for (const tag of aTags) {
        const aTagValue = tag[1];
        if (!aTagValue) continue;

        const dTag = tryExtractDTagFromAddress(aTagValue);
        if (dTag && knownProjects.has(dTag)) {
            // Project is known - trace if:
            // 1. We have an active runtime, OR
            // 2. This event can boot projects (kind:1 or kind:24000)
            // CRITICAL: kind:1 events with explicit A-tags MUST trace even without runtime
            // to prevent cross-project routing bugs when agents exist in multiple projects
            const hasRuntime = activeRuntimes.has(dTag);
            if (hasRuntime || canBootProject) {
                logger.debug("shouldTraceEvent: accepting via A-tag", {
                    kind: event.kind,
                    projectDTag: dTag,
                    hasRuntime,
                    canBootProject,
                });
                return true;
            }
            // Known project but no active runtime and cannot boot - don't trace
            logger.debug("shouldTraceEvent: rejecting - known project but no runtime", {
                kind: event.kind,
                projectDTag: dTag,
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
                    const agent = context.agentRegistry
                        .getAllAgents()
                        .find((a) => a.pubkey === pubkey);
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
        aTags: aTags.map((t) => t[1]?.slice(0, 20)),
        pTags: pTags.map((t) => t[1]?.slice(0, 8)),
        knownProjectsCount: knownProjects.size,
        activeRuntimesCount: activeRuntimes.size,
    });
    return false;
}

/**
 * Determine which project an event should be routed to
 */
export function determineTargetProject(
    event: NDKEvent,
    knownProjects: Map<ProjectDTag, NDKProject>,
    agentPubkeyToProjects: Map<Hexpubkey, Set<ProjectDTag>>,
    activeRuntimes: Map<ProjectDTag, ProjectRuntime>
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
    const routingByATag = routeByATag(event, knownProjects);
    if (routingByATag) {
        return routingByATag;
    }

    // Check for agent P-tags (find project by agent pubkey)
    const routingByPTag = routeByPTag(event, knownProjects, agentPubkeyToProjects, activeRuntimes);
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
 * Check if an event was published by an agent in the system
 */
export function isAgentEvent(
    event: NDKEvent,
    agentPubkeyToProjects: Map<Hexpubkey, Set<ProjectDTag>>
): boolean {
    return agentPubkeyToProjects.has(event.pubkey);
}

/**
 * Check if an event has p-tags pointing to system entities (whitelisted pubkeys or other agents)
 */
export function hasPTagsToSystemEntities(
    event: NDKEvent,
    whitelistedPubkeys: Hexpubkey[],
    agentPubkeyToProjects: Map<Hexpubkey, Set<ProjectDTag>>
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
 * Extract project d-tag from a project event.
 */
export function buildProjectId(event: NDKEvent): ProjectDTag {
    const dTag = event.tags.find((t) => t[0] === "d")?.[1];
    if (!dTag) {
        throw new Error("Project event missing d tag");
    }
    return dTag as ProjectDTag;
}

/**
 * Route event based on `a` tags (explicit project references).
 * A-tag values are NIP-33 addresses — we extract the d-tag for internal lookup.
 */
function routeByATag(
    event: NDKEvent,
    knownProjects: Map<ProjectDTag, NDKProject>
): RoutingDecision | null {
    // NIP-33 addressable events use lowercase 'a' tags only
    const aTags = event.tags.filter((t) => t[0] === "a");
    const projectATags = aTags.filter((t) => t[1]?.startsWith("31933:"));

    logger.debug("Checking a-tags for project routing", {
        eventId: event.id.slice(0, 8),
        aTagsFound: projectATags.length,
        aTags: projectATags.map((t) => t[1]),
    });

    for (const tag of projectATags) {
        const aTagValue = tag[1];
        if (!aTagValue) continue;

        // Extract d-tag from NIP-33 address for internal lookup
        const dTag = tryExtractDTagFromAddress(aTagValue);
        if (!dTag) continue;

        if (knownProjects.has(dTag)) {
            const project = knownProjects.get(dTag);

            logger.info("Routing event to project via a-tag", {
                eventId: event.id.slice(0, 8),
                eventKind: event.kind,
                projectDTag: dTag,
                projectTitle: project?.tagValue("title"),
            });

            return {
                projectId: dTag,
                method: "a_tag",
                matchedTags: [aTagValue],
                reason: `Matched project a-tag: ${aTagValue}`,
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
function routeByPTag(
    event: NDKEvent,
    knownProjects: Map<ProjectDTag, NDKProject>,
    agentPubkeyToProjects: Map<Hexpubkey, Set<ProjectDTag>>,
    activeRuntimes: Map<ProjectDTag, ProjectRuntime>
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
            projectId: ProjectDTag;
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
                logger.warn(
                    "routeByPTag: project in agentPubkeyToProjects but not in knownProjects",
                    {
                        projectDTag: projectId,
                        agentPubkey: pubkey.slice(0, 8),
                    }
                );
                continue;
            }

            const context = runtime.getContext();
            if (!context) {
                logger.warn("routeByPTag: runtime has no context", {
                    projectDTag: projectId,
                });
                continue;
            }

            const agent = context.agentRegistry.getAllAgents().find((a) => a.pubkey === pubkey);
            if (!agent) {
                // Agent might have been removed from this project after mapping was created
                logger.debug("routeByPTag: agent not found in project registry", {
                    projectDTag: projectId,
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
            logger.warn(
                "routeByPTag: agent exists in multiple active projects - cannot disambiguate without A-tag",
                {
                    eventId: event.id?.slice(0, 8),
                    agentPubkey: pubkey.slice(0, 8),
                    activeProjects: activeProjectsForAgent.map((p) => ({
                        projectDTag: p.projectId,
                        projectTitle: p.project.tagValue("title"),
                    })),
                }
            );
            // Return null to indicate we couldn't route definitively
            return null;
        }

        // Exactly one active project - safe to route
        const { projectId, project, agent } = activeProjectsForAgent[0];

        logger.info("Routing event to project via agent P-tag", {
            eventId: event.id.slice(0, 8),
            eventKind: event.kind,
            projectDTag: projectId,
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
