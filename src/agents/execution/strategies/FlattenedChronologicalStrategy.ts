import type { MessageGenerationStrategy } from "./types";
import type { ExecutionContext } from "../types";
import type { ModelMessage } from "ai";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { logger } from "@/utils/logger";
import { toolMessageStorage } from "@/conversations/persistence/ToolMessageStorage";
import { EventToModelMessage } from "@/conversations/processors/EventToModelMessage";
import {
    buildSystemPromptMessages
} from "@/prompts/utils/systemPromptBuilder";
import { getProjectContext, isProjectContextInitialized } from "@/services";
import { getPubkeyNameRepository } from "@/services/PubkeyNameRepository";
import { getNDK } from "@/nostr";
import { DelegationRegistry } from "@/services/DelegationRegistry";
// Utility imports
import { hasReasoningTag } from "@/conversations/utils/content-utils";
import { extractNostrEntities, resolveNostrEntitiesToSystemMessages } from "@/utils/nostr-entity-parser";
import { addAllSpecialContexts } from "@/conversations/utils/context-enhancers";
import { getTargetedAgentPubkeys, isEventFromUser } from "@/nostr/utils";
import { DelegationXmlFormatter } from "@/conversations/formatters/DelegationXmlFormatter";

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
     * Build messages with flattened chronological context
     */
    async buildMessages(
        context: ExecutionContext,
        triggeringEvent: NDKEvent,
        eventFilter?: (event: NDKEvent) => boolean
    ): Promise<ModelMessage[]> {
        const conversation = context.getConversation();

        if (!conversation) {
            throw new Error(`Conversation ${context.conversationId} not found`);
        }

        const messages: ModelMessage[] = [];

        // Add system prompt
        await this.addSystemPrompt(messages, context);

        // Get all events that involve this agent
        const relevantEvents = await this.gatherRelevantEvents(
            context,
            conversation.history,
            eventFilter
        );

        logger.debug("[FlattenedChronologicalStrategy] Processing events", {
            totalEvents: relevantEvents.length,
            agentPubkey: context.agent.pubkey.substring(0, 8),
            conversationId: context.conversationId.substring(0, 8)
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
            context.agent.name
        );

        logger.debug("[FlattenedChronologicalStrategy] Message building complete", {
            totalMessages: messages.length,
            eventCount: relevantEvents.length
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

        console.log("[FlattenedChronologicalStrategy] gatherRelevantEvents called", {
            agentName: context.agent.name,
            agentSlug: context.agent.slug,
            agentPubkey: agentPubkey.substring(0, 16),
            totalEvents: allEvents.length
        });

        console.log("[FlattenedChronologicalStrategy] All event IDs:", allEvents.map(e => e.id.substring(0, 8)));

        // Track delegations this agent has made
        const outgoingDelegations = new Map<string, { content: string, targets: string[] }>();

        for (const event of allEvents) {
            // Apply event filter if provided
            if (eventFilter && !eventFilter(event)) {
                continue;
            }

            // Skip reasoning events
            if (hasReasoningTag(event)) {
                continue;
            }

            const eventWithContext: EventWithContext = {
                event,
                timestamp: event.created_at || Date.now() / 1000
            };

            // Check if this agent is involved
            const isFromAgent = event.pubkey === agentPubkey;
            const isTargetedToAgent = getTargetedAgentPubkeys(event).includes(agentPubkey);
            const isFromUser = isEventFromUser(event);
            // Only consider it a public broadcast if it's from a user with no specific agent targets
            // AND we have project context initialized (otherwise we can't reliably determine user vs agent)
            const isPublicBroadcast = isProjectContextInitialized() && isFromUser && getTargetedAgentPubkeys(event).length === 0;

            logger.debug("[FlattenedChronologicalStrategy] Processing event in gatherRelevantEvents", {
                eventId: event.id.substring(0, 8),
                kind: event.kind,
                isFromAgent,
                isTargetedToAgent,
                isFromUser,
                isPublicBroadcast,
                eventPubkey: event.pubkey.substring(0, 8),
                agentPubkey: agentPubkey.substring(0, 8),
                willCheckDelegation: !isFromAgent && !isTargetedToAgent && !isPublicBroadcast
            });

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
                    // Get the delegation ID for the marker
                    const delegationRecord = delegationRegistry.getDelegationByConversationKey(
                        context.conversationId,
                        agentPubkey,
                        event.pubkey
                    );
                    if (delegationRecord) {
                        eventWithContext.delegationId = delegationRecord.delegationEventId.substring(0, 8);
                    }
                    logger.debug("[FlattenedChronologicalStrategy] Marked as delegation response", {
                        eventId: event.id.substring(0, 8),
                        delegationId: eventWithContext.delegationId
                    });
                }
            }

            // Include event if:
            // 1. It's from this agent
            // 2. It's targeted to this agent
            // 3. It's a public broadcast from user (no specific agent targets)
            // 4. It's a delegation response to this agent
            if (!isFromAgent && !isTargetedToAgent && !isPublicBroadcast && !eventWithContext.isDelegationResponse) {
                logger.debug("[FlattenedChronologicalStrategy] Skipping event - not relevant", {
                    eventId: event.id.substring(0, 8),
                    reason: "Not from agent, not targeted, not broadcast, not delegation response"
                });
                continue;
            }

            // Check if this is a delegation request from this agent
            if (isFromAgent && event.kind === 1111) {
                // Check for delegation event (has phase tag)
                const phaseTag = event.tagValue("phase");

                if (phaseTag) {
                    // This is a delegation event - get recipient from p-tags
                    const pTags = event.getMatchingTags("p");
                    // Filter out user pubkeys - delegation recipients are agents
                    for (const pTag of pTags) {
                        const recipientPubkey = pTag[1];

                        // Try to find delegation record for this recipient
                        const delegationRecord = delegationRegistry.getDelegationByConversationKey(
                            context.conversationId,
                            agentPubkey,
                            recipientPubkey
                        );

                        if (delegationRecord && delegationRecord.delegationEventId === event.id) {
                            eventWithContext.isDelegationRequest = true;
                            eventWithContext.delegationId = delegationRecord.delegationEventId.substring(0, 8);
                            eventWithContext.delegationContent = event.content;
                            eventWithContext.delegatedToPubkey = recipientPubkey;

                            // Track this delegation for later response matching
                            outgoingDelegations.set(delegationRecord.delegationEventId, {
                                content: event.content,
                                targets: [recipientPubkey]
                            });

                            logger.debug("[FlattenedChronologicalStrategy] Detected delegation event", {
                                delegationId: eventWithContext.delegationId,
                                toPubkey: recipientPubkey.substring(0, 8),
                                phase: phaseTag,
                                content: event.content.substring(0, 50)
                            });
                            break;
                        }
                    }
                }
            }

            // Check if this is a response to a delegation from this agent
            if (!isFromAgent && event.kind === 1111) {
                const delegationRecord = delegationRegistry.getDelegationByConversationKey(
                    context.conversationId,
                    agentPubkey,
                    event.pubkey
                );

                if (delegationRecord) {
                    // Only consider it a delegation response if it p-tags the delegating agent
                    const pTags = event.getMatchingTags("p");
                    const mentionsAgent = pTags.some(tag => tag[1] === agentPubkey);

                    if (mentionsAgent) {
                        eventWithContext.isDelegationResponse = true;
                        eventWithContext.delegationId = delegationRecord.delegationEventId.substring(0, 8);

                        logger.debug("[FlattenedChronologicalStrategy] Detected delegation response", {
                            delegationId: eventWithContext.delegationId,
                            fromPubkey: event.pubkey.substring(0, 8),
                            content: event.content?.substring(0, 50)
                        });
                    } else {
                        logger.debug("[FlattenedChronologicalStrategy] Skipping event from delegated agent (doesn't p-tag this agent)", {
                            eventId: event.id.substring(0, 8),
                            fromPubkey: event.pubkey.substring(0, 8),
                            thisAgent: agentPubkey.substring(0, 8)
                        });
                    }
                }
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
            // Check if there's a delegation record where this agent delegated to the event's author
            const record = registry.getDelegationByConversationKey(
                conversationId,
                agentPubkey,
                event.pubkey
            );

            if (!record) return false;

            // Check if this event references the delegation
            const eTag = event.tagValue("e");
            if (eTag === record.delegationEventId) {
                // IMPORTANT: Only consider it a delegation response if it p-tags the delegating agent
                // Events that reply to the delegation but don't p-tag the delegating agent are
                // just the delegated agent working on the task, not responding back
                const pTags = event.getMatchingTags("p");
                const mentionsAgent = pTags.some(tag => tag[1] === agentPubkey);

                if (mentionsAgent) {
                    return true;
                }
            }
        } catch (error) {
            logger.debug("[FlattenedChronologicalStrategy] Error checking delegation response", { error });
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
        const nameRepo = getPubkeyNameRepository();
        const projectCtx = isProjectContextInitialized() ? getProjectContext() : null;
        const delegationRegistry = DelegationRegistry.getInstance();

        console.log(`[FlattenedChronologicalStrategy] Building flattened view with ${events.length} events`);

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
                const record = delegationRegistry.getDelegationByConversationKey(
                    conversationId,
                    agentPubkey,
                    eventContext.delegatedToPubkey || ""
                );

                if (record) {
                    // Use delegation record for names (more reliable than name repository)
                    const fromSlug = record.delegatingAgent.slug;
                    // assignedTo.slug might not be set, fallback to looking it up
                    let toSlug = record.assignedTo.slug;
                    if (!toSlug) {
                        const toAgent = projectCtx?.getAgentByPubkey(record.assignedTo.pubkey);
                        toSlug = toAgent?.slug || await nameRepo.getName(record.assignedTo.pubkey);
                    }

                    // Get phase from event tags if available
                    const phaseTag = event.tags.find(t => t[0] === 'phase');
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
                            responses: []
                        });
                    } else {
                        // Add recipient to existing delegation (multi-recipient case)
                        const delegation = delegationMap.get(eventContext.delegationId)!;
                        if (toSlug && !delegation.recipients.includes(toSlug)) {
                            delegation.recipients.push(toSlug);
                        }
                    }
                }
            }

            if (eventContext.isDelegationResponse && eventContext.delegationId) {
                const delegation = delegationMap.get(eventContext.delegationId);
                if (delegation) {
                    // Look up the delegation record to get the responder's slug
                    const record = delegationRegistry.getDelegationByConversationKey(
                        conversationId,
                        agentPubkey,
                        event.pubkey
                    );
                    const responderSlug = record?.assignedTo.slug || await nameRepo.getName(event.pubkey);

                    delegation.responses.push({
                        from: responderSlug,
                        content: event.content || "",
                        eventId: event.id,
                        status: "completed"
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

        // Also identify tool-call events for delegate_phase (they should be skipped)
        for (const eventWithContext of events) {
            const toolTag = eventWithContext.event.tags.find(t => t[0] === 'tool');
            if (toolTag && (toolTag[1] === 'delegate_phase' || toolTag[1] === 'delegate')) {
                toolCallEventIds.add(eventWithContext.event.id);
            }
        }

        for (const eventContext of events) {
            const { event } = eventContext;

            console.log(`[FlattenedChronologicalStrategy] Processing event in buildFlattenedView:`, {
                eventId: event.id.substring(0, 8),
                isDelegationRequest: eventContext.isDelegationRequest,
                isDelegationResponse: eventContext.isDelegationResponse,
                fromAgent: event.pubkey === agentPubkey,
                isToolCall: toolCallEventIds.has(event.id)
            });

            // Skip tool-call events for delegations (they're replaced by the delegation XML)
            if (toolCallEventIds.has(event.id)) {
                logger.debug("[FlattenedChronologicalStrategy] Skipping delegation tool-call event", {
                    eventId: event.id.substring(0, 8)
                });
                continue;
            }

            // Handle delegation request - emit condensed XML block
            if (eventContext.isDelegationRequest && eventContext.delegationId) {
                const delegation = delegationMap.get(eventContext.delegationId);

                if (delegation && !processedDelegations.has(eventContext.delegationId)) {
                    const xml = DelegationXmlFormatter.render(delegation, debug);

                    messages.push({
                        role: "system",
                        content: xml
                    });

                    processedDelegations.add(eventContext.delegationId);

                    logger.debug("[FlattenedChronologicalStrategy] Added condensed delegation block", {
                        delegationId: eventContext.delegationId,
                        recipients: delegation.recipients,
                        responseCount: delegation.responses.length
                    });
                }
                // Skip the actual delegation request event - it's now in the XML block
                continue;
            }

            // Skip delegation responses - they're now in the delegation block
            if (eventContext.isDelegationResponse && delegationResponseEventIds.has(event.id)) {
                logger.debug("[FlattenedChronologicalStrategy] Skipping delegation response (in delegation block)", {
                    eventId: event.id.substring(0, 8)
                });
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
    private async processEvent(event: NDKEvent, agentPubkey: string, conversationId: string, debug = false): Promise<ModelMessage[]> {
        const messages: ModelMessage[] = [];

        // Skip reasoning events
        if (hasReasoningTag(event)) {
            return [];
        }

        // Check if this is a tool event from this agent
        const isToolEvent = event.tags.some(t => t[0] === 'tool');
        const isThisAgent = event.pubkey === agentPubkey;

        if (isToolEvent) {
            if (isThisAgent) {
                // Load tool messages from storage
                const toolMessages = await toolMessageStorage.load(event.id);
                if (toolMessages) {
                    // Add event ID prefix in debug mode
                    if (debug) {
                        const eventIdPrefix = `[Event ${event.id.substring(0, 8)}] `;
                        toolMessages.forEach(msg => {
                            if (typeof msg.content === 'string') {
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
        const content = event.content || '';

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
            messagesToAdd.forEach(msg => {
                if (typeof msg.content === 'string') {
                    msg.content = eventIdPrefix + msg.content;
                }
            });
        }

        messages.push(...messagesToAdd);

        // If not from this agent and contains nostr entities, append system messages
        if (event.pubkey !== agentPubkey) {
            const entities = extractNostrEntities(event.content || '');
            if (entities.length > 0) {
                try {
                    const nameRepo = getPubkeyNameRepository();
                    const ndk = getNDK();
                    const entitySystemMessages = await resolveNostrEntitiesToSystemMessages(
                        event.content || '',
                        ndk,
                        (pubkey) => nameRepo.getName(pubkey)
                    );

                    for (const systemContent of entitySystemMessages) {
                        messages.push({
                            role: "system",
                            content: systemContent
                        });
                    }
                } catch (error) {
                    logger.warn("[FlattenedChronologicalStrategy] Failed to resolve nostr entities", {
                        error,
                        eventId: event.id.substring(0, 8)
                    });
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
        context: ExecutionContext
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
                availableAgents,
                conversation,
                agentLessons: agentLessonsMap,
                isProjectManager,
                projectManagerPubkey: projectCtx.getProjectManager().pubkey,
            });

            for (const systemMsg of systemMessages) {
                messages.push(systemMsg.message);
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