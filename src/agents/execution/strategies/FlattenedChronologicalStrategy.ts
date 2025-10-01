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
        addAllSpecialContexts(
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
                // Check if this event has delegate_phase or delegate tool
                const toolTag = event.tags.find(t => t[0] === 'tool');
                const isDelegatePhase = toolTag && (toolTag[1] === 'delegate_phase' || toolTag[1] === 'delegate');

                console.log("[FlattenedChronologicalStrategy] Checking delegation request", {
                    eventId: event.id.substring(0, 8),
                    conversationId: context.conversationId.substring(0, 8),
                    agentPubkey: agentPubkey.substring(0, 8),
                    hasDelegateTool: isDelegatePhase,
                    toolTag: toolTag?.[1]
                });

                if (isDelegatePhase) {
                    // Parse tool-args to get recipients
                    const toolArgsTag = event.tags.find(t => t[0] === 'tool-args');

                    console.log("[FlattenedChronologicalStrategy] Parsing tool-args", {
                        hasToolArgsTag: !!toolArgsTag,
                        toolArgsContent: toolArgsTag?.[1]?.substring(0, 100)
                    });

                    if (toolArgsTag && toolArgsTag[1]) {
                        try {
                            const toolArgs = JSON.parse(toolArgsTag[1]);
                            const recipients = toolArgs.recipients || [];

                            console.log("[FlattenedChronologicalStrategy] Parsed recipients", {
                                recipients,
                                count: recipients.length
                            });

                            // For each recipient, look up the delegation in the registry
                            for (const recipientSlug of recipients) {
                                // Get recipient pubkey from project context
                                const projectCtx = isProjectContextInitialized() ? getProjectContext() : null;
                                const recipientAgent = projectCtx?.agents.get(recipientSlug);

                                console.log("[FlattenedChronologicalStrategy] Looking up recipient agent", {
                                    recipientSlug,
                                    found: !!recipientAgent,
                                    pubkey: recipientAgent?.pubkey.substring(0, 8)
                                });

                                if (recipientAgent) {
                                    const delegationRecord = delegationRegistry.getDelegationByConversationKey(
                                        context.conversationId,
                                        agentPubkey,
                                        recipientAgent.pubkey
                                    );

                                    console.log("[FlattenedChronologicalStrategy] Delegation record lookup result", {
                                        found: !!delegationRecord,
                                        toolCallEventId: event.id.substring(0, 8),
                                        delegationEventId: delegationRecord?.delegationEventId.substring(0, 8),
                                        conversationId: context.conversationId.substring(0, 8),
                                        fromPubkey: agentPubkey.substring(0, 8),
                                        toPubkey: recipientAgent.pubkey.substring(0, 8)
                                    });

                                    // Use the delegation record if found, even if event IDs don't match
                                    // The event we're looking at is the tool-call event, but the registry
                                    // stores the actual delegation event ID which is different
                                    if (delegationRecord) {
                                        eventWithContext.isDelegationRequest = true;
                                        eventWithContext.delegationId = delegationRecord.delegationEventId.substring(0, 8);
                                        eventWithContext.delegationContent = delegationRecord.content.fullRequest;
                                        eventWithContext.delegatedToPubkey = delegationRecord.assignedTo.pubkey;

                                        // Track this delegation for later response matching
                                        outgoingDelegations.set(delegationRecord.delegationEventId, {
                                            content: delegationRecord.content.fullRequest,
                                            targets: [delegationRecord.assignedTo.pubkey]
                                        });

                                        console.log("[FlattenedChronologicalStrategy] Detected delegation request", {
                                            delegationId: eventWithContext.delegationId,
                                            toPubkey: delegationRecord.assignedTo.pubkey.substring(0, 8),
                                            toSlug: delegationRecord.assignedTo.slug,
                                            content: delegationRecord.content.fullRequest.substring(0, 50)
                                        });
                                        break;
                                    }
                                }
                            }
                        } catch (error) {
                            logger.debug("[FlattenedChronologicalStrategy] Error parsing tool-args", { error });
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
     * Find delegation record for an event
     */
    private async findDelegationRecord(
        event: NDKEvent,
        agentPubkey: string,
        registry: DelegationRegistry
    ): Promise<any> {
        try {
            const delegations = registry.getAgentDelegations(agentPubkey);

            logger.debug("[FlattenedChronologicalStrategy] Finding delegation record", {
                eventId: event.id.substring(0, 8),
                agentPubkey: agentPubkey.substring(0, 8),
                hasDelegations: !!delegations,
                delegationCount: delegations?.size || 0
            });

            if (!delegations) return null;

            for (const delegationKey of delegations) {
                const record = registry.getDelegationByKey(delegationKey);
                if (record) {
                    logger.debug("[FlattenedChronologicalStrategy] Checking delegation record", {
                        recordEventId: record.delegationEventId.substring(0, 8),
                        eventId: event.id.substring(0, 8),
                        matches: record.delegationEventId === event.id
                    });

                    if (record.delegationEventId === event.id) {
                        return record;
                    }
                }
            }
        } catch (error) {
            logger.debug("[FlattenedChronologicalStrategy] Error finding delegation record", { error });
        }

        return null;
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

        console.log(`[FlattenedChronologicalStrategy] Building flattened view with ${events.length} events`);

        // Track delegation requests to match with responses
        const pendingDelegations = new Map<string, { request: string, to: string }>();

        for (const eventContext of events) {
            const { event } = eventContext;

            console.log(`[FlattenedChronologicalStrategy] Processing event in buildFlattenedView:`, {
                eventId: event.id.substring(0, 8),
                isDelegationRequest: eventContext.isDelegationRequest,
                isDelegationResponse: eventContext.isDelegationResponse,
                fromAgent: event.pubkey === agentPubkey
            });

            // Handle delegation request
            if (eventContext.isDelegationRequest) {
                const targetAgent = projectCtx?.getAgentByPubkey(eventContext.delegatedToPubkey || "");
                const targetSlug = targetAgent?.slug || await nameRepo.getName(eventContext.delegatedToPubkey || "");

                const eventIdPrefix = debug ? `[Event ${event.id.substring(0, 8)}] ` : '';
                messages.push({
                    role: "system",
                    content: `${eventIdPrefix}[delegation to ${targetSlug} id ${eventContext.delegationId}: "${eventContext.delegationContent}"]`
                });

                if (eventContext.delegationId) {
                    pendingDelegations.set(eventContext.delegationId, {
                        request: eventContext.delegationContent || "",
                        to: targetSlug
                    });
                }

                logger.debug("[FlattenedChronologicalStrategy] Added delegation marker", {
                    to: targetSlug,
                    delegationId: eventContext.delegationId
                });
                continue;
            }

            // Handle delegation response
            if (eventContext.isDelegationResponse && eventContext.delegationId) {
                const responderAgent = projectCtx?.getAgentByPubkey(event.pubkey);
                const responderSlug = responderAgent?.slug || await nameRepo.getName(event.pubkey);
                const content = event.content || '';

                const eventIdPrefix = debug ? `[Event ${event.id.substring(0, 8)}] ` : '';
                messages.push({
                    role: "system",
                    content: `${eventIdPrefix}[delegation result from ${responderSlug} on delegation id ${eventContext.delegationId}] "${content}"`
                });

                logger.debug("[FlattenedChronologicalStrategy] Added delegation response marker", {
                    from: responderSlug,
                    delegationId: eventContext.delegationId,
                    hadPendingDelegation: pendingDelegations.has(eventContext.delegationId)
                });

                pendingDelegations.delete(eventContext.delegationId);
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