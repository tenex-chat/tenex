import type { AgentInstance } from "@/agents/types";
import { NDKKind } from "@/nostr/kinds";
import { getNDK } from "@/nostr/ndkClient";
import { getLLMSpanId } from "@/telemetry/LLMSpanRegistry";
import { logger } from "@/utils/logger";
import { context as otelContext, propagation, trace } from "@opentelemetry/api";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { AgentEventEncoder } from "./AgentEventEncoder";
import type {
    AskConfig,
    CompletionIntent,
    ConversationIntent,
    DelegateConfig,
    ErrorIntent,
    EventContext,
    LessonIntent,
    ToolUseIntent,
} from "./types";
import { PendingDelegationsRegistry, RALRegistry } from "@/services/ral";

// Re-export config types for backwards compatibility
export type { AskConfig, DelegateConfig } from "./types";

/**
 * Inject W3C trace context into an event's tags.
 * This allows the daemon to link incoming events back to their parent span.
 * Also adds trace_context_llm which links to the LLM execution span for better debugging.
 */
function injectTraceContext(event: NDKEvent): void {
    const carrier: Record<string, string> = {};
    propagation.inject(otelContext.active(), carrier);
    if (carrier.traceparent) {
        event.tags.push(["trace_context", carrier.traceparent]);
    }

    // Add trace context that links to LLM execution span (more useful for debugging)
    const activeSpan = trace.getActiveSpan();
    if (activeSpan) {
        const spanContext = activeSpan.spanContext();
        const traceId = spanContext.traceId;

        // Use LLM span ID if available (links to actual LLM execution)
        // Otherwise fall back to current span ID
        const llmSpanId = getLLMSpanId(traceId);
        const spanIdToUse = llmSpanId || spanContext.spanId;

        event.tags.push(["trace_context_llm", `00-${traceId}-${spanIdToUse}-01`]);
    }
}

/**
 * Comprehensive publisher for all agent-related Nostr events.
 * Handles agent creation, responses, completions, and delegations.
 */
export class AgentPublisher {
    private agent: AgentInstance;
    private encoder: AgentEventEncoder;

    constructor(agent: AgentInstance) {
        this.agent = agent;
        this.encoder = new AgentEventEncoder();
    }

    /**
     * Consume unreported runtime from RAL and enhance context with it.
     * This ensures each published event gets the incremental runtime since last publish.
     *
     * IMPORTANT: Always consumes from RAL to advance lastReportedRuntime, even when
     * explicit llmRuntime is provided. This prevents double-counting on subsequent events.
     */
    private consumeAndEnhanceContext(context: EventContext): EventContext {
        const ralRegistry = RALRegistry.getInstance();

        // Always consume to advance lastReportedRuntime (prevents double-counting)
        const unreportedRuntime = ralRegistry.consumeUnreportedRuntime(
            this.agent.pubkey,
            context.conversationId,
            context.ralNumber
        );

        // DEBUG: Temporary logging to diagnose llm-runtime issue
        logger.info("[AgentPublisher.consumeAndEnhanceContext]", {
            agent: this.agent.slug,
            pubkey: this.agent.pubkey.substring(0, 8),
            conv: context.conversationId.substring(0, 8),
            ral: context.ralNumber,
            unreportedMs: unreportedRuntime,
        });

        // If context already has llmRuntime set explicitly, use that value
        // (but we still consumed above to advance the counter)
        if (context.llmRuntime !== undefined) {
            return context;
        }

        return {
            ...context,
            llmRuntime: unreportedRuntime > 0 ? unreportedRuntime : undefined,
        };
    }

    /**
     * Safely publish an event with error handling.
     * Logs warnings on publish failure or 0-relay success.
     */
    private async safePublish(event: NDKEvent, eventType: string): Promise<void> {
        try {
            const relaySet = await event.publish();

            // Log relay responses
            const successRelays: string[] = [];
            for (const relay of relaySet) {
                successRelays.push(relay.url);
            }

            if (successRelays.length === 0) {
                logger.warn("Event published to 0 relays", {
                    eventId: event.id?.substring(0, 8),
                    eventType,
                    agent: this.agent.slug,
                    rawEvent: JSON.stringify(event.rawEvent()),
                });
            }
        } catch (error) {
            logger.warn(`Failed to publish ${eventType}`, {
                error,
                eventId: event.id?.substring(0, 8),
                agent: this.agent.slug,
                rawEvent: JSON.stringify(event.rawEvent()),
            });
        }
    }

    /**
     * Add delegation tag to an event, linking it to the parent conversation.
     * This method is used by delegate() and ask() to establish the parent-child
     * relationship between conversations.
     *
     * @param event - The event to add the delegation tag to
     * @param context - The event context containing the conversationId
     * @throws Error if context.conversationId is missing
     */
    private addDelegationTag(event: NDKEvent, context: EventContext): void {
        if (!context.conversationId) {
            throw new Error("Cannot add delegation tag: conversationId is required in context for delegation events");
        }
        event.tags.push(["delegation", context.conversationId]);
    }

    /**
     * Publish a completion event.
     * Creates and publishes a properly tagged completion event with p-tag.
     * Includes both incremental runtime (llm-runtime) and total runtime (llm-runtime-total).
     */
    async complete(intent: CompletionIntent, context: EventContext): Promise<NDKEvent> {
        const enhancedContext = this.consumeAndEnhanceContext(context);

        // For completion events, include the total accumulated runtime for the entire RAL
        // This allows delegation aggregation to get the correct total runtime
        const ralRegistry = RALRegistry.getInstance();
        const totalRuntime = ralRegistry.getAccumulatedRuntime(
            this.agent.pubkey,
            context.conversationId,
            context.ralNumber
        );

        const contextWithTotal: EventContext = {
            ...enhancedContext,
            llmRuntimeTotal: totalRuntime > 0 ? totalRuntime : undefined,
        };

        const event = this.encoder.encodeCompletion(intent, contextWithTotal);

        injectTraceContext(event);
        await this.agent.sign(event);
        await this.safePublish(event, "completion");

        return event;
    }

    /**
     * Publish a conversation event (mid-loop response without p-tag).
     * Used when agent has text output but delegations are still pending.
     */
    async conversation(intent: ConversationIntent, context: EventContext): Promise<NDKEvent> {
        const enhancedContext = this.consumeAndEnhanceContext(context);
        const event = this.encoder.encodeConversation(intent, enhancedContext);

        injectTraceContext(event);
        await this.agent.sign(event);
        await this.safePublish(event, "conversation");

        return event;
    }

    /**
     * Publish a delegation event
     */
    async delegate(config: DelegateConfig, context: EventContext): Promise<string> {
        const enhancedContext = this.consumeAndEnhanceContext(context);
        const ndk = getNDK();
        const event = new NDKEvent(ndk);
        event.kind = NDKKind.Text; // kind:1 - unified conversation format
        event.content = config.content;

        // Add recipient p-tag
        event.tags.push(["p", config.recipient]);

        // No e-tag: delegation events start separate conversations

        if (config.branch) {
            event.tags.push(["branch", config.branch]);
        }

        // Add standard metadata (project tag, model, cost, execution time, etc)
        this.encoder.addStandardTags(event, enhancedContext);

        // Forward branch tag from triggering event if not explicitly set
        if (!config.branch) {
            this.encoder.forwardBranchTag(event, enhancedContext);
        }

        // Add delegation tag linking to parent conversation
        this.addDelegationTag(event, enhancedContext);

        injectTraceContext(event);
        await this.agent.sign(event);
        await this.safePublish(event, "delegation");

        // Register with PendingDelegationsRegistry for q-tag correlation
        PendingDelegationsRegistry.register(this.agent.pubkey, context.conversationId, event.id);

        return event.id;
    }

    /**
     * Publish an ask event using the multi-question format.
     */
    async ask(config: AskConfig, context: EventContext): Promise<string> {
        const enhancedContext = this.consumeAndEnhanceContext(context);
        const ndk = getNDK();
        const event = new NDKEvent(ndk);
        event.kind = NDKKind.Text; // kind:1 - unified conversation format
        // Content is just the context (user has no access to conversation history)
        event.content = config.context;

        // Add title tag
        event.tags.push(["title", config.title]);

        // Add question/multiselect tags
        for (const question of config.questions) {
            if (question.type === "question") {
                const tag = ["question", question.title, question.question];
                if (question.suggestions) {
                    tag.push(...question.suggestions);
                }
                event.tags.push(tag);
            } else if (question.type === "multiselect") {
                const tag = ["multiselect", question.title, question.question];
                if (question.options) {
                    tag.push(...question.options);
                }
                event.tags.push(tag);
            }
        }

        // Add recipient p-tag
        event.tags.push(["p", config.recipient]);

        // No e-tag: ask events start separate conversations (like delegate)

        // Add standard metadata (project tag, model, cost, execution time, runtime, etc)
        this.encoder.addStandardTags(event, enhancedContext);

        // Add ask marker
        event.tags.push(["ask", "true"]);

        // Add t-tag for ask events
        event.tags.push(["t", "ask"]);

        // Add delegation tag linking to parent conversation
        this.addDelegationTag(event, enhancedContext);

        injectTraceContext(event);
        await this.agent.sign(event);
        await this.safePublish(event, "ask");

        // Register with PendingDelegationsRegistry for q-tag correlation
        PendingDelegationsRegistry.register(this.agent.pubkey, enhancedContext.conversationId, event.id);

        return event.id;
    }

    /**
     * Publish a delegation follow-up event
     */
    async delegateFollowup(
        params: {
            recipient: string;
            content: string;
            delegationEventId: string;
            replyToEventId?: string;
        },
        context: EventContext
    ): Promise<string> {
        const enhancedContext = this.consumeAndEnhanceContext(context);
        const ndk = getNDK();
        const event = new NDKEvent(ndk);
        event.kind = NDKKind.Text; // kind:1 - unified conversation format
        event.content = params.content;

        // Add recipient p-tag
        event.tags.push(["p", params.recipient]);

        // Add reference to the original delegation event
        event.tags.push(["e", params.delegationEventId]);

        // Reply to specific response event if provided (for threading)
        if (params.replyToEventId) {
            event.tags.push(["e", params.replyToEventId]);
        }

        // Add standard metadata (project tag, model, cost, execution time, runtime, etc)
        this.encoder.addStandardTags(event, enhancedContext);

        // Forward branch tag from triggering event
        this.encoder.forwardBranchTag(event, enhancedContext);

        injectTraceContext(event);
        await this.agent.sign(event);
        await this.safePublish(event, "followup");

        return event.id;
    }

    /**
     * Publish an error event.
     * Creates and publishes an error notification event.
     */
    async error(intent: ErrorIntent, context: EventContext): Promise<NDKEvent> {
        const enhancedContext = this.consumeAndEnhanceContext(context);
        const event = this.encoder.encodeError(intent, enhancedContext);

        injectTraceContext(event);
        await this.agent.sign(event);
        await this.safePublish(event, "error");

        return event;
    }

    /**
     * Publish a lesson learned event.
     */
    async lesson(intent: LessonIntent, context: EventContext): Promise<NDKEvent> {
        const enhancedContext = this.consumeAndEnhanceContext(context);
        const lessonEvent = this.encoder.encodeLesson(intent, enhancedContext, this.agent);

        injectTraceContext(lessonEvent);
        await this.agent.sign(lessonEvent);
        await this.safePublish(lessonEvent, "lesson");

        return lessonEvent;
    }

    /**
     * Publish a tool usage event.
     * Creates and publishes an event with tool name and output tags.
     */
    async toolUse(intent: ToolUseIntent, context: EventContext): Promise<NDKEvent> {
        const enhancedContext = this.consumeAndEnhanceContext(context);
        const event = this.encoder.encodeToolUse(intent, enhancedContext);

        injectTraceContext(event);
        await this.agent.sign(event);
        await this.safePublish(event, `tool:${intent.toolName}`);

        return event;
    }
}
