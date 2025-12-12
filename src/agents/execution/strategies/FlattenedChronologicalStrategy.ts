import { DelegationXmlFormatter } from "@/conversations/formatters/DelegationXmlFormatter";
import { toolMessageStorage } from "@/conversations/persistence/ToolMessageStorage";
import { EventToModelMessage } from "@/conversations/processors/EventToModelMessage";
// Utility imports
import { hasReasoningTag } from "@/conversations/utils/content-utils";
import { addAllSpecialContexts } from "@/conversations/utils/context-enhancers";
import { getNDK } from "@/nostr";
import { AgentEventDecoder } from "@/nostr/AgentEventDecoder";
import { getTargetedAgentPubkeys, isEventFromUser } from "@/nostr/utils";
import { buildSystemPromptMessages } from "@/prompts/utils/systemPromptBuilder";
import { getProjectContext, isProjectContextInitialized } from "@/services/ProjectContext";
import { DelegationRegistry } from "@/services/delegation";
import { NudgeService } from "@/services/NudgeService";
import { getPubkeyService } from "@/services/PubkeyService";
import { logger } from "@/utils/logger";
import {
    extractNostrEntities,
    resolveNostrEntitiesToSystemMessages,
} from "@/utils/nostr-entity-parser";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { SpanStatusCode, context as otelContext, trace } from "@opentelemetry/api";
import type { ModelMessage } from "ai";
import type { ExecutionContext } from "../types";
import type { MessageGenerationStrategy } from "./types";

const tracer = trace.getTracer("tenex.message-strategy");

interface EventWithContext {
    event: NDKEvent;
    timestamp: number;
    isDelegationRequest?: boolean;
    isDelegationResponse?: boolean;
    delegationId?: string;
    delegationContent?: string;
    delegatedToPubkey?: string;
    delegatedToName?: string;
}

/**
 * Message generation strategy that provides a flattened, chronological view
 * of all threads the agent has participated in, with delegation markers
 */
export class FlattenedChronologicalStrategy implements MessageGenerationStrategy {
    /**
     * Build messages with flattened chronological context (telemetry wrapper)
     */
    async buildMessages(
        context: ExecutionContext,
        triggeringEvent: NDKEvent,
        eventFilter?: (event: NDKEvent) => boolean
    ): Promise<ModelMessage[]> {
        const span = tracer.startSpan("tenex.strategy.build_messages", {
            attributes: {
                "strategy.name": "FlattenedChronological",
                "agent.slug": context.agent.slug,
                "conversation.id": context.conversationId,
            },
        });

        return otelContext.with(trace.setSpan(otelContext.active(), span), async () => {
            try {
                const messages = await this.buildMessagesCore(
                    context,
                    triggeringEvent,
                    eventFilter,
                    span
                );
                span.setStatus({ code: SpanStatusCode.OK });
                return messages;
            } catch (error) {
                span.recordException(error as Error);
                span.setStatus({ code: SpanStatusCode.ERROR });
                throw error;
            } finally {
                span.end();
            }
        });
    }

    /**
     * Build messages core logic (pure business logic)
     */
    private async buildMessagesCore(
        context: ExecutionContext,
        triggeringEvent: NDKEvent,
        eventFilter: ((event: NDKEvent) => boolean) | undefined,
        span: ReturnType<typeof tracer.startSpan>
    ): Promise<ModelMessage[]> {
        const conversation = context.getConversation();

        if (!conversation) {
            span.addEvent("error", { reason: "conversation_not_found" });
            throw new Error(`Conversation ${context.conversationId} not found`);
        }

        span.setAttribute("conversation.event_count", conversation.history.length);

        const messages: ModelMessage[] = [];

        // Add system prompt
        await this.addSystemPrompt(messages, context, span);

        // Capture system prompt for debugging
        const systemMessage = messages.find((m) => m.role === "system");
        if (systemMessage) {
            const systemContent =
                typeof systemMessage.content === "string"
                    ? systemMessage.content
                    : JSON.stringify(systemMessage.content);

            span.addEvent("system_prompt_compiled", {
                "prompt.length": systemContent.length,
                "prompt.content": systemContent,
            });
        }

        // Get all events that involve this agent
        const relevantEvents = await this.gatherRelevantEvents(
            context,
            conversation.history,
            eventFilter
        );

        span.addEvent("events_gathered", {
            relevant_event_count: relevantEvents.length,
            total_event_count: conversation.history.length,
        });

        // Sort events chronologically
        relevantEvents.sort((a, b) => a.timestamp - b.timestamp);

        // Build the flattened view
        const flattenedContent = await this.buildFlattenedView(
            relevantEvents,
            context.agent.pubkey,
            context.conversationId,
            context.debug
        );

        messages.push(...flattenedContent);

        // Add special context instructions if needed
        await addAllSpecialContexts(
            messages,
            triggeringEvent,
            context.isDelegationCompletion || false,
            context.agent.slug
        );

        span.setAttributes({
            "messages.total": messages.length,
            "messages.has_system": messages.some((m) => m.role === "system"),
        });

        span.addEvent("messages_built", {
            final_message_count: messages.length,
        });

        return messages;
    }

    /**
     * Gather all events relevant to this agent
     */
    private async gatherRelevantEvents(
        context: ExecutionContext,
        allEvents: NDKEvent[],
        eventFilter?: (event: NDKEvent) => boolean
    ): Promise<EventWithContext[]> {
        const agentPubkey = context.agent.pubkey;
        const relevantEvents: EventWithContext[] = [];
        const delegationRegistry = DelegationRegistry.getInstance();

        // Track delegations this agent has made
        const outgoingDelegations = new Map<string, { content: string; targets: string[] }>();

        // STEP 1: Build thread path set for inclusion
        // Build the parent chain from triggering event to root
        const triggeringEvent = context.triggeringEvent;
        const eventMap = new Map(allEvents.map((e) => [e.id, e]));

        // Build parent chain
        const parentChain: NDKEvent[] = [];
        let current: NDKEvent | undefined = triggeringEvent;
        const visited = new Set<string>();

        while (current) {
            if (visited.has(current.id)) {
                break; // Circular reference protection
            }
            visited.add(current.id);
            parentChain.unshift(current); // Add to front to maintain order

            const parentId = current.tagValue("e");
            if (!parentId) break; // Reached root

            current = eventMap.get(parentId);
        }

        // Determine thread path based on depth
        let threadPath: NDKEvent[];
        const rootEvent = parentChain[0];
        const rootId = rootEvent?.id;

        // Special case: If triggering event is a direct reply to root,
        // include ALL sibling replies to root (for collaborative root-level discussions)
        if (parentChain.length === 2 && rootId) {
            // Add root
            threadPath = [rootEvent];

            // Add ALL direct replies to root (sorted chronologically)
            const rootReplies = allEvents
                .filter((e) => {
                    if (e.id === rootId) return false; // Skip root itself
                    const parentId = e.tagValue("e");
                    return parentId === rootId;
                })
                .sort((a, b) => (a.created_at || 0) - (b.created_at || 0));

            threadPath.push(...rootReplies);
        } else {
            // For deeper threads, only include direct parent chain (no siblings)
            threadPath = parentChain;
        }

        const threadPathIds = new Set(threadPath.map((e) => e.id));

        const activeSpan = trace.getActiveSpan();
        if (activeSpan) {
            activeSpan.addEvent("thread_path_computed", {
                "thread_path.event_count": threadPath.length,
                "thread_path.parent_chain_depth": parentChain.length,
                "thread_path.is_root_level_reply": parentChain.length === 2,
                "thread_path.includes_root_siblings": parentChain.length === 2,
                "thread_path.root_id": threadPath[0]?.id?.substring(0, 8),
                "thread_path.triggering_id": triggeringEvent.id?.substring(0, 8),
            });
        }

        for (const event of allEvents) {
            // Apply event filter if provided
            if (eventFilter && !eventFilter(event)) {
                if (activeSpan) {
                    activeSpan.addEvent("event.filtered_by_external", {
                        "event.id": event.id?.substring(0, 8),
                        "event.content": event.content?.substring(0, 50),
                        "filter.reason": "external_filter",
                    });
                }
                continue;
            }

            // Skip reasoning events
            if (hasReasoningTag(event)) {
                if (activeSpan) {
                    activeSpan.addEvent("event.filtered_by_reasoning", {
                        "event.id": event.id?.substring(0, 8),
                        "event.content": event.content?.substring(0, 50),
                        "filter.reason": "reasoning_event",
                    });
                }
                continue;
            }

            const eventWithContext: EventWithContext = {
                event,
                timestamp: event.created_at || Date.now() / 1000,
            };

            // Check if this agent is involved
            const isFromAgent = event.pubkey === agentPubkey;
            const isTargetedToAgent = getTargetedAgentPubkeys(event).includes(agentPubkey);
            const isFromUser = isEventFromUser(event);
            // Only consider it a public broadcast if it's from a user with no specific agent targets
            // AND we have project context initialized (otherwise we can't reliably determine user vs agent)
            const isPublicBroadcast =
                isProjectContextInitialized() &&
                isFromUser &&
                getTargetedAgentPubkeys(event).length === 0;

            // Check if this is a delegation response (do this FIRST, before other filtering)
            // Delegation responses are special because they should be formatted differently
            if (!isFromAgent && event.kind === 1111) {
                const isDelegationResponse = await this.checkIfDelegationResponse(
                    event,
                    agentPubkey,
                    context.conversationId,
                    delegationRegistry
                );
                if (isDelegationResponse) {
                    eventWithContext.isDelegationResponse = true;
                    // Get the delegation ID from the e-tag (reference to delegation event)
                    const eTag = event.tagValue("e");
                    if (eTag) {
                        const delegationRecord = delegationRegistry.getDelegation(eTag);
                        if (delegationRecord) {
                            eventWithContext.delegationId =
                                delegationRecord.delegationEventId.substring(0, 8);
                        }
                    }
                }
            }

            // HYBRID INCLUSION LOGIC:
            // Include event if EITHER:
            // A. It's in the thread path (root → triggering event) - ensures full conversation context
            // B. It's directly relevant to this agent (for awareness of parallel branches)

            const isInThreadPath = threadPathIds.has(event.id);
            const isDirectlyRelevant =
                isFromAgent ||
                isTargetedToAgent ||
                isPublicBroadcast ||
                eventWithContext.isDelegationResponse;

            if (!isInThreadPath && !isDirectlyRelevant) {
                if (activeSpan) {
                    activeSpan.addEvent("event.filtered_out", {
                        "event.id": event.id?.substring(0, 8),
                        "event.content": event.content?.substring(0, 50),
                        "event.pubkey": event.pubkey.substring(0, 8),
                        "filter.is_in_thread_path": false,
                        "filter.is_from_agent": isFromAgent,
                        "filter.is_targeted_to_agent": isTargetedToAgent,
                        "filter.is_public_broadcast": isPublicBroadcast,
                        "filter.is_delegation_response":
                            eventWithContext.isDelegationResponse || false,
                        "filter.reason": "not_in_thread_and_not_relevant",
                    });
                }
                continue;
            }

            // Check if this is a delegation request from this agent
            if (isFromAgent && event.kind === 1111) {
                // Check for delegation event (has phase tag)
                const phaseTag = event.tagValue("phase");

                if (phaseTag) {
                    // Try to find delegation record by event ID
                    const delegationRecord = delegationRegistry.getDelegation(event.id);

                    if (delegationRecord) {
                        // Verify this delegation is assigned to one of the p-tagged recipients
                        const recipientPubkey = delegationRecord.assignedTo.pubkey;

                        eventWithContext.isDelegationRequest = true;
                        eventWithContext.delegationId =
                            delegationRecord.delegationEventId.substring(0, 8);
                        eventWithContext.delegationContent = event.content;
                        eventWithContext.delegatedToPubkey = recipientPubkey;

                        // Track this delegation for later response matching
                        outgoingDelegations.set(delegationRecord.delegationEventId, {
                            content: event.content,
                            targets: [recipientPubkey],
                        });
                    }
                }
            }

            // Check if this is a response to a delegation from this agent
            if (!isFromAgent && event.kind === 1111) {
                // Look up delegation by e-tag (reference to delegation event)
                const eTag = event.tagValue("e");
                let delegationRecord;

                if (eTag) {
                    delegationRecord = delegationRegistry.getDelegation(eTag);
                    // Verify the responder matches the assigned agent
                    if (delegationRecord && delegationRecord.assignedTo.pubkey !== event.pubkey) {
                        delegationRecord = undefined;
                    }
                }

                if (delegationRecord) {
                    // Only consider it a delegation response if it p-tags the delegating agent
                    const pTags = event.getMatchingTags("p");
                    const mentionsAgent = pTags.some((tag) => tag[1] === agentPubkey);

                    if (mentionsAgent) {
                        eventWithContext.isDelegationResponse = true;
                        eventWithContext.delegationId =
                            delegationRecord.delegationEventId.substring(0, 8);
                    }
                }
            }

            // Event passed all filters - include it
            if (activeSpan) {
                activeSpan.addEvent("event.included", {
                    "event.id": event.id?.substring(0, 8),
                    "event.content": event.content?.substring(0, 50),
                    "event.pubkey": event.pubkey.substring(0, 8),
                    "inclusion.is_in_thread_path": isInThreadPath,
                    "inclusion.is_from_agent": isFromAgent,
                    "inclusion.is_targeted_to_agent": isTargetedToAgent,
                    "inclusion.is_public_broadcast": isPublicBroadcast,
                    "inclusion.is_delegation_response":
                        eventWithContext.isDelegationResponse || false,
                    "inclusion.is_delegation_request":
                        eventWithContext.isDelegationRequest || false,
                    "inclusion.reason": isInThreadPath ? "in_thread_path" : "directly_relevant",
                });
            }

            relevantEvents.push(eventWithContext);
        }

        return relevantEvents;
    }

    /**
     * Check if an event is a delegation response to this agent
     */
    private async checkIfDelegationResponse(
        event: NDKEvent,
        agentPubkey: string,
        conversationId: string,
        registry: DelegationRegistry
    ): Promise<boolean> {
        if (event.kind !== 1111) {
            return false;
        }

        try {
            // Prioritize lookup by e-tag (reference to delegation event)
            const eTag = event.tagValue("e");
            let record;

            if (eTag) {
                record = registry.getDelegation(eTag);
                // Verify the responder matches the assigned agent
                if (record && record.assignedTo.pubkey !== event.pubkey) {
                    record = undefined;
                }
            }

            // Fallback to conversation key lookup if no e-tag
            if (!record) {
                record = registry.getDelegationByConversationKey(
                    conversationId,
                    agentPubkey,
                    event.pubkey
                );
            }

            if (!record) return false;

            // IMPORTANT: Only consider it a delegation response if it p-tags the delegating agent
            // Events that reply to the delegation but don't p-tag the delegating agent are
            // just the delegated agent working on the task, not responding back
            const pTags = event.getMatchingTags("p");
            const mentionsAgent = pTags.some((tag) => tag[1] === agentPubkey);

            if (mentionsAgent) {
                return true;
            }
        } catch (error) {
            logger.debug("[FlattenedChronologicalStrategy] Error checking delegation response", {
                error,
            });
        }

        return false;
    }

    /**
     * Build the flattened chronological view
     */
    private async buildFlattenedView(
        events: EventWithContext[],
        agentPubkey: string,
        conversationId: string,
        debug = false
    ): Promise<ModelMessage[]> {
        const messages: ModelMessage[] = [];
        const nameRepo = getPubkeyService();
        const projectCtx = isProjectContextInitialized() ? getProjectContext() : null;
        const delegationRegistry = DelegationRegistry.getInstance();

        // First pass: Collect all delegations and their responses
        interface DelegationData {
            id: string;
            from: string;
            recipients: string[];
            phase?: string;
            message: string;
            requestEventId: string;
            requestEvent: NDKEvent;
            responses: Array<{
                from: string;
                content: string;
                eventId: string;
                status: "completed" | "error";
            }>;
        }
        const delegationMap = new Map<string, DelegationData>();
        const delegationResponseEventIds = new Set<string>();

        // Identify delegations and responses
        for (const eventContext of events) {
            const { event } = eventContext;

            if (eventContext.isDelegationRequest && eventContext.delegationId) {
                // Look up delegation by event ID
                const record = delegationRegistry.getDelegation(event.id);

                if (record) {
                    // Use delegation record for names (more reliable than name repository)
                    const fromSlug = record.delegatingAgent.slug;
                    // assignedTo.slug might not be set, fallback to looking it up
                    let toSlug = record.assignedTo.slug;
                    if (!toSlug) {
                        const toAgent = projectCtx?.getAgentByPubkey(record.assignedTo.pubkey);
                        toSlug =
                            toAgent?.slug || (await nameRepo.getName(record.assignedTo.pubkey));
                    }

                    // Get phase from event tags if available
                    const phaseTag = event.tags.find((t) => t[0] === "phase");
                    const phase = phaseTag?.[1];

                    if (!delegationMap.has(eventContext.delegationId)) {
                        delegationMap.set(eventContext.delegationId, {
                            id: eventContext.delegationId,
                            from: fromSlug,
                            recipients: [toSlug],
                            phase,
                            message: eventContext.delegationContent || "",
                            requestEventId: event.id,
                            requestEvent: event,
                            responses: [],
                        });
                    } else {
                        // Add recipient to existing delegation (multi-recipient case)
                        const delegation = delegationMap.get(eventContext.delegationId);
                        if (!delegation) {
                            throw new Error(
                                `Delegation ${eventContext.delegationId} not found in delegationMap after has() check`
                            );
                        }
                        if (toSlug && !delegation.recipients.includes(toSlug)) {
                            delegation.recipients.push(toSlug);
                        }
                    }
                }
            }

            if (eventContext.isDelegationResponse && eventContext.delegationId) {
                const delegation = delegationMap.get(eventContext.delegationId);
                if (delegation) {
                    // Look up the delegation record by e-tag to get the responder's slug
                    const eTag = event.tagValue("e");
                    let record;
                    if (eTag) {
                        record = delegationRegistry.getDelegation(eTag);
                    }
                    // Fallback to conversation key lookup
                    if (!record) {
                        record = delegationRegistry.getDelegationByConversationKey(
                            conversationId,
                            agentPubkey,
                            event.pubkey
                        );
                    }

                    const responderSlug =
                        record?.assignedTo.slug || (await nameRepo.getName(event.pubkey));

                    delegation.responses.push({
                        from: responderSlug,
                        content: event.content || "",
                        eventId: event.id,
                        status: "completed",
                    });

                    delegationResponseEventIds.add(event.id);
                }
            }
        }

        // Second pass: Build messages, using condensed XML for delegations
        const processedDelegations = new Set<string>();
        const delegationRequestEventIds = new Set<string>();
        const toolCallEventIds = new Set<string>();

        // Collect all delegation request event IDs and related tool-call events so we can skip them
        for (const delegation of delegationMap.values()) {
            delegationRequestEventIds.add(delegation.requestEventId);
        }

        // Also identify tool-call events for delegate (they should be skipped)
        for (const eventWithContext of events) {
            const toolTag = eventWithContext.event.tags.find((t) => t[0] === "tool");
            if (toolTag && toolTag[1] === "delegate") {
                toolCallEventIds.add(eventWithContext.event.id);
            }
        }

        for (const eventContext of events) {
            const { event } = eventContext;

            // Skip tool-call events for delegations (they're replaced by the delegation XML)
            if (toolCallEventIds.has(event.id)) {
                continue;
            }

            // Handle delegation request - emit condensed XML block
            if (eventContext.isDelegationRequest && eventContext.delegationId) {
                const delegation = delegationMap.get(eventContext.delegationId);

                if (delegation && !processedDelegations.has(eventContext.delegationId)) {
                    const xml = DelegationXmlFormatter.render(delegation, debug);

                    messages.push({
                        role: "system",
                        content: xml,
                    });

                    processedDelegations.add(eventContext.delegationId);
                }
                // Skip the actual delegation request event - it's now in the XML block
                continue;
            }

            // Skip delegation responses - they're now in the delegation block
            if (eventContext.isDelegationResponse && delegationResponseEventIds.has(event.id)) {
                continue;
            }

            // Regular message processing
            const processedMessages = await this.processEvent(
                event,
                agentPubkey,
                conversationId,
                debug
            );
            messages.push(...processedMessages);
        }

        return messages;
    }

    /**
     * Process a single event into messages (reused from ThreadWithMemoryStrategy)
     */
    private async processEvent(
        event: NDKEvent,
        agentPubkey: string,
        conversationId: string,
        debug = false
    ): Promise<ModelMessage[]> {
        const messages: ModelMessage[] = [];

        // Skip reasoning events
        if (hasReasoningTag(event)) {
            return [];
        }

        // Check if this is a tool event from this agent
        const isToolEvent = event.tags.some((t) => t[0] === "tool");
        const isThisAgent = event.pubkey === agentPubkey;

        if (isToolEvent) {
            if (isThisAgent) {
                // Load tool messages from storage
                const toolMessages = await toolMessageStorage.load(event.id);
                if (toolMessages) {
                    // Add event ID prefix in debug mode
                    if (debug) {
                        const eventIdPrefix = `[Event ${event.id.substring(0, 8)}] `;
                        toolMessages.forEach((msg) => {
                            if (typeof msg.content === "string") {
                                msg.content = eventIdPrefix + msg.content;
                            }
                        });
                    }
                    messages.push(...toolMessages);
                    return messages;
                }
            } else {
                // Skip tool events from other agents
                return [];
            }
        }

        // Process regular message
        const content = event.content || "";

        // Use EventToModelMessage for proper attribution
        const result = await EventToModelMessage.transform(
            event,
            content,
            agentPubkey,
            conversationId
        );

        // Handle both single message and array of messages
        const messagesToAdd = Array.isArray(result) ? result : [result];

        // Add event ID prefix in debug mode
        if (debug) {
            const eventIdPrefix = `[Event ${event.id.substring(0, 8)}] `;
            messagesToAdd.forEach((msg) => {
                if (typeof msg.content === "string") {
                    msg.content = eventIdPrefix + msg.content;
                }
            });
        }

        messages.push(...messagesToAdd);

        // If not from this agent and contains nostr entities, append system messages
        if (event.pubkey !== agentPubkey) {
            const entities = extractNostrEntities(event.content || "");
            if (entities.length > 0) {
                try {
                    const nameRepo = getPubkeyService();
                    const ndk = getNDK();
                    const entitySystemMessages = await resolveNostrEntitiesToSystemMessages(
                        event.content || "",
                        ndk,
                        (pubkey) => nameRepo.getName(pubkey)
                    );

                    for (const systemContent of entitySystemMessages) {
                        messages.push({
                            role: "system",
                            content: systemContent,
                        });
                    }
                } catch (error) {
                    logger.warn(
                        "[FlattenedChronologicalStrategy] Failed to resolve nostr entities",
                        {
                            error,
                            eventId: event.id.substring(0, 8),
                        }
                    );
                }
            }
        }

        return messages;
    }

    /**
     * Add system prompt based on context
     */
    private async addSystemPrompt(
        messages: ModelMessage[],
        context: ExecutionContext,
        span: ReturnType<typeof tracer.startSpan>
    ): Promise<void> {
        const conversation = context.getConversation();
        if (!conversation) return;

        if (isProjectContextInitialized()) {
            // Project mode
            const projectCtx = getProjectContext();
            const project = projectCtx.project;
            const availableAgents = Array.from(projectCtx.agents.values());
            const agentLessonsMap = new Map();
            const currentAgentLessons = projectCtx.getLessonsForAgent(context.agent.pubkey);

            if (currentAgentLessons.length > 0) {
                agentLessonsMap.set(context.agent.pubkey, currentAgentLessons);
            }

            const isProjectManager = context.agent.pubkey === projectCtx.getProjectManager().pubkey;

            const systemMessages = await buildSystemPromptMessages({
                agent: context.agent,
                project,
                projectPath: context.projectPath,
                availableAgents,
                conversation,
                agentLessons: agentLessonsMap,
                isProjectManager,
                projectManagerPubkey: projectCtx.getProjectManager().pubkey,
                workingDirectory: context.workingDirectory,
                currentBranch: context.currentBranch,
            });

            for (const systemMsg of systemMessages) {
                messages.push(systemMsg.message);
            }

            // Add nudges if present on triggering event
            const nudgeIds = AgentEventDecoder.extractNudgeEventIds(context.triggeringEvent);
            if (nudgeIds.length > 0) {
                span.addEvent("nudge.injection_start", {
                    "nudge.count": nudgeIds.length,
                    "agent.slug": context.agent.slug,
                });

                const nudgeService = NudgeService.getInstance();
                const nudgeContent = await nudgeService.fetchNudges(nudgeIds);
                if (nudgeContent) {
                    messages.push({
                        role: "system",
                        content: nudgeContent,
                    });

                    span.addEvent("nudge.injection_success", {
                        "nudge.content_length": nudgeContent.length,
                    });

                    span.setAttributes({
                        "nudge.injected": true,
                        "nudge.count": nudgeIds.length,
                        "nudge.content_length": nudgeContent.length,
                    });
                } else {
                    span.addEvent("nudge.injection_empty");
                    span.setAttribute("nudge.injected", false);
                }
            } else {
                span.setAttribute("nudge.injected", false);
            }
        } else {
            // Fallback minimal prompt
            messages.push({
                role: "system",
                content: `You are ${context.agent.name}. ${context.agent.instructions || ""}`,
            });
        }
    }
}
