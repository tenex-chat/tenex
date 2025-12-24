import { NDKKind } from "@/nostr/kinds";
import { TagExtractor } from "@/nostr/TagExtractor";
import { formatAnyError } from "@/lib/error-formatter";
import { type NDKEvent, NDKProject } from "@nostr-dev-kit/ndk";
import { agentStorage } from "../agents/AgentStorage";
import { AgentExecutor } from "../agents/execution/AgentExecutor";
import type { ConversationCoordinator } from "../conversations";
import { NDKEventMetadata } from "../events/NDKEventMetadata";
import { getProjectContext } from "@/services/projects";
import { config } from "@/services/ConfigService";
import { llmOpsRegistry } from "../services/LLMOperationsRegistry";
import { logger } from "../utils/logger";
import { handleNewConversation } from "./newConversation";
import { handleProjectEvent } from "./project";
import { handleChatMessage } from "./reply";
import { trace } from "@opentelemetry/api";

const IGNORED_EVENT_KINDS = [
    NDKKind.Metadata,
    NDKKind.Contacts,
    NDKKind.TenexProjectStatus,
    NDKKind.TenexStreamingResponse,
    NDKKind.TenexOperationsStatus,
];

export class EventHandler {
    private agentExecutor!: AgentExecutor;
    private isUpdatingProject = false;

    constructor(
        /**
         * Project directory (normal git repository root).
         * Worktrees are in .worktrees/ subdirectory.
         */
        private projectBasePath: string,
        private conversationCoordinator: ConversationCoordinator
    ) {}

    async initialize(): Promise<void> {
        this.agentExecutor = new AgentExecutor();
    }

    getConversationCoordinator(): ConversationCoordinator {
        return this.conversationCoordinator;
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
            case NDKKind.GenericReply: // kind 1111
                await handleChatMessage(event, {
                    conversationCoordinator: this.conversationCoordinator,
                    agentExecutor: this.agentExecutor,
                });
                break;

            case NDKKind.Thread: // kind 11
                await handleNewConversation(event, {
                    conversationCoordinator: this.conversationCoordinator,
                    agentExecutor: this.agentExecutor,
                    projectBasePath: this.projectBasePath,
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
        if (this.conversationCoordinator.hasConversation(conversationId)) {
            const title = metadata.title;
            if (title) {
                this.conversationCoordinator.setTitle(conversationId, title);
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

            // Check for model configuration change
            const newModel = event.tagValue("model");
            if (newModel) {
                // Update in storage then reload into registry
                const updated = await agentStorage.updateAgentLLMConfig(agentPubkey, newModel);

                if (updated) {
                    // Reload agent to pick up changes
                    await agentRegistry.reloadAgent(agentPubkey);
                } else {
                    logger.warn("Failed to update model configuration", {
                        agentName: agent.slug,
                        agentPubkey: agent.pubkey,
                        newModel,
                    });
                }
            }

            // Check for tools configuration change
            // Extract all tool tags - these represent the exhaustive list of tools the agent should have
            const toolTags = TagExtractor.getToolTags(event);
            if (toolTags.length > 0) {
                // Extract tool names from tags
                const newToolNames = toolTags.map((tool) => tool.name).filter((name) => name);

                // Update in storage then reload into registry
                const updated = await agentStorage.updateAgentTools(agentPubkey, newToolNames);

                if (updated) {
                    // Reload agent to pick up changes
                    await agentRegistry.reloadAgent(agentPubkey);
                } else {
                    logger.warn("Failed to update tools configuration", {
                        agent: agent.slug,
                        reason: "update returned false",
                    });
                }
            }

            // If neither model nor tools were provided, log a warning
            if (!newModel && toolTags.length === 0) {
                logger.warn("AGENT_CONFIG_UPDATE event has neither model nor tool tags", {
                    eventId: event.id,
                    agentPubkey,
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
            const conversation = this.conversationCoordinator.getConversation(conversationId);
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

    private handleDefaultEvent(_event: NDKEvent): void {
        // Unhandled event kinds are ignored silently
    }

    async cleanup(): Promise<void> {
        // Save all conversations before shutting down
        await this.conversationCoordinator.cleanup();
    }

}
