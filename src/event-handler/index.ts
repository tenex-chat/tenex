import { NDKKind } from "@/nostr/kinds";
import { TagExtractor } from "@/nostr/TagExtractor";
import { formatAnyError } from "@/lib/error-formatter";
import { type NDKEvent, NDKProject } from "@nostr-dev-kit/ndk";
import { agentStorage } from "../agents/AgentStorage";
import { AgentExecutor } from "../agents/execution/AgentExecutor";
import { ConversationStore } from "../conversations/ConversationStore";
import { NDKEventMetadata } from "../events/NDKEventMetadata";
import { getProjectContext } from "@/services/projects";
import { config } from "@/services/ConfigService";
import { llmOpsRegistry } from "../services/LLMOperationsRegistry";
import { logger } from "../utils/logger";
import { handleProjectEvent } from "./project";
import { handleChatMessage } from "./reply";
import { trace } from "@opentelemetry/api";

const IGNORED_EVENT_KINDS = [
    NDKKind.Metadata,
    NDKKind.Contacts,
    NDKKind.TenexProjectStatus,
    NDKKind.TenexOperationsStatus,
];

export class EventHandler {
    private agentExecutor!: AgentExecutor;
    private isUpdatingProject = false;

    async initialize(): Promise<void> {
        this.agentExecutor = new AgentExecutor();
    }

    async handleEvent(event: NDKEvent): Promise<void> {
        // Ignore ephemeral status and typing indicator events
        if (IGNORED_EVENT_KINDS.includes(event.kind)) return;

        // EMERGENCY STOP: If a whitelisted pubkey sends "EMERGENCY STOP", exit immediately
        if (event.content === "EMERGENCY STOP") {
            const whitelistedPubkeys = config.getConfig().whitelistedPubkeys ?? [];
            if (whitelistedPubkeys.includes(event.pubkey)) {
                logger.warn("EMERGENCY STOP received from whitelisted pubkey", {
                    pubkey: event.pubkey.substring(0, 8),
                    eventId: event.id,
                });
                process.exit(0);
            }
        }

        // Try to get agent slug if the event is from an agent
        let fromIdentifier = event.pubkey;
        let forIdentifiers = "without any recipient";

        try {
            const projectCtx = getProjectContext();
            const agent = projectCtx.getAgentByPubkey(event.pubkey);
            if (agent) {
                fromIdentifier = agent.slug;
            }

            // Process p-tags to show agent slugs where possible
            let pTags: string[][] = [];
            try {
                pTags = event.getMatchingTags("p");
            } catch (err) {
                logger.error("Failed to get p-tags - event is not a proper NDKEvent!", {
                    error: err,
                    eventType: typeof event,
                    eventConstructor: event?.constructor?.name,
                    eventPrototype: Object.getPrototypeOf(event)?.constructor?.name,
                    eventKeys: Object.keys(event || {}),
                    event: event?.rawEvent ? JSON.stringify(event.rawEvent(), null, 2) : "no rawEvent method",
                });
                throw err;
            }
            if (pTags.length > 0) {
                const recipients = pTags.map((t) => {
                    const pubkey = t[1];
                    const recipientAgent = projectCtx.getAgentByPubkey(pubkey);
                    return recipientAgent ? recipientAgent.slug : pubkey.substring(0, 8);
                });
                forIdentifiers = recipients.join(", ");
            }
        } catch {
            // Project context might not be available, continue with pubkey
            let pTags: string[][] = [];
            try {
                pTags = event.getMatchingTags("p");
            } catch (err) {
                logger.error("Failed to get p-tags (fallback) - event is not a proper NDKEvent!", {
                    error: err,
                    eventType: typeof event,
                    eventConstructor: event?.constructor?.name,
                    eventPrototype: Object.getPrototypeOf(event)?.constructor?.name,
                    hasGetMatchingTags: typeof event?.getMatchingTags,
                    eventKeys: Object.keys(event || {}),
                    event: event?.rawEvent ? JSON.stringify(event.rawEvent(), null, 2) : "no rawEvent method",
                });
                throw err;
            }
            if (pTags.length > 0) {
                forIdentifiers = pTags.map((t) => t[1].substring(0, 8)).join(", ");
            }
        }

        trace.getActiveSpan()?.addEvent("event_handler.received", {
            "event.kind": event.kind,
            "event.id": event.id,
            "event.from": fromIdentifier,
            "event.for": forIdentifiers,
        });

        switch (event.kind) {
            case NDKKind.Text: // kind 1 - unified conversation format
                await handleChatMessage(event, {
                    agentExecutor: this.agentExecutor,
                });
                break;

            case NDKKind.TenexBootProject: // kind 24000 - project boot request
                // Boot already happened by virtue of event routing - nothing to do
                trace.getActiveSpan()?.addEvent("event_handler.boot_request", {
                    "event.id": event.id,
                    "event.author": event.pubkey.substring(0, 8),
                });
                break;

            case NDKProject.kind: // kind 31933
                if (this.isUpdatingProject) {
                    logger.warn("Project update already in progress, skipping event", {
                        eventId: event.id,
                    });
                    return;
                }

                this.isUpdatingProject = true;
                try {
                    await handleProjectEvent(event);
                } finally {
                    this.isUpdatingProject = false;
                }
                break;

            case NDKKind.TenexAgentConfigUpdate:
                await this.handleAgentConfigUpdate(event);
                break;

            case 513: // NDKEventMetadata
                await this.handleMetadataEvent(event);
                break;

            case NDKKind.TenexStopCommand: // Stop LLM operations
                await this.handleStopEvent(event);
                break;

            case NDKKind.AgentLesson:
                await this.handleLessonEvent(event);
                break;

            case 30023: // NDKArticle - Reports
                await this.handleReportEvent(event);
                break;

            default:
                this.handleDefaultEvent(event);
        }
    }

    private async handleMetadataEvent(event: NDKEvent): Promise<void> {
        const metadata = NDKEventMetadata.from(event);
        const conversationId = metadata.conversationId;

        if (!conversationId) {
            logger.error("Metadata event missing conversation ID", event.inspect);
            return;
        }

        // Only update if we know this conversation
        if (ConversationStore.has(conversationId)) {
            const title = metadata.title;
            if (title) {
                ConversationStore.setConversationTitle(conversationId, title);
            }
        }
    }

    private async handleAgentConfigUpdate(event: NDKEvent): Promise<void> {
        try {
            // Extract the agent pubkey from the event tags
            const agentPubkey = event.tagValue("p");
            if (!agentPubkey) {
                logger.warn("AGENT_CONFIG_UPDATE event missing agent pubkey", {
                    eventId: event.id,
                });
                return;
            }

            // Get the agent from the project context
            const projectContext = getProjectContext();
            const agent = projectContext.getAgentByPubkey(agentPubkey);

            if (!agent) {
                logger.warn("Agent not found for config change", {
                    agentPubkey,
                    availableAgents: projectContext.getAgentSlugs(),
                });
                return;
            }

            // Get the agent registry from ProjectContext (single source of truth)
            const agentRegistry = projectContext.agentRegistry;

            // Track if any update was made
            let configUpdated = false;

            // Check for model configuration change
            const newModel = event.tagValue("model");
            if (newModel) {
                // Update in storage then reload into registry
                const updated = await agentStorage.updateAgentLLMConfig(agentPubkey, newModel);

                if (updated) {
                    // Reload agent to pick up changes
                    await agentRegistry.reloadAgent(agentPubkey);
                    configUpdated = true;
                } else {
                    logger.warn("Failed to update model configuration", {
                        agentName: agent.slug,
                        agentPubkey: agent.pubkey,
                        newModel,
                    });
                }
            }

            // Update tools configuration
            // Extract all tool tags - these represent the exhaustive list of tools the agent should have
            // Empty list means agent should have no tools (beyond core/delegate tools added during normalization)
            const toolTags = TagExtractor.getToolTags(event);
            const newToolNames = toolTags.map((tool) => tool.name).filter((name) => name);

            const toolsUpdated = await agentStorage.updateAgentTools(agentPubkey, newToolNames);

            if (toolsUpdated) {
                await agentRegistry.reloadAgent(agentPubkey);
                configUpdated = true;
            } else {
                logger.warn("Failed to update tools configuration", {
                    agent: agent.slug,
                    reason: "update returned false",
                });
            }

            // Immediately publish updated project status if config was changed
            if (configUpdated && projectContext.statusPublisher) {
                await projectContext.statusPublisher.publishImmediately();
                logger.info("Published updated project status after agent config change", {
                    agentSlug: agent.slug,
                    agentPubkey: agentPubkey.substring(0, 8),
                });
            }
        } catch (error) {
            logger.error("Failed to handle config change", {
                eventId: event.id,
                error: formatAnyError(error),
            });
        }
    }

    private async handleStopEvent(event: NDKEvent): Promise<void> {
        const eTags = event.getMatchingTags("e");
        const pTags = event.getMatchingTags("p");

        if (eTags.length === 0) {
            logger.warn("[EventHandler] Stop event received with no e-tags", {
                eventId: event.id?.substring(0, 8),
            });
            return;
        }

        let totalStopped = 0;
        let agentsBlocked = 0;
        let ralsAborted = 0;

        // Import RALRegistry and AgentRouter dynamically to avoid circular dependencies
        const { RALRegistry } = await import("../services/ral");
        const { AgentRouter } = await import("./AgentRouter");
        const projectCtx = getProjectContext();

        // For each e-tag (conversation ID), block the p-tagged agents
        for (const [, conversationId] of eTags) {
            // Stop LLM operations (existing behavior)
            const stopped = llmOpsRegistry.stopByEventId(conversationId);
            totalStopped += stopped;

            // Get the conversation
            const conversation = ConversationStore.get(conversationId);
            if (!conversation) {
                continue;
            }

            // Block each p-tagged agent in this conversation
            for (const [, agentPubkey] of pTags) {
                const agent = projectCtx.getAgentByPubkey(agentPubkey);
                if (agent) {
                    // Block the agent
                    AgentRouter.processStopSignal(event, conversation, projectCtx);
                    agentsBlocked++;

                    // Abort all running RALs for this agent
                    const ralRegistry = RALRegistry.getInstance();
                    const aborted = ralRegistry.abortAllForAgent(agentPubkey, conversationId);
                    ralsAborted += aborted;

                    logger.info(`[EventHandler] Stopped agent ${agent.slug} in conversation ${conversationId.substring(0, 8)}`, {
                        ralsAborted: aborted,
                    });
                }
            }
        }

        trace.getActiveSpan()?.addEvent("event_handler.stop_operations", {
            "operations.stopped": totalStopped,
            "operations.remaining": llmOpsRegistry.getActiveOperationsCount(),
            "agents.blocked": agentsBlocked,
            "rals.aborted": ralsAborted,
        });
    }

    private async handleLessonEvent(event: NDKEvent): Promise<void> {
        const { NDKAgentLesson } = await import("@/events/NDKAgentLesson");
        const { shouldTrustLesson } = await import("@/utils/lessonTrust");

        const lesson = NDKAgentLesson.from(event);

        // Check if we should trust this lesson
        if (!shouldTrustLesson(lesson, event.pubkey)) {
            return;
        }

        const agentDefinitionId = lesson.agentDefinitionId;

        if (!agentDefinitionId) {
            logger.warn("Lesson event missing agent definition ID (e-tag)", {
                eventId: event.id?.substring(0, 8),
                publisher: event.pubkey.substring(0, 8),
            });
            return;
        }

        try {
            const projectCtx = getProjectContext();

            // Find the agent(s) that match this definition ID
            const agents = Array.from(projectCtx.agents.values()).filter(
                (agent) => agent.eventId === agentDefinitionId
            );

            if (agents.length === 0) {
                return;
            }

            // Store the lesson for each matching agent
            for (const agent of agents) {
                projectCtx.addLesson(agent.pubkey, lesson);
            }
        } catch (error) {
            logger.error("Failed to handle lesson event", {
                eventId: event.id,
                error: formatAnyError(error),
            });
        }
    }

    private async handleReportEvent(event: NDKEvent): Promise<void> {
        const { NDKArticle } = await import("@nostr-dev-kit/ndk");

        try {
            const projectCtx = getProjectContext();

            // Verify this report belongs to our project by checking a-tag
            const projectTagId = projectCtx.project.tagId();
            const reportProjectTag = event.tags.find(
                (tag: string[]) => tag[0] === "a" && tag[1] === projectTagId
            );

            if (!reportProjectTag) {
                // Report doesn't belong to our project, ignore
                return;
            }

            // Convert to NDKArticle
            const article = NDKArticle.from(event);

            // Add to project context cache
            projectCtx.addReportFromArticle(article);

            trace.getActiveSpan()?.addEvent("event_handler.report_cached", {
                "report.slug": article.dTag || "",
                "report.author": event.pubkey.substring(0, 8),
                "report.isDeleted": article.tags.some((tag: string[]) => tag[0] === "deleted"),
                "report.isMemorized": article.tags.some(
                    (tag: string[]) => tag[0] === "t" && tag[1] === "memorize"
                ),
            });
        } catch (error) {
            logger.error("Failed to handle report event", {
                eventId: event.id,
                error: formatAnyError(error),
            });
        }
    }

    private handleDefaultEvent(_event: NDKEvent): void {
        // Unhandled event kinds are ignored silently
    }

    async cleanup(): Promise<void> {
        // Save all conversations before shutting down
        await ConversationStore.cleanup();
    }

}
