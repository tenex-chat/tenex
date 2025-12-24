/**
 * FlattenedChronologicalStrategy - Message generation strategy for LLM context
 *
 * This strategy provides a flattened, chronological view of all threads
 * the agent has participated in, with delegation markers.
 *
 * Responsibilities are delegated to focused modules:
 * - EventGatherer: Event collection and filtering
 * - EventProcessor: Event-to-message transformation
 * - DelegationBuilder: Delegation context building
 * - SystemPromptInjector: System prompt construction
 */

import { addAllSpecialContexts } from "@/conversations/utils/context-enhancers";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { SpanStatusCode, context as otelContext, trace } from "@opentelemetry/api";
import type { ModelMessage } from "ai";
import type { ExecutionContext } from "../types";

// Import extracted modules
import {
    buildDelegationMap,
    identifyDelegateToolCallEvents,
    renderDelegationMessage,
} from "./DelegationBuilder";
import {
    formatPreviousSubthreadsContext,
    gatherPreviousSubthreads,
    gatherRelevantEvents,
    isDelegatedExecution,
} from "./EventGatherer";
import { processEvent, reconstructToolMessagesFromEvent } from "./EventProcessor";
import { addSystemPrompt } from "./SystemPromptInjector";
import type { MessageGenerationStrategy } from "./types";
import type { EventWithContext } from "./types/EventWithContext";

const tracer = trace.getTracer("tenex.message-strategy");

// Re-export for backwards compatibility
export { reconstructToolMessagesFromEvent };

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

        // Check if this is a delegated execution (isolated view)
        const isDelegated = isDelegatedExecution(context);
        span.setAttribute("execution.is_delegated", isDelegated);

        // Add system prompt
        await addSystemPrompt(messages, context, span);

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
            const previousSubthreads = await gatherPreviousSubthreads(
                context.agent.pubkey,
                context.triggeringEvent.id,
                conversation.history
            );

            if (previousSubthreads.length > 0) {
                const subthreadContext = formatPreviousSubthreadsContext(previousSubthreads);
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
        const relevantEvents = await gatherRelevantEvents(
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
     * Build the flattened chronological view
     */
    private async buildFlattenedView(
        events: EventWithContext[],
        agentPubkey: string,
        conversationId: string,
        debug = false
    ): Promise<ModelMessage[]> {
        const messages: ModelMessage[] = [];

        // Build delegation map and identify related events
        const { delegationMap, delegationResponseEventIds } = await buildDelegationMap(
            events,
            agentPubkey
        );

        // Identify tool-call events for delegate (they should be skipped)
        const toolCallEventIds = identifyDelegateToolCallEvents(events);

        // Collect all delegation request event IDs
        const delegationRequestEventIds = new Set<string>();
        for (const delegation of delegationMap.values()) {
            delegationRequestEventIds.add(delegation.requestEventId);
        }

        // Track processed delegations to avoid duplicates
        const processedDelegations = new Set<string>();

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
                    const delegationMessage = renderDelegationMessage(delegation, debug || false);
                    messages.push(delegationMessage);
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
            const processedMessages = await processEvent(
                event,
                agentPubkey,
                conversationId,
                debug
            );
            messages.push(...processedMessages);
        }

        return messages;
    }
}
