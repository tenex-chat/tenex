import { NDKKind } from "@/nostr/kinds";
import { formatAnyError } from "@/lib/error-formatter";
import { type NDKEvent, NDKProject } from "@nostr-dev-kit/ndk";
import { AgentExecutor } from "../agents/execution/AgentExecutor";
import { ConversationStore } from "../conversations/ConversationStore";
import { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { NDKEventMetadata } from "../events/NDKEventMetadata";
import { AgentConfigUpdateService } from "@/services/agents";
import { getProjectContext } from "@/services/projects";
import { config } from "@/services/ConfigService";
import { RALRegistry } from "@/services/ral";
import { prefixKVStore } from "@/services/storage";
import { tryExtractDTagFromAddress } from "@/types/project-ids";
import { logger } from "../utils/logger";
import { shortenConversationId, shortenOptionalEventId } from "@/utils/conversation-id";
import { shouldTrustLesson } from "@/utils/lessonTrust";
import { getPubkeyGateService } from "@/services/pubkey-gate";
import { handleAgentDeletion } from "./agentDeletion";
import { handleKillSignal } from "./kill-signal";
import { handleProjectEvent } from "./project";
import { handleChatMessage } from "./reply";
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
                eventId: shortenOptionalEventId(event.id),
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
    NDKKind.TenexStreamTextDelta,
];

export class EventHandler {
    private agentExecutor!: AgentExecutor;
    private isUpdatingProject = false;
    private readonly agentConfigUpdateService = new AgentConfigUpdateService();

    constructor(private readonly options: { agentExecutor?: AgentExecutor } = {}) {}

    async initialize(): Promise<void> {
        this.agentExecutor = this.options.agentExecutor ?? new AgentExecutor();
    }

    async handleEvent(event: NDKEvent): Promise<void> {
        // Ignore ephemeral status and typing indicator events
        if (IGNORED_EVENT_KINDS.includes(event.kind)) return;

        // PUBKEY GATE: Only allow events from trusted pubkeys (whitelisted, backend, or known agents)
        // This is the front-door gate — all events must pass through before any routing occurs.
        // Fail-closed: if the check errors, the event is denied.
        if (!getPubkeyGateService().shouldAllowEvent(event)) {
            return;
        }

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

            case NDKKind.DelegationMarker:
                await handleKillSignal(event, {
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

            case NDKKind.TenexAgentDelete:
                await handleAgentDeletion(event);
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
        if (ConversationStore.has(conversationId)) {
            // Collect metadata updates from tags
            const updates: Record<string, string | undefined> = {};

            const title = metadata.title;
            if (title) {
                updates.title = title;
            }

            // Parse summary tag
            const summaryTag = event.tags.find((tag: string[]) => tag[0] === "summary");
            if (summaryTag?.[1]) {
                updates.summary = summaryTag[1];
            }

            // Parse status-label tag
            const statusLabelTag = event.tags.find((tag: string[]) => tag[0] === "status-label");
            if (statusLabelTag?.[1]) {
                updates.statusLabel = statusLabelTag[1];
            }

            // Parse status-current-activity tag
            const statusActivityTag = event.tags.find((tag: string[]) => tag[0] === "status-current-activity");
            if (statusActivityTag?.[1]) {
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
            // Format: ["a", "31933:<pubkey>:<d-tag>"] or just the d-tag portion
            // When present, config is scoped to that project only
            const aTag = event.tagValue("a");
            let projectDTag: string | undefined;
            if (aTag) {
                projectDTag = tryExtractDTagFromAddress(aTag) ?? undefined;
                if (!projectDTag) {
                    const parts = aTag.split(":");
                    projectDTag = parts.length >= 3 ? parts.slice(2).join(":") : aTag;
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

            const agent = projectContext.getAgentByPubkey(agentPubkey);

            if (!agent) {
                logger.warn("Agent not found for config change", {
                    agentPubkey,
                    availableAgents: projectContext.getAgentSlugs(),
                });
                return;
            }

            const updateResult = await this.agentConfigUpdateService.applyEvent(event, { projectDTag });
            const configUpdated = updateResult.configUpdated || updateResult.pmUpdated;

            logger.info(
                updateResult.scope === "project"
                    ? "Processing project-scoped agent config update"
                    : "Processing global agent config update",
                {
                    agentSlug: agent.slug,
                    projectDTag,
                    hasModel: updateResult.hasModel,
                    toolCount: updateResult.toolCount,
                    skillCount: updateResult.skillCount,
                    hasPM: updateResult.hasPM,
                    hasReset: updateResult.hasReset,
                }
            );

            // Reload and status publish now handled by AgentConfigWatcher.
            // applyEvent() writes to disk → watcher detects change → reloadAgent() + publishImmediately().
            if (configUpdated) {
                logger.info("Agent config updated on disk, watcher will reload", {
                    agentSlug: agent.slug,
                    agentPubkey: agentPubkey.substring(0, 8),
                    projectScoped: projectDTag !== undefined,
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
                eventId: shortenOptionalEventId(event.id),
            });
            return;
        }

        let ralsAborted = 0;

        const projectCtx = getProjectContext();
        const ralRegistry = RALRegistry.getInstance();
        const stopTracer = trace.getTracer("tenex.event-handler");
        const reason = `stop signal from ${event.pubkey.substring(0, 8)}`;

        for (const [, conversationId] of eTags) {
            const conversation = ConversationStore.get(conversationId);
            if (!conversation) continue;
            const projectId = conversation.getProjectId();
            if (!projectId) continue;

            for (const [, agentPubkey] of pTags) {
                const agent = projectCtx.getAgentByPubkey(agentPubkey);
                if (agent) {
                    // Get the RAL's trace context to parent the stop span under agent execution
                    const activeRals = ralRegistry.getActiveRALs(agentPubkey, conversationId);
                    const targetRal = activeRals[0];

                    // Build parent context from stored trace info
                    let parentContext = otelContext.active();
                    if (targetRal?.traceId && targetRal?.executionSpanId) {
                        const parentSpanContext = {
                            traceId: targetRal.traceId,
                            spanId: targetRal.executionSpanId,
                            traceFlags: TraceFlags.SAMPLED,
                            isRemote: false,
                        };
                        parentContext = trace.setSpanContext(otelContext.active(), parentSpanContext);
                    }

                    const stopSpan = stopTracer.startSpan(
                        "tenex.stop_command",
                        {
                            attributes: {
                                "event.id": event.id,
                                "event.kind": event.kind,
                                "event.author": event.pubkey.substring(0, 8),
                                "event.raw": event.rawEvent() ? JSON.stringify(event.rawEvent()) : "unavailable",
                                "stop.agent_slug": agent.slug,
                                "stop.agent_pubkey": agentPubkey.substring(0, 8),
                                "stop.conversation_id": shortenConversationId(conversationId),
                                "stop.active_rals": activeRals.length,
                            },
                        },
                        parentContext
                    );

                    const result = await ralRegistry.abortWithCascade(
                        agentPubkey, conversationId, projectId, reason
                    );
                    ralsAborted += result.abortedCount;

                    stopSpan.setAttribute("stop.rals_aborted", result.abortedCount);
                    stopSpan.setAttribute("stop.descendants_aborted", result.descendantConversations.length);
                    stopSpan.end();

                    logger.info(`[EventHandler] Stopped agent ${agent.slug} in conversation ${conversationId.substring(0, 8)}`, {
                        ralsAborted: result.abortedCount,
                        descendantsAborted: result.descendantConversations.length,
                    });
                }
            }
        }

        trace.getActiveSpan()?.addEvent("event_handler.stop_operations", {
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
                eventId: shortenOptionalEventId(event.id),
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
        await ConversationStore.cleanup();
    }

}
