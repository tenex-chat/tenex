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
import { getProjectContext, isProjectContextInitialized } from "@/services/projects";
import { NudgeService } from "@/services/nudge";
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
 * Represents a previous subthread this agent participated in
 */
interface PreviousSubthread {
    delegationEventId: string;
    delegatorSlug: string;
    delegatorPubkey: string;
    prompt: string;
    response?: string;
    timestamp: number;
}

/**
 * Reconstruct tool messages from a published tool event when storage is unavailable.
 * Tool events are published with JSON content containing tool name, input, and output.
 * @internal Exported for testing
 */
export function reconstructToolMessagesFromEvent(event: NDKEvent): ModelMessage[] | null {
    try {
        const parsed = JSON.parse(event.content);

        // Validate required fields
        if (!parsed.tool || parsed.input === undefined) {
            logger.warn("[FlattenedChronologicalStrategy] Tool event missing required fields", {
                eventId: event.id.substring(0, 8),
                hasTool: !!parsed.tool,
                hasInput: parsed.input !== undefined,
            });
            return null;
        }

        // Use first 16 chars of event ID as toolCallId
        const toolCallId = `call_${event.id.substring(0, 16)}`;

        // Build the tool-call message (assistant role)
        const toolCallMessage: ModelMessage = {
            role: "assistant",
            content: [
                {
                    type: "tool-call" as const,
                    toolCallId,
                    toolName: parsed.tool,
                    input: parsed.input,
                },
            ],
        };

        // Build the tool-result message (tool role)
        const outputValue = parsed.output !== undefined
            ? (typeof parsed.output === "string" ? parsed.output : JSON.stringify(parsed.output))
            : "";

        const toolResultMessage: ModelMessage = {
            role: "tool",
            content: [
                {
                    type: "tool-result" as const,
                    toolCallId,
                    toolName: parsed.tool,
                    output: {
                        type: "text" as const,
                        value: outputValue,
                    },
                },
            ],
        };

        logger.debug("[FlattenedChronologicalStrategy] Reconstructed tool messages from event", {
            eventId: event.id.substring(0, 8),
            toolName: parsed.tool,
        });

        return [toolCallMessage, toolResultMessage];
    } catch (error) {
        logger.warn("[FlattenedChronologicalStrategy] Failed to parse tool event content", {
            eventId: event.id.substring(0, 8),
            error: error instanceof Error ? error.message : String(error),
        });
        return null;
    }
}

/**
 * Message generation strategy that provides a flattened, chronological view
 * of all threads the agent has participated in, with delegation markers
 */
export class FlattenedChronologicalStrategy implements MessageGenerationStrategy {
    /**
     * Detect if this is a delegated execution (this agent was delegated to by another agent)
     */
    private isDelegatedExecution(context: ExecutionContext): boolean {
        const triggeringEvent = context.triggeringEvent;
        const agentPubkey = context.agent.pubkey;

        // Check if triggering event is from another agent and targets this agent
        if (triggeringEvent.pubkey === agentPubkey) {
            return false; // Self-triggered, not a delegation
        }

        // Check if this agent is in the p-tags (delegation target)
        const pTags = triggeringEvent.getMatchingTags("p");
        const isTargeted = pTags.some((tag) => tag[1] === agentPubkey);

        if (!isTargeted) {
            return false;
        }

        // Check if the sender is an agent (not a user)
        const projectCtx = isProjectContextInitialized() ? getProjectContext() : null;
        if (projectCtx) {
            const senderAgent = projectCtx.getAgentByPubkey(triggeringEvent.pubkey);
            if (senderAgent) {
                return true; // Triggered by another agent targeting this agent = delegation
            }
        }

        return false;
    }

    /**
     * Find previous subthreads this agent participated in (for re-invocation context)
     */
    private async gatherPreviousSubthreads(
        agentPubkey: string,
        currentDelegationEventId: string,
        allEvents: NDKEvent[]
    ): Promise<PreviousSubthread[]> {
        const subthreads: PreviousSubthread[] = [];
        const projectCtx = isProjectContextInitialized() ? getProjectContext() : null;
        const nameRepo = getPubkeyService();

        // Find all delegation events TO this agent (excluding current one)
        for (const event of allEvents) {
            if (event.id === currentDelegationEventId) continue;
            if (event.pubkey === agentPubkey) continue; // Skip events FROM this agent

            // Check if this is a delegation to this agent
            const pTags = event.getMatchingTags("p");
            const targetsThisAgent = pTags.some((tag) => tag[1] === agentPubkey);

            if (!targetsThisAgent) continue;

            // Check if sender is an agent
            const senderAgent = projectCtx?.getAgentByPubkey(event.pubkey);
            if (!senderAgent) continue;

            // Find this agent's response to this delegation
            const response = allEvents.find(
                (e) =>
                    e.pubkey === agentPubkey &&
                    e.getMatchingTags("e").some((tag) => tag[1] === event.id)
            );

            const delegatorSlug = senderAgent?.slug || (await nameRepo.getName(event.pubkey));

            subthreads.push({
                delegationEventId: event.id,
                delegatorSlug,
                delegatorPubkey: event.pubkey,
                prompt: event.content,
                response: response?.content,
                timestamp: event.created_at || 0,
            });
        }

        // Sort by timestamp
        subthreads.sort((a, b) => a.timestamp - b.timestamp);

        return subthreads;
    }

    /**
     * Format previous subthreads as context message
     */
    private formatPreviousSubthreadsContext(subthreads: PreviousSubthread[]): string | null {
        if (subthreads.length === 0) return null;

        const parts = [
            "## Previous Tasks in This Conversation",
            "",
            "You were previously delegated other tasks in this conversation. Here's a summary for context:",
            "",
        ];

        for (const subthread of subthreads) {
            parts.push(`### Task from ${subthread.delegatorSlug}`);
            parts.push(`**Request:** ${subthread.prompt.substring(0, 500)}${subthread.prompt.length > 500 ? "..." : ""}`);
            if (subthread.response) {
                parts.push(`**Your response:** ${subthread.response.substring(0, 300)}${subthread.response.length > 300 ? "..." : ""}`);
            }
            parts.push("");
        }

        parts.push("---");
        parts.push("Focus on your current task. The above is just context.");

        return parts.join("\n");
    }

    /**
     * Gather events for a delegated execution - ISOLATED VIEW
     * Only includes the delegation request and events in this subthread
     */
    private async gatherDelegationSubthread(
        context: ExecutionContext,
        allEvents: NDKEvent[],
        eventFilter?: (event: NDKEvent) => boolean
    ): Promise<EventWithContext[]> {
        const triggeringEvent = context.triggeringEvent;
        const relevantEvents: EventWithContext[] = [];
        const activeSpan = trace.getActiveSpan();

        // The triggering event is the delegation request - it becomes our "root"
        const delegationEventId = triggeringEvent.id;

        // Build set of events in this subthread:
        // - The delegation request itself
        // - Any events that reply to it (directly or transitively)
        const subthreadEventIds = new Set<string>([delegationEventId]);

        // Find all transitive replies to the delegation event
        let foundNew = true;
        while (foundNew) {
            foundNew = false;
            for (const event of allEvents) {
                if (subthreadEventIds.has(event.id)) continue;

                const eTags = event.getMatchingTags("e");
                for (const eTag of eTags) {
                    if (subthreadEventIds.has(eTag[1])) {
                        subthreadEventIds.add(event.id);
                        foundNew = true;
                        break;
                    }
                }
            }
        }

        if (activeSpan) {
            activeSpan.addEvent("delegation_subthread_computed", {
                "subthread.event_count": subthreadEventIds.size,
                "subthread.root_id": delegationEventId?.substring(0, 8),
            });
        }

        // Filter events to only those in the subthread
        for (const event of allEvents) {
            // Apply external filter if provided
            if (eventFilter && !eventFilter(event)) {
                continue;
            }

            // Skip reasoning events
            if (hasReasoningTag(event)) {
                continue;
            }

            // Only include events in the subthread
            if (!subthreadEventIds.has(event.id)) {
                if (activeSpan) {
                    activeSpan.addEvent("event.filtered_delegation_isolation", {
                        "event.id": event.id?.substring(0, 8),
                        "event.content": event.content?.substring(0, 50),
                        "filter.reason": "not_in_delegation_subthread",
                    });
                }
                continue;
            }

            const eventWithContext: EventWithContext = {
                event,
                timestamp: event.created_at || Date.now() / 1000,
            };

            if (activeSpan) {
                activeSpan.addEvent("event.included_delegation", {
                    "event.id": event.id?.substring(0, 8),
                    "event.content": event.content?.substring(0, 50),
                    "event.pubkey": event.pubkey.substring(0, 8),
                    "inclusion.reason": "in_delegation_subthread",
                });
            }

            relevantEvents.push(eventWithContext);
        }

        logger.debug("[FlattenedChronologicalStrategy] Gathered delegation subthread", {
            delegationEventId: delegationEventId?.substring(0, 8),
            subthreadSize: subthreadEventIds.size,
            relevantEventCount: relevantEvents.length,
            totalEventCount: allEvents.length,
        });

        return relevantEvents;
    }

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

        // Check if this is a delegated execution (isolated view)
        const isDelegated = this.isDelegatedExecution(context);
        span.setAttribute("execution.is_delegated", isDelegated);

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

        // For delegated executions, add context about previous subthreads
        if (isDelegated) {
            const previousSubthreads = await this.gatherPreviousSubthreads(
                context.agent.pubkey,
                context.triggeringEvent.id,
                conversation.history
            );

            if (previousSubthreads.length > 0) {
                const subthreadContext = this.formatPreviousSubthreadsContext(previousSubthreads);
                if (subthreadContext) {
                    messages.push({
                        role: "system",
                        content: subthreadContext,
                    });
                    span.addEvent("previous_subthreads_added", {
                        count: previousSubthreads.length,
                    });
                }
            }
        }

        // Get all events that involve this agent
        // For delegated executions, this will return only the delegation subthread
        const relevantEvents = await this.gatherRelevantEvents(
            context,
            conversation.history,
            eventFilter,
            isDelegated
        );

        span.addEvent("events_gathered", {
            relevant_event_count: relevantEvents.length,
            total_event_count: conversation.history.length,
            is_delegated: isDelegated,
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
     * @param isDelegated If true, only include events in the delegation subthread (isolated view)
     */
    private async gatherRelevantEvents(
        context: ExecutionContext,
        allEvents: NDKEvent[],
        eventFilter?: (event: NDKEvent) => boolean,
        isDelegated = false
    ): Promise<EventWithContext[]> {
        const agentPubkey = context.agent.pubkey;
        const relevantEvents: EventWithContext[] = [];
        const triggeringEvent = context.triggeringEvent;
        const activeSpan = trace.getActiveSpan();

        // DELEGATION ISOLATION: If this is a delegated execution, only show the delegation subthread
        if (isDelegated) {
            return this.gatherDelegationSubthread(
                context,
                allEvents,
                eventFilter
            );
        }

        // Build index of delegation requests from this agent for response matching
        // Delegation request = kind 1111 from agent with phase tag
        const delegationRequestsById = new Map<string, NDKEvent>();
        for (const event of allEvents) {
            if (
                event.pubkey === agentPubkey &&
                event.kind === 1111 &&
                event.tagValue("phase")
            ) {
                delegationRequestsById.set(event.id, event);
            }
        }

        // STEP 1: Build thread path set for inclusion
        // Build the parent chain from triggering event to root
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
            // Delegation response = kind 1111 that e-tags a delegation request and p-tags the delegating agent
            if (!isFromAgent && event.kind === 1111) {
                const eTags = event.getMatchingTags("e");
                const pTags = event.getMatchingTags("p");
                const mentionsAgent = pTags.some((tag) => tag[1] === agentPubkey);

                // Check if any e-tag references one of our delegation requests
                for (const eTag of eTags) {
                    const referencedId = eTag[1];
                    if (delegationRequestsById.has(referencedId) && mentionsAgent) {
                        eventWithContext.isDelegationResponse = true;
                        eventWithContext.delegationId = referencedId.substring(0, 8);
                        break;
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
            // Delegation request = kind 1111 from agent with p-tag pointing to another agent
            // Phase tag is optional (only required for self-delegation)
            if (isFromAgent && event.kind === 1111) {
                const pTags = event.getMatchingTags("p");
                if (pTags.length > 0) {
                    const recipientPubkey = pTags[0][1];
                    // This is a delegation if it's pointing to another agent (or same agent with phase)
                    const phaseTag = event.tagValue("phase");
                    const isSelfDelegation = recipientPubkey === agentPubkey;

                    // Detect as delegation if: delegating to another agent, OR self-delegation with phase
                    if (!isSelfDelegation || phaseTag) {
                        eventWithContext.isDelegationRequest = true;
                        eventWithContext.delegationId = event.id.substring(0, 8);
                        eventWithContext.delegationContent = event.content;
                        eventWithContext.delegatedToPubkey = recipientPubkey;
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

        // Build delegation map from event tags (no registry needed)
        for (const eventContext of events) {
            const { event } = eventContext;

            if (eventContext.isDelegationRequest && eventContext.delegationId) {
                // Get agent names from project context or pubkey service
                const fromAgent = projectCtx?.getAgentByPubkey(agentPubkey);
                const fromSlug = fromAgent?.slug || (await nameRepo.getName(agentPubkey));

                const toAgent = eventContext.delegatedToPubkey
                    ? projectCtx?.getAgentByPubkey(eventContext.delegatedToPubkey)
                    : undefined;
                const toSlug = toAgent?.slug ||
                    (eventContext.delegatedToPubkey
                        ? await nameRepo.getName(eventContext.delegatedToPubkey)
                        : "unknown");

                // Get phase from event tags
                const phaseTag = event.tags.find((t) => t[0] === "phase");
                const phase = phaseTag?.[1];

                // Use full event ID for map key (delegationId is truncated)
                const fullId = event.id;
                if (!delegationMap.has(fullId)) {
                    delegationMap.set(fullId, {
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
                    const delegation = delegationMap.get(fullId);
                    if (delegation && toSlug && !delegation.recipients.includes(toSlug)) {
                        delegation.recipients.push(toSlug);
                    }
                }
            }

            if (eventContext.isDelegationResponse && eventContext.delegationId) {
                // Find the delegation this responds to by matching e-tags
                const eTags = event.getMatchingTags("e");
                for (const eTag of eTags) {
                    const delegationEventId = eTag[1];
                    const delegation = delegationMap.get(delegationEventId);
                    if (delegation) {
                        // Get responder name from project context or pubkey service
                        const responderAgent = projectCtx?.getAgentByPubkey(event.pubkey);
                        const responderSlug = responderAgent?.slug || (await nameRepo.getName(event.pubkey));

                        delegation.responses.push({
                            from: responderSlug,
                            content: event.content || "",
                            eventId: event.id,
                            status: "completed",
                        });

                        delegationResponseEventIds.add(event.id);
                        break;
                    }
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
                // Use full event ID for lookup (delegation map is keyed by full ID)
                const delegation = delegationMap.get(event.id);

                if (delegation && !processedDelegations.has(event.id)) {
                    const xml = DelegationXmlFormatter.render(delegation, debug);

                    messages.push({
                        role: "system",
                        content: xml,
                    });

                    processedDelegations.add(event.id);
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
     * Process a single event into messages
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
                // Try to load tool messages from storage first
                let toolMessages = await toolMessageStorage.load(event.id);

                // Fallback: reconstruct from event content if storage missed it
                if (!toolMessages) {
                    toolMessages = reconstructToolMessagesFromEvent(event);
                }

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

                // If we still can't reconstruct, log and skip
                logger.warn("[FlattenedChronologicalStrategy] Could not load or reconstruct tool event", {
                    eventId: event.id.substring(0, 8),
                });
                return [];
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

            // Add lesson tracing to understand lesson state at prompt build time
            span.addEvent("tenex.lesson.context_state", {
                "agent.name": context.agent.name,
                "agent.slug": context.agent.slug,
                "agent.pubkey": context.agent.pubkey.substring(0, 16),
                "agent.event_id": context.agent.eventId?.substring(0, 16) || "none",
                "lessons.for_this_agent_count": currentAgentLessons.length,
                "lessons.total_in_context": projectCtx.agentLessons.size,
                "lessons.all_agent_pubkeys_with_lessons": JSON.stringify(
                    Array.from(projectCtx.agentLessons.keys()).map((k) => k.substring(0, 16))
                ),
            });

            // Log all lessons in context for debugging
            if (projectCtx.agentLessons.size > 0) {
                const allLessonsDebug: Array<{ pubkey: string; count: number; titles: string[] }> = [];
                for (const [pubkey, lessons] of projectCtx.agentLessons) {
                    allLessonsDebug.push({
                        pubkey: pubkey.substring(0, 16),
                        count: lessons.length,
                        titles: lessons.slice(0, 3).map((l) => l.title || "untitled"),
                    });
                }
                span.setAttribute("lessons.all_in_context", JSON.stringify(allLessonsDebug));
            }

            if (currentAgentLessons.length > 0) {
                agentLessonsMap.set(context.agent.pubkey, currentAgentLessons);
                span.addEvent("lessons_found_for_agent", {
                    "lessons.count": currentAgentLessons.length,
                    "lessons.titles": JSON.stringify(
                        currentAgentLessons.slice(0, 5).map((l) => l.title || "untitled")
                    ),
                });
            } else {
                span.addEvent("no_lessons_for_agent", {
                    "agent.pubkey": context.agent.pubkey.substring(0, 16),
                    "agent.event_id": context.agent.eventId?.substring(0, 16) || "none",
                });
            }

            const isProjectManager = context.agent.pubkey === projectCtx.getProjectManager().pubkey;

            const systemMessages = await buildSystemPromptMessages({
                agent: context.agent,
                project,
                projectBasePath: context.projectBasePath,
                workingDirectory: context.workingDirectory,
                currentBranch: context.currentBranch,
                availableAgents,
                conversation,
                agentLessons: agentLessonsMap,
                isProjectManager,
                projectManagerPubkey: projectCtx.getProjectManager().pubkey,
                alphaMode: context.alphaMode,
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
