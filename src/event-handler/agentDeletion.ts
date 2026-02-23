import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { NDKEvent as NDKEventClass } from "@nostr-dev-kit/ndk";
import { getNDK } from "@/nostr/ndkClient";
import { config } from "@/services/ConfigService";
import { getProjectContext } from "@/services/projects";
import { agentStorage } from "@/agents/AgentStorage";
import { Nip46SigningService, Nip46SigningLog } from "@/services/nip46";
import { formatAnyError } from "@/lib/error-formatter";
import { logger } from "@/utils/logger";
import { trace } from "@opentelemetry/api";

const DEBOUNCE_MS = 5000;

/**
 * Per-project debounce state for 31933 updates after agent deletion.
 * Batches rapid deletions into a single 31933 publish per project.
 */
const projectUpdateTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

/**
 * Clear all pending debounce timers. Exported for test cleanup only.
 * @internal
 */
export function _testClearPendingTimers(): void {
    for (const timer of projectUpdateTimers.values()) {
        clearTimeout(timer);
    }
    projectUpdateTimers.clear();
}

/**
 * Handle a kind 24030 agent deletion event.
 *
 * Supported scopes:
 * - "project": Remove agent from a specific project (requires `a` tag with 31933 reference)
 * - "global": Remove agent from all projects owned by the event author
 *
 * Processing order:
 * 1. Parse & validate tags (p, r, a)
 * 2. Authorize the event author (must be whitelisted project owner)
 * 3. Remove agent from local state (storage + in-memory registry)
 * 4. Debounced NIP-46-signed 31933 update (non-blocking side effect)
 */
export async function handleAgentDeletion(event: NDKEvent): Promise<void> {
    try {
        // 1. Parse required tags
        const agentPubkey = event.tagValue("p");
        if (!agentPubkey) {
            logger.warn("[AgentDeletion] Event missing required p tag (agent pubkey)", {
                eventId: event.id?.substring(0, 12),
            });
            return;
        }

        const scope = event.tagValue("r");
        if (!scope || (scope !== "project" && scope !== "global")) {
            logger.warn("[AgentDeletion] Event missing or invalid r tag (scope)", {
                eventId: event.id?.substring(0, 12),
                scope,
            });
            return;
        }

        // 2. Authorization: event author must be a whitelisted pubkey
        const whitelistedPubkeys = config.getWhitelistedPubkeys(undefined, config.getConfig());
        if (!whitelistedPubkeys.includes(event.pubkey)) {
            logger.warn("[AgentDeletion] Unauthorized — event author not whitelisted", {
                eventId: event.id?.substring(0, 12),
                author: event.pubkey.substring(0, 12),
            });
            return;
        }

        trace.getActiveSpan()?.addEvent("agent_deletion.received", {
            "deletion.agent_pubkey": agentPubkey.substring(0, 12),
            "deletion.scope": scope,
            "deletion.author": event.pubkey.substring(0, 12),
        });

        // 3. Dispatch by scope
        if (scope === "project") {
            const aTag = event.tagValue("a");
            if (!aTag) {
                logger.warn("[AgentDeletion] Project-scoped deletion missing required a tag", {
                    eventId: event.id?.substring(0, 12),
                });
                return;
            }
            await handleProjectScopedDeletion(event, agentPubkey, aTag);
        } else {
            await handleGlobalDeletion(event, agentPubkey);
        }
    } catch (error) {
        logger.error("[AgentDeletion] Failed to handle agent deletion event", {
            eventId: event.id?.substring(0, 12),
            error: formatAnyError(error),
        });
    }
}

/**
 * Remove an agent from a single project.
 */
async function handleProjectScopedDeletion(
    event: NDKEvent,
    agentPubkey: string,
    aTag: string,
): Promise<void> {
    // Parse the a-tag: "31933:<pubkey>:<d-tag>"
    const parts = aTag.split(":");
    if (parts.length < 3) {
        logger.warn("[AgentDeletion] Invalid a-tag format", {
            eventId: event.id?.substring(0, 12),
            aTag,
        });
        return;
    }
    const projectDTag = parts.slice(2).join(":");

    // Verify the a-tag references the currently loaded project
    const projectContext = getProjectContext();
    const currentProjectDTag = projectContext.project.dTag || projectContext.project.tagValue("d");
    if (projectDTag !== currentProjectDTag) {
        logger.debug("[AgentDeletion] Ignoring deletion for different project", {
            eventId: event.id?.substring(0, 12),
            targetProject: projectDTag,
            currentProject: currentProjectDTag,
        });
        return;
    }

    // Verify event author matches the project owner
    if (event.pubkey !== projectContext.project.pubkey) {
        logger.warn("[AgentDeletion] Event author does not match project owner", {
            eventId: event.id?.substring(0, 12),
            eventAuthor: event.pubkey.substring(0, 12),
            projectOwner: projectContext.project.pubkey.substring(0, 12),
        });
        return;
    }

    // Find the agent in the registry
    const agent = projectContext.getAgentByPubkey(agentPubkey);
    if (!agent) {
        logger.warn("[AgentDeletion] Agent not found in project, no-op", {
            agentPubkey: agentPubkey.substring(0, 12),
            projectDTag,
        });
        return;
    }

    // Remove from local state (storage + in-memory + 14199 snapshot)
    const removed = await projectContext.agentRegistry.removeAgentFromProject(agent.slug);

    if (removed) {
        logger.info("[AgentDeletion] Removed agent from project", {
            agentSlug: agent.slug,
            agentPubkey: agentPubkey.substring(0, 12),
            projectDTag,
            reason: event.content || undefined,
        });

        trace.getActiveSpan()?.addEvent("agent_deletion.removed", {
            "deletion.agent_slug": agent.slug,
            "deletion.project": projectDTag,
            "deletion.scope": "project",
        });

        // Publish updated project status if available
        if (projectContext.statusPublisher) {
            await projectContext.statusPublisher.publishImmediately();
        }

        // Schedule debounced 31933 update
        scheduleProjectEventUpdate(projectDTag, event.pubkey, agentPubkey);
    }
}

/**
 * Remove an agent from all projects owned by the event author.
 */
async function handleGlobalDeletion(
    event: NDKEvent,
    agentPubkey: string,
): Promise<void> {
    // Find all projects this agent belongs to
    const projects = await agentStorage.getAgentProjects(agentPubkey);

    if (projects.length === 0) {
        logger.warn("[AgentDeletion] Agent has no project associations, no-op", {
            agentPubkey: agentPubkey.substring(0, 12),
        });
        return;
    }

    const projectContext = getProjectContext();
    const currentProjectDTag = projectContext.project.dTag || projectContext.project.tagValue("d");

    let removedCount = 0;

    for (const projectDTag of projects) {
        // Only process if this is the currently loaded project
        if (projectDTag !== currentProjectDTag) {
            logger.debug("[AgentDeletion] Skipping deletion for non-loaded project", {
                projectDTag,
                currentProject: currentProjectDTag,
            });
            continue;
        }

        // Verify event author matches the project owner
        if (event.pubkey !== projectContext.project.pubkey) {
            logger.warn("[AgentDeletion] Event author does not match project owner, skipping", {
                projectDTag,
                eventAuthor: event.pubkey.substring(0, 12),
                projectOwner: projectContext.project.pubkey.substring(0, 12),
            });
            continue;
        }

        const agent = projectContext.getAgentByPubkey(agentPubkey);
        if (!agent) {
            // Agent may have already been removed — handle gracefully
            logger.debug("[AgentDeletion] Agent already absent from project registry", {
                agentPubkey: agentPubkey.substring(0, 12),
                projectDTag,
            });
            continue;
        }

        const removed = await projectContext.agentRegistry.removeAgentFromProject(agent.slug);
        if (removed) {
            removedCount++;
            scheduleProjectEventUpdate(projectDTag, event.pubkey, agentPubkey);
        }
    }

    if (removedCount > 0) {
        logger.info("[AgentDeletion] Global deletion complete", {
            agentPubkey: agentPubkey.substring(0, 12),
            projectsAffected: removedCount,
            totalProjects: projects.length,
            reason: event.content || undefined,
        });

        trace.getActiveSpan()?.addEvent("agent_deletion.global_complete", {
            "deletion.agent_pubkey": agentPubkey.substring(0, 12),
            "deletion.projects_affected": removedCount,
            "deletion.total_projects": projects.length,
        });

        // Publish updated project status if available
        if (projectContext.statusPublisher) {
            await projectContext.statusPublisher.publishImmediately();
        }
    }
}

/**
 * Schedule a debounced NIP-46-signed 31933 project event update.
 *
 * After local state is updated, we must publish an updated 31933 event
 * with the deleted agent's tag removed. Without this, a daemon restart
 * would reload agents from the stale 31933 event on relays.
 *
 * Debouncing batches rapid deletions into a single publish per project.
 */
function scheduleProjectEventUpdate(
    projectDTag: string,
    ownerPubkey: string,
    _removedAgentPubkey: string,
): void {
    const existing = projectUpdateTimers.get(projectDTag);
    if (existing) {
        clearTimeout(existing);
    }

    const timer = setTimeout(() => {
        projectUpdateTimers.delete(projectDTag);
        publishUpdatedProjectEvent(projectDTag, ownerPubkey).catch((error) => {
            logger.warn("[AgentDeletion] Debounced 31933 update failed", {
                projectDTag,
                error: error instanceof Error ? error.message : String(error),
            });
        });
    }, DEBOUNCE_MS);

    projectUpdateTimers.set(projectDTag, timer);
}

/**
 * Publish an updated kind 31933 project event with deleted agent tags removed.
 *
 * Follows the NIP-46 signing pattern from OwnerAgentListService:
 * 1. Build updated event from current project state
 * 2. Sign via NIP-46 if enabled
 * 3. Publish to relays
 */
async function publishUpdatedProjectEvent(
    projectDTag: string,
    ownerPubkey: string,
): Promise<void> {
    const projectContext = getProjectContext();
    const currentProject = projectContext.project;
    const currentProjectDTag = currentProject.dTag || currentProject.tagValue("d");

    if (currentProjectDTag !== projectDTag) {
        logger.debug("[AgentDeletion] Project no longer loaded, skipping 31933 update", {
            projectDTag,
        });
        return;
    }

    // Get current agents in registry (post-deletion)
    const currentAgents = projectContext.agentRegistry.getAllAgents();
    const currentAgentEventIds = new Set(
        currentAgents
            .map((a) => a.eventId)
            .filter((id): id is string => !!id)
    );

    // Rebuild the project event tags, filtering out removed agent tags
    const updatedTags = currentProject.tags.filter((tag) => {
        if (tag[0] === "agent") {
            // Keep only agent tags that reference agents still in the registry
            return tag[1] && currentAgentEventIds.has(tag[1]);
        }
        return true;
    });

    // Build the updated 31933 event
    const ndk = getNDK();
    const updatedEvent = new NDKEventClass(ndk, {
        kind: 31933,
        content: currentProject.content,
        tags: updatedTags,
    });

    const nip46Service = Nip46SigningService.getInstance();

    if (nip46Service.isEnabled()) {
        const signingLog = Nip46SigningLog.getInstance();
        const result = await nip46Service.signEvent(ownerPubkey, updatedEvent, "agent_deletion_31933");

        if (result.outcome === "signed") {
            try {
                await updatedEvent.publish();
                signingLog.log({
                    op: "event_published",
                    ownerPubkey: Nip46SigningLog.truncatePubkey(ownerPubkey),
                    eventKind: 31933,
                    signerType: "nip46",
                    eventId: updatedEvent.id,
                });
                logger.info("[AgentDeletion] Published owner-signed 31933 update", {
                    ownerPubkey: ownerPubkey.substring(0, 12),
                    projectDTag,
                    eventId: updatedEvent.id?.substring(0, 12),
                    agentTagCount: updatedTags.filter((t) => t[0] === "agent").length,
                });
            } catch (error) {
                logger.warn("[AgentDeletion] Failed to publish 31933 update", {
                    ownerPubkey: ownerPubkey.substring(0, 12),
                    projectDTag,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
            return;
        }

        logger.warn("[AgentDeletion] Skipping 31933 publish — signing failed", {
            ownerPubkey: ownerPubkey.substring(0, 12),
            projectDTag,
            outcome: result.outcome,
            reason: "reason" in result ? result.reason : undefined,
        });
    } else {
        logger.warn("[AgentDeletion] NIP-46 not enabled — 31933 update skipped", {
            projectDTag,
            note: "Stale 31933 on relays will re-introduce deleted agents on daemon restart",
        });
    }
}
