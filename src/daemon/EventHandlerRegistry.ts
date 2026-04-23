import { logger } from "@/utils/logger";
import { shortenEventId, shortenOptionalEventId } from "@/utils/conversation-id";
import { agentStorage } from "@/agents/AgentStorage";
import { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { getNDK } from "@/nostr/ndkClient";
import { AgentConfigUpdateService } from "@/services/agents";
import { shouldTrustLesson } from "@/utils/lessonTrust";
import { createProjectDTag, type ProjectDTag } from "@/types/project-ids";
import type { AgentInstance } from "@/agents/types";
import type { Hexpubkey, NDKEvent } from "@nostr-dev-kit/ndk";
import { NDKProject } from "@nostr-dev-kit/ndk";
import { trace } from "@opentelemetry/api";
import type NDK from "@nostr-dev-kit/ndk";
import type { RuntimeLifecycle } from "./RuntimeLifecycle";
import type { SubscriptionSyncCoordinator } from "./SubscriptionSyncCoordinator";

const lessonTracer = trace.getTracer("tenex.lessons");

export interface EventHandlerRegistryDeps {
    getNdk: () => NDK | null;
    getBackendPubkey: () => Hexpubkey | null;
    getWhitelistedPubkeys: () => Hexpubkey[];
    getKnownProjects: () => Map<ProjectDTag, NDKProject>;
    getAutoBootPatterns: () => string[];
    getRuntimeLifecycle: () => RuntimeLifecycle | null;
    getSubscriptionSyncCoordinator: () => SubscriptionSyncCoordinator;
    buildProjectAddressesForSubscription: () => string[];
    updateKnownProjectsSubscription: (addresses: string[]) => void;
    onAutoBootStarted: () => void;
    onAutoBootFinished: () => void;
    getPendingRestartBootProjects: () => Set<ProjectDTag>;
    killRuntime: (projectId: ProjectDTag) => Promise<void>;
}

/**
 * Handles discrete event types received by the daemon.
 *
 * Responsibilities:
 * - handleProjectEvent: kind:31933 — project discovery, auto-boot, runtime wiring
 * - handleLessonEvent: kind:4129 — hydrate lessons into active runtimes
 * - handleLessonCommentEvent: kind:1111 with K:4129 — hydrate comments into runtimes
 * - handleGlobalAgentConfigUpdate: kind:24020 without a-tag — global agent config
 */
export class EventHandlerRegistry {
    private readonly agentConfigUpdateService = new AgentConfigUpdateService();

    constructor(private readonly deps: EventHandlerRegistryDeps) {}

    /**
     * Extract project d-tag from a project event.
     */
    buildProjectId(event: NDKEvent): ProjectDTag {
        const dTag = event.tags.find((t) => t[0] === "d")?.[1];
        if (!dTag) {
            throw new Error("Project event missing d tag");
        }
        return createProjectDTag(dTag);
    }

    /**
     * Handle project creation/update events (kind:31933)
     */
    async handleProjectEvent(event: NDKEvent): Promise<void> {
        const projectId = this.buildProjectId(event);
        const knownProjects = this.deps.getKnownProjects();

        const isDeleted = event.tags.some((tag: string[]) => tag[0] === "deleted");
        if (isDeleted) {
            if (knownProjects.has(projectId)) {
                knownProjects.delete(projectId);
                this.deps.getPendingRestartBootProjects().delete(projectId);

                const runtimeLifecycle = this.deps.getRuntimeLifecycle();
                if (runtimeLifecycle?.getRuntime(projectId)) {
                    try {
                        await this.deps.killRuntime(projectId);
                    } catch (error) {
                        logger.error("Failed to stop runtime for deleted project", {
                            projectId,
                            error: error instanceof Error ? error.message : String(error),
                        });
                    }
                }

                this.deps.updateKnownProjectsSubscription(
                    this.deps.buildProjectAddressesForSubscription()
                );
            }

            logger.info("Ignored deleted project event", { projectId });
            return;
        }

        const project = new NDKProject(getNDK(), event.rawEvent());
        const isNewProject = !knownProjects.has(projectId);

        knownProjects.set(projectId, project);

        // Update subscription for new projects
        if (isNewProject) {
            this.deps.updateKnownProjectsSubscription(
                this.deps.buildProjectAddressesForSubscription()
            );
        }

        const runtimeLifecycle = this.deps.getRuntimeLifecycle();
        const subscriptionSync = this.deps.getSubscriptionSyncCoordinator();

        // Route to active runtime if exists
        let runtime = runtimeLifecycle?.getRuntime(projectId);
        if (runtime) {
            await runtime.handleEvent(event);
            await subscriptionSync.updateSubscriptionWithProjectAgents(projectId, runtime);
        }

        // Auto-boot newly discovered projects that match boot patterns
        const autoBootPatterns = this.deps.getAutoBootPatterns();
        if (isNewProject && !runtime && autoBootPatterns.length > 0) {
            const dTag = event.tags.find((t) => t[0] === "d")?.[1] || "";
            const matchingPattern = autoBootPatterns.find((pattern) =>
                dTag.toLowerCase().includes(pattern.toLowerCase())
            );

            if (matchingPattern && runtimeLifecycle) {
                const projectTitle = project.tagValue("title") || dTag;
                logger.info("Auto-booting project matching pattern", {
                    projectId,
                    projectTitle,
                    dTag,
                    matchedPattern: matchingPattern,
                });

                this.deps.onAutoBootStarted();
                try {
                    runtime = await runtimeLifecycle.startRuntime(projectId, project);
                    await subscriptionSync.updateSubscriptionWithProjectAgents(projectId, runtime);
                    // Clear any pending restart boot entry since we've successfully started
                    this.deps.getPendingRestartBootProjects().delete(projectId);
                    logger.info("Auto-booted project successfully", { projectId, projectTitle });
                } catch (error) {
                    logger.error("Failed to auto-boot project", {
                        projectId,
                        projectTitle,
                        error: error instanceof Error ? error.message : String(error),
                    });
                } finally {
                    this.deps.onAutoBootFinished();
                }
            }
        }

        // Auto-boot projects from restart state when they are discovered or retried
        const pendingRestartBootProjects = this.deps.getPendingRestartBootProjects();
        if (!runtime && pendingRestartBootProjects.has(projectId)) {
            if (runtimeLifecycle) {
                const projectTitle =
                    project.tagValue("title") ||
                    event.tags.find((t) => t[0] === "d")?.[1] ||
                    "untitled";
                logger.info("Auto-booting project from restart state (deferred)", {
                    projectId,
                    projectTitle,
                });

                try {
                    runtime = await runtimeLifecycle.startRuntime(projectId, project);
                    await subscriptionSync.updateSubscriptionWithProjectAgents(projectId, runtime);
                    pendingRestartBootProjects.delete(projectId);
                    logger.info("Auto-booted project from restart state (deferred) successfully", {
                        projectId,
                        projectTitle,
                        remainingPending: pendingRestartBootProjects.size,
                    });
                } catch (error) {
                    logger.error("Failed to auto-boot project from restart state (deferred)", {
                        projectId,
                        projectTitle,
                        error: error instanceof Error ? error.message : String(error),
                    });
                    // Remove from pending to avoid repeated failures
                    pendingRestartBootProjects.delete(projectId);
                }
            }
        }
    }

    /**
     * Handle lesson events (kind 4129) - hydrate into active runtimes only.
     * Does NOT start new project runtimes.
     */
    async handleLessonEvent(event: NDKEvent): Promise<void> {
        if (!event.id) {
            throw new Error("[Daemon] Missing lesson event id.");
        }
        if (!event.pubkey) {
            throw new Error("[Daemon] Missing lesson event pubkey.");
        }

        const span = lessonTracer.startSpan("tenex.lesson.received", {
            attributes: {
                "lesson.event_id": shortenEventId(event.id),
                "lesson.publisher": event.pubkey.substring(0, 16),
                "lesson.created_at": event.created_at || 0,
            },
        });

        try {
            const lesson = NDKAgentLesson.from(event);
            span.setAttribute("lesson.title", lesson.title || "untitled");

            // Check if we should trust this lesson
            if (!shouldTrustLesson(lesson, event.pubkey)) {
                span.setAttribute("lesson.rejected", true);
                span.setAttribute("lesson.rejection_reason", "trust_check_failed");
                span.end();
                return;
            }

            const agentDefinitionId = lesson.agentDefinitionId;
            const lessonAuthorPubkey = event.pubkey;
            span.setAttribute(
                "lesson.agent_definition_id",
                agentDefinitionId ? shortenEventId(agentDefinitionId) : "none"
            );
            span.setAttribute("lesson.author_pubkey", lessonAuthorPubkey.substring(0, 16));

            // Hydrate lesson into ACTIVE runtimes only (don't start new ones)
            const runtimeLifecycle = this.deps.getRuntimeLifecycle();
            const activeRuntimes = runtimeLifecycle?.getActiveRuntimes() || new Map();
            span.setAttribute("lesson.active_runtimes_count", activeRuntimes.size);

            let totalMatches = 0;
            let totalAgentsChecked = 0;

            for (const [projectId, runtime] of activeRuntimes) {
                try {
                    const context = runtime.getContext();
                    if (!context) {
                        continue;
                    }

                    const allAgents = context.agentRegistry.getAllAgents();
                    totalAgentsChecked += allAgents.length;

                    // Match agents by EITHER:
                    // 1. Author pubkey (the agent published this lesson)
                    // 2. Definition eventId (lesson references agent's definition via e-tag)
                    const matchingAgents = allAgents.filter((agent: AgentInstance) => {
                        if (agent.pubkey === lessonAuthorPubkey) {
                            return true;
                        }
                        if (agentDefinitionId && agent.eventId === agentDefinitionId) {
                            return true;
                        }
                        return false;
                    });

                    if (matchingAgents.length === 0) {
                        const agentInfo = allAgents.map((a: AgentInstance) => ({
                            slug: a.slug,
                            pubkey: a.pubkey.substring(0, 16),
                            eventId: a.eventId ? shortenEventId(a.eventId) : "none",
                        }));
                        span.addEvent("no_matching_agents_in_project", {
                            "project.id": projectId,
                            "project.agent_count": allAgents.length,
                            "project.agents": JSON.stringify(agentInfo),
                            "lesson.agent_definition_id":
                                agentDefinitionId ? shortenEventId(agentDefinitionId) : "none",
                            "lesson.author_pubkey": lessonAuthorPubkey.substring(0, 16),
                        });
                        continue;
                    }

                    // Store the lesson for each matching agent
                    for (const agent of matchingAgents) {
                        const matchedByAuthor = agent.pubkey === lessonAuthorPubkey;
                        const matchedByEventId =
                            agentDefinitionId && agent.eventId === agentDefinitionId;
                        const matchReason =
                            matchedByAuthor && matchedByEventId
                                ? "author_and_event_id"
                                : matchedByAuthor
                                    ? "author_pubkey"
                                    : "event_id";

                        context.addLesson(agent.pubkey, lesson);
                        totalMatches++;
                        span.addEvent("lesson_stored", {
                            "agent.slug": agent.slug,
                            "agent.pubkey": agent.pubkey.substring(0, 16),
                            "project.id": projectId,
                            "lesson.title": lesson.title || "untitled",
                            match_reason: matchReason,
                        });
                        logger.info("Stored lesson for agent", {
                            agentSlug: agent.slug,
                            lessonTitle: lesson.title,
                            lessonId: shortenOptionalEventId(event.id),
                            matchReason,
                        });
                    }
                } catch (error) {
                    span.addEvent("hydration_error", {
                        "project.id": projectId,
                        error: error instanceof Error ? error.message : String(error),
                    });
                    logger.error("Failed to hydrate lesson into project", {
                        projectId,
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }

            span.setAttribute("lesson.total_agents_checked", totalAgentsChecked);
            span.setAttribute("lesson.total_matches", totalMatches);
            span.setAttribute("lesson.stored", totalMatches > 0);
            span.end();
        } catch (error) {
            span.setAttribute("error", true);
            span.setAttribute(
                "error.message",
                error instanceof Error ? error.message : String(error)
            );
            span.end();
            throw error;
        }
    }

    /**
     * Handle lesson comment events (kind 1111 with #K: ["4129"])
     * Hydrates comments into the active runtime contexts for background recompilation.
     */
    async handleLessonCommentEvent(event: NDKEvent): Promise<void> {
        if (!event.id) {
            throw new Error("[Daemon] Missing lesson comment event id.");
        }
        if (!event.pubkey) {
            throw new Error("[Daemon] Missing lesson comment pubkey.");
        }

        const span = lessonTracer.startSpan("tenex.lesson_comment.received", {
            attributes: {
                "comment.event_id": shortenEventId(event.id),
                "comment.author": event.pubkey.substring(0, 16),
                "comment.created_at": event.created_at || 0,
            },
        });

        try {
            // Verify author is whitelisted
            if (!this.deps.getWhitelistedPubkeys().includes(event.pubkey)) {
                span.setAttribute("comment.rejected", true);
                span.setAttribute("comment.rejection_reason", "not_whitelisted");
                span.end();
                return;
            }

            // Extract the lesson event ID from the root 'e' tag (NIP-22)
            const upperETag = event.tags.find((tag) => tag[0] === "E");
            const rootETag = event.tags.find((tag) => tag[0] === "e" && tag[3] === "root");
            const anyETag = event.tags.find((tag) => tag[0] === "e");
            const lessonEventId = upperETag?.[1] || rootETag?.[1] || anyETag?.[1];

            if (!lessonEventId) {
                span.setAttribute("comment.rejected", true);
                span.setAttribute("comment.rejection_reason", "no_lesson_reference");
                span.end();
                return;
            }

            span.setAttribute("comment.lesson_event_id", shortenEventId(lessonEventId));

            // Build the LessonComment object
            const comment = {
                id: event.id || "",
                pubkey: event.pubkey,
                content: event.content,
                lessonEventId,
                createdAt: event.created_at || 0,
            };

            // Route to active runtimes. Use p-tag if available for direct lookup,
            // otherwise scan agents to find those with matching lesson event IDs.
            const agentPubkey = event.tagValue("p");
            const runtimeLifecycle = this.deps.getRuntimeLifecycle();
            const activeRuntimes = runtimeLifecycle?.getActiveRuntimes() || new Map();
            let routedCount = 0;

            for (const [projectId, runtime] of activeRuntimes) {
                const context = runtime.getContext();
                if (!context) continue;

                if (agentPubkey) {
                    // Direct lookup by p-tag
                    const agent = context.getAgentByPubkey(agentPubkey);
                    if (agent) {
                        context.addComment(agentPubkey, comment);
                        routedCount++;
                        logger.debug("Stored lesson comment for agent", {
                            projectId,
                            agentSlug: agent.slug,
                            commentId: shortenOptionalEventId(event.id),
                            lessonEventId: shortenEventId(lessonEventId),
                        });
                    }
                } else {
                    // No p-tag: scan agents for those whose lessons match this event ID
                    for (const agent of context.agentRegistry.getAllAgents()) {
                        const lessons = context.getLessonsForAgent(agent.pubkey);
                        if (lessons.some((l: NDKAgentLesson) => l.id === lessonEventId)) {
                            context.addComment(agent.pubkey, comment);
                            routedCount++;
                            logger.debug("Stored lesson comment for agent (via lesson scan)", {
                                projectId,
                                agentSlug: agent.slug,
                                commentId: shortenOptionalEventId(event.id),
                                lessonEventId: shortenEventId(lessonEventId),
                            });
                        }
                    }
                }
            }

            span.setAttribute("comment.routed_count", routedCount);
            span.end();
        } catch (error) {
            span.setAttribute("error", true);
            span.setAttribute(
                "error.message",
                error instanceof Error ? error.message : String(error)
            );
            span.end();
            throw error;
        }
    }

    /**
     * Handle global agent config updates (kind 24020 without a-tag).
     * Updates agent storage directly and reloads the agent in all running runtimes.
     */
    async handleGlobalAgentConfigUpdate(event: NDKEvent): Promise<void> {
        const agentPubkey = event.tagValue("p");
        if (!agentPubkey) {
            logger.warn("Global agent config update missing p-tag", { eventId: event.id });
            return;
        }

        await agentStorage.initialize();
        const storedAgent = await agentStorage.loadAgent(agentPubkey);
        if (!storedAgent) {
            logger.warn("Agent not found for global config update", {
                agentPubkey: agentPubkey.substring(0, 8),
            });
            return;
        }

        const updateResult = await this.agentConfigUpdateService.applyEvent(event);
        const configUpdated = updateResult.configUpdated || updateResult.pmUpdated;

        if (!configUpdated) {
            logger.info("No config changes for global agent config update", {
                agentSlug: storedAgent.slug,
                agentPubkey: agentPubkey.substring(0, 8),
            });
            return;
        }

        logger.info("Applied global agent config update", {
            agentSlug: storedAgent.slug,
            agentPubkey: agentPubkey.substring(0, 8),
            hasModel: updateResult.hasModel,
            toolCount: updateResult.toolCount,
            skillCount: updateResult.skillCount,
            hasPM: updateResult.hasPM,
        });

        // Reload and status publish now handled by each runtime's AgentConfigWatcher.
        // applyEvent() wrote to disk → watcher detects change → reloadAgent() + publishImmediately().
        logger.debug("Agent config updated on disk, watcher will reload", {
            agentPubkey: agentPubkey.substring(0, 8),
        });
    }

}
