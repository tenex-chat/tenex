import { NDKKind } from "@/nostr/kinds";
import { TagExtractor } from "@/nostr/TagExtractor";
import { formatAnyError } from "@/lib/error-formatter";
import { type NDKEvent, NDKArticle, NDKProject } from "@nostr-dev-kit/ndk";
import { agentStorage } from "../agents/AgentStorage";
import { AgentExecutor } from "../agents/execution/AgentExecutor";
import { ConversationStore } from "../conversations/ConversationStore";
import { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { NDKEventMetadata } from "../events/NDKEventMetadata";
import { getProjectContext } from "@/services/projects";
import { getLocalReportStore } from "@/services/reports";
import { config } from "@/services/ConfigService";
import { RALRegistry } from "@/services/ral";
import { prefixKVStore } from "@/services/storage";
import { llmOpsRegistry } from "../services/LLMOperationsRegistry";
import { logger } from "../utils/logger";
import { shortenConversationId } from "@/utils/conversation-id";
import { shouldTrustLesson } from "@/utils/lessonTrust";
import { handleProjectEvent } from "./project";
import { handleChatMessage } from "./reply";
import { AgentRouter } from "@/services/dispatch/AgentRouter";
import { trace, context as otelContext, TraceFlags } from "@opentelemetry/api";

/**
 * Index event ID and pubkey into the prefix KV store.
 * Skips ephemeral events (kinds 20000-29999) since their IDs are transient.
 *
 * This is a best-effort operation - indexing failures are logged but do NOT
 * abort event handling. The prefix index is a convenience feature, not critical.
 */
async function indexEventForPrefixLookup(event: NDKEvent): Promise<void> {
    const kind = event.kind ?? 0;

    // Skip ephemeral events (kinds 20000-29999)
    if (kind >= 20000 && kind < 30000) {
        return;
    }

    // Index both event ID and pubkey - best effort, don't let failures bubble up
    if (prefixKVStore.isInitialized()) {
        try {
            await prefixKVStore.addBatch([event.id, event.pubkey]);
        } catch (error) {
            // Log but don't abort - indexing is a sidecar feature
            logger.warn("[EventHandler] Failed to index event for prefix lookup", {
                eventId: event.id?.substring(0, 12),
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
}

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

        // Index event ID and pubkey for prefix lookups
        await indexEventForPrefixLookup(event);

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
            let pTags: string[][];
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
            // Collect metadata updates from tags
            const updates: Record<string, string | undefined> = {};

            const title = metadata.title;
            if (title) {
                updates.title = title;
            }

            // Parse summary tag
            const summaryTag = event.tags.find((tag: string[]) => tag[0] === "summary");
            if (summaryTag && summaryTag[1]) {
                updates.summary = summaryTag[1];
            }

            // Parse status-label tag
            const statusLabelTag = event.tags.find((tag: string[]) => tag[0] === "status-label");
            if (statusLabelTag && statusLabelTag[1]) {
                updates.statusLabel = statusLabelTag[1];
            }

            // Parse status-current-activity tag
            const statusActivityTag = event.tags.find((tag: string[]) => tag[0] === "status-current-activity");
            if (statusActivityTag && statusActivityTag[1]) {
                updates.statusCurrentActivity = statusActivityTag[1];
            }

            // Apply all updates at once
            if (Object.keys(updates).length > 0) {
                await ConversationStore.updateConversationMetadata(conversationId, updates);
                logger.debug("Updated conversation metadata", {
                    conversationId: conversationId.substring(0, 8),
                    updates: Object.keys(updates),
                });
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

            // Get the project context early - needed for a-tag validation and agent lookup
            const projectContext = getProjectContext();

            // Extract the project a-tag if present
            // Format: ["a", "31990:<pubkey>:<d-tag>"] or just the d-tag portion
            // When present, config is scoped to that project only
            const aTag = event.tagValue("a");
            let projectDTag: string | undefined;
            if (aTag) {
                // Parse the a-tag - format is "kind:pubkey:d-tag"
                const parts = aTag.split(":");
                if (parts.length >= 3) {
                    // The d-tag is the third part (and may contain colons)
                    projectDTag = parts.slice(2).join(":");
                } else {
                    // If not in standard format, treat the whole value as d-tag
                    projectDTag = aTag;
                }

                // Validate that the a-tag matches the current project
                // This prevents config updates meant for other projects from being applied here
                const currentProjectDTag = projectContext.project.dTag || projectContext.project.tagValue("d");
                if (projectDTag !== currentProjectDTag) {
                    logger.debug("Ignoring project-scoped config update for different project", {
                        eventId: event.id,
                        targetProject: projectDTag,
                        currentProject: currentProjectDTag,
                    });
                    return;
                }
            }

            const isProjectScoped = projectDTag !== undefined;
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

            // Extract configuration values from the event
            const newModel = event.tagValue("model");
            const toolTags = TagExtractor.getToolTags(event);
            const newToolNames = toolTags.map((tool) => tool.name).filter((name) => name);
            const hasPMTag = event.tags.some((tag) => tag[0] === "pm");

            if (isProjectScoped) {
                // PROJECT-SCOPED CONFIG UPDATE
                // Store in projectConfigs[projectDTag] instead of global fields
                logger.info("Processing project-scoped agent config update", {
                    agentSlug: agent.slug,
                    projectDTag,
                    hasModel: !!newModel,
                    toolCount: newToolNames.length,
                    hasPM: hasPMTag,
                });

                // Build the project-scoped config
                // Kind 24020 events are authoritative snapshots - we replace the entire project config
                const projectConfig: import("@/agents/types").ProjectScopedConfig = {};

                if (newModel) {
                    projectConfig.llmConfig = newModel;
                }

                // Only set tools if there are actual tool tags
                // Empty/missing tool tags means fall back to global tools (undefined)
                if (newToolNames.length > 0) {
                    projectConfig.tools = newToolNames;
                }

                if (hasPMTag) {
                    projectConfig.isPM = true;
                }

                // Update the project-scoped config (this replaces the entire project config)
                const updated = await agentStorage.updateProjectScopedConfig(
                    agentPubkey,
                    projectDTag!,
                    projectConfig
                );

                if (updated) {
                    await agentRegistry.reloadAgent(agentPubkey);
                    configUpdated = true;
                    logger.info("Updated project-scoped config for agent", {
                        agentSlug: agent.slug,
                        projectDTag,
                        config: projectConfig,
                    });
                }
            } else {
                // GLOBAL CONFIG UPDATE (backward compatible behavior)
                // Check for model configuration change
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

                // Check for PM designation tag: ["pm"] (no value, just the tag itself)
                // Kind 24020 events are authoritative snapshots - presence of ["pm"] tag sets isPM=true,
                // absence clears it (sets isPM=false). This matches how tools are handled (replace entirely).
                const pmUpdated = await agentStorage.updateAgentIsPM(agentPubkey, hasPMTag);

                if (pmUpdated) {
                    await agentRegistry.reloadAgent(agentPubkey);
                    configUpdated = true;
                    logger.info(hasPMTag ? "Set PM designation for agent via kind 24020 event" : "Cleared PM designation for agent via kind 24020 event", {
                        agentSlug: agent.slug,
                        agentPubkey: agentPubkey.substring(0, 8),
                    });
                } else {
                    logger.warn("Failed to update PM designation", {
                        agentSlug: agent.slug,
                        agentPubkey: agentPubkey.substring(0, 8),
                        newValue: hasPMTag,
                    });
                }
            }

            // Immediately publish updated project status if config was changed
            if (configUpdated && projectContext.statusPublisher) {
                await projectContext.statusPublisher.publishImmediately();
                logger.info("Published updated project status after agent config change", {
                    agentSlug: agent.slug,
                    agentPubkey: agentPubkey.substring(0, 8),
                    projectScoped: isProjectScoped,
                    projectDTag,
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

        const projectCtx = getProjectContext();
        const stopTracer = trace.getTracer("tenex.event-handler");

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

                    // Get the RAL's trace context to parent the stop span under agent execution
                    const ralRegistry = RALRegistry.getInstance();
                    const activeRals = ralRegistry.getActiveRALs(agentPubkey, conversationId);
                    const targetRal = activeRals[0];

                    console.log(`[STOP] RAL trace context: activeRals=${activeRals.length} traceId=${targetRal?.traceId?.substring(0, 8)} spanId=${targetRal?.executionSpanId?.substring(0, 8)}`);

                    // Build parent context from stored trace info
                    let parentContext = otelContext.active();
                    if (targetRal?.traceId && targetRal?.executionSpanId) {
                        // Create a parent span context from the stored trace info
                        const parentSpanContext = {
                            traceId: targetRal.traceId,
                            spanId: targetRal.executionSpanId,
                            traceFlags: TraceFlags.SAMPLED,
                            isRemote: false,
                        };
                        parentContext = trace.setSpanContext(otelContext.active(), parentSpanContext);
                    }

                    // Create a span for the stop - parented under the agent execution
                    const stopSpan = stopTracer.startSpan(
                        "tenex.stop_command",
                        {
                            attributes: {
                                "event.id": event.id,
                                "event.kind": event.kind,
                                "event.author": event.pubkey.substring(0, 8),
                                "stop.agent_slug": agent.slug,
                                "stop.agent_pubkey": agentPubkey.substring(0, 8),
                                "stop.conversation_id": shortenConversationId(conversationId),
                                "stop.active_rals": activeRals.length,
                            },
                        },
                        parentContext
                    );

                    // Abort all running RALs for this agent
                    const aborted = ralRegistry.abortAllForAgent(agentPubkey, conversationId);
                    ralsAborted += aborted;

                    stopSpan.setAttribute("stop.rals_aborted", aborted);
                    stopSpan.end();

                    const stopSpanContext = stopSpan.spanContext();
                    console.log(`[STOP] Created span: traceId=${stopSpanContext.traceId?.substring(0, 8)} spanId=${stopSpanContext.spanId?.substring(0, 8)} parent=${targetRal?.executionSpanId?.substring(0, 8) || "none"}`);

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

            // Check if report is deleted
            const isDeleted = article.tags.some((tag: string[]) => tag[0] === "deleted");

            // Add to project context cache
            projectCtx.addReportFromArticle(article);

            // Hydrate local storage if this event is newer than local copy
            // Skip deleted reports - we don't want to hydrate them
            if (!isDeleted && article.dTag && article.content) {
                const localStore = getLocalReportStore();
                const eventCreatedAt = event.created_at || Math.floor(Date.now() / 1000);

                // Format content for local storage (matching report_write format)
                const formattedContent = this.formatReportForLocalStorage(article);

                // Construct addressable reference in NIP-33 format: kind:pubkey:d-tag
                const addressableRef = `${event.kind}:${event.pubkey}:${article.dTag}`;

                const hydrated = await localStore.hydrateFromNostr(
                    article.dTag,
                    formattedContent,
                    addressableRef,
                    eventCreatedAt
                );

                if (hydrated) {
                    trace.getActiveSpan()?.addEvent("event_handler.report_hydrated", {
                        "report.slug": article.dTag,
                        "report.addressableRef": addressableRef.substring(0, 20),
                    });
                }
            }

            trace.getActiveSpan()?.addEvent("event_handler.report_cached", {
                "report.slug": article.dTag || "",
                "report.author": event.pubkey.substring(0, 8),
                "report.isDeleted": isDeleted,
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

    /**
     * Format an NDKArticle for local storage
     */
    private formatReportForLocalStorage(article: NDKArticle): string {
        const lines: string[] = [];

        // Add title
        if (article.title) {
            lines.push(`# ${article.title}`);
            lines.push("");
        }

        // Add summary
        if (article.summary) {
            lines.push(`> ${article.summary}`);
            lines.push("");
        }

        // Extract hashtags (excluding memorize tag)
        const hashtags = article.tags
            .filter((tag: string[]) => tag[0] === "t" && tag[1] !== "memorize")
            .map((tag: string[]) => tag[1]);

        if (hashtags.length > 0) {
            lines.push(`**Tags:** ${hashtags.map((t) => `#${t}`).join(" ")}`);
            lines.push("");
        }

        lines.push("---");
        lines.push("");

        // Add content
        if (article.content) {
            lines.push(article.content);
        }

        return lines.join("\n");
    }

    private handleDefaultEvent(_event: NDKEvent): void {
        // Unhandled event kinds are ignored silently
    }

    async cleanup(): Promise<void> {
        // Save all conversations before shutting down
        await ConversationStore.cleanup();
    }

}
