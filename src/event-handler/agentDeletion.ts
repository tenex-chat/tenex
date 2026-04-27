import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { config } from "@/services/ConfigService";
import { getProjectContext, projectEventPublishService } from "@/services/projects";
import { agentStorage } from "@/agents/AgentStorage";
import { formatAnyError } from "@/lib/error-formatter";
import { logger } from "@/utils/logger";
import { trace } from "@opentelemetry/api";
import { shortenOptionalEventId, shortenPubkey } from "@/utils/conversation-id";

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
 * Deletes the agent from storage globally. Project membership is managed
 * exclusively via 31933 p-tags — removing an agent from a project means
 * publishing an updated 31933 without that agent's pubkey.
 */
export async function handleAgentDeletion(event: NDKEvent): Promise<void> {
    try {
        const agentPubkey = event.tagValue("p");
        if (!agentPubkey) {
            logger.warn("[AgentDeletion] Event missing required p tag (agent pubkey)", {
                eventId: shortenOptionalEventId(event.id),
            });
            return;
        }

        const whitelistedPubkeys = config.getWhitelistedPubkeys();
        if (!whitelistedPubkeys.includes(event.pubkey)) {
            logger.warn("[AgentDeletion] Unauthorized — event author not whitelisted", {
                eventId: shortenOptionalEventId(event.id),
                author: shortenPubkey(event.pubkey),
            });
            return;
        }

        trace.getActiveSpan()?.addEvent("agent_deletion.received", {
            "deletion.agent_pubkey": shortenPubkey(agentPubkey),
            "deletion.author": shortenPubkey(event.pubkey),
        });

        await handleGlobalDeletion(event, agentPubkey);
    } catch (error) {
        logger.error("[AgentDeletion] Failed to handle agent deletion event", {
            eventId: shortenOptionalEventId(event.id),
            error: formatAnyError(error),
        });
    }
}

async function handleGlobalDeletion(
    event: NDKEvent,
    agentPubkey: string,
): Promise<void> {
    const projects = await agentStorage.getAgentProjects(agentPubkey);

    if (projects.length === 0) {
        logger.warn("[AgentDeletion] Agent has no project associations, no-op", {
            agentPubkey: shortenPubkey(agentPubkey),
        });
        return;
    }

    const projectContext = getProjectContext();
    const currentProjectDTag = projectContext.project.dTag || projectContext.project.tagValue("d");

    let removedCount = 0;

    for (const projectDTag of projects) {
        if (projectDTag !== currentProjectDTag) {
            logger.debug("[AgentDeletion] Skipping deletion for non-loaded project", {
                projectDTag,
                currentProject: currentProjectDTag,
            });
            continue;
        }

        if (event.pubkey !== projectContext.project.pubkey) {
            logger.warn("[AgentDeletion] Event author does not match project owner, skipping", {
                projectDTag,
                eventAuthor: shortenPubkey(event.pubkey),
                projectOwner: shortenPubkey(projectContext.project.pubkey),
            });
            continue;
        }

        const agent = projectContext.getAgentByPubkey(agentPubkey);
        if (!agent) {
            logger.debug("[AgentDeletion] Agent already absent from project registry", {
                agentPubkey: shortenPubkey(agentPubkey),
                projectDTag,
            });
            continue;
        }

        const removed = await projectContext.agentRegistry.removeAgentFromProject(agent.slug);
        if (removed) {
            removedCount++;
            scheduleProjectEventUpdate(projectDTag, event.pubkey);
        }
    }

    if (removedCount > 0) {
        logger.info("[AgentDeletion] Deletion complete", {
            agentPubkey: shortenPubkey(agentPubkey),
            projectsAffected: removedCount,
            totalProjects: projects.length,
            reason: event.content || undefined,
        });

        trace.getActiveSpan()?.addEvent("agent_deletion.complete", {
            "deletion.agent_pubkey": shortenPubkey(agentPubkey),
            "deletion.projects_affected": removedCount,
            "deletion.total_projects": projects.length,
        });

        if (projectContext.statusPublisher) {
            await projectContext.statusPublisher.publishImmediately();
        }
    }
}

function scheduleProjectEventUpdate(
    projectDTag: string,
    ownerPubkey: string,
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

    const currentAgentPubkeys = projectContext.agentRegistry
        .getAllAgents()
        .map((agent) => agent.pubkey);

    const result = await projectEventPublishService.publishMutation({
        ownerPubkey,
        projectDTag,
        trigger: "agent_deletion_31933",
        retainAgentPubkeys: currentAgentPubkeys,
    });

    if (result.outcome !== "published" && result.outcome !== "no_changes") {
        logger.warn("[AgentDeletion] Skipping 31933 publish — update failed", {
            ownerPubkey: shortenPubkey(ownerPubkey),
            projectDTag,
            outcome: result.outcome,
            reason: result.reason,
        });
    }
}
