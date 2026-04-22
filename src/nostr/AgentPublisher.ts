import type {
    AgentRuntimePublisher,
    PublishedMessageRef,
    TransportMessageIntent,
} from "@/events/runtime/AgentRuntimePublisher";
import type { RuntimePublishAgent } from "@/events/runtime/RuntimeAgent";
import { NDKKind } from "@/nostr/kinds";
import { getNDK } from "@/nostr/ndkClient";
import { PendingDelegationsRegistry, RALRegistry } from "@/services/ral";
import { shortenConversationId, shortenOptionalEventId, shortenPubkey } from "@/utils/conversation-id";
import { logger } from "@/utils/logger";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { trace } from "@opentelemetry/api";
import { AgentPublishError } from "./AgentPublishError";
import { AgentEventEncoder } from "./AgentEventEncoder";
import { NostrInboundAdapter } from "./NostrInboundAdapter";
import { enqueueSignedEventForRustPublish } from "./RustPublishOutbox";
import { injectTraceContext } from "./trace-context";
import type {
    AskConfig,
    CompletionIntent,
    ConversationIntent,
    DelegateConfig,
    ErrorIntent,
    EventContext,
    LessonIntent,
    StreamTextDeltaIntent,
    ToolUseIntent,
} from "./types";

/**
 * Comprehensive publisher for all agent-related Nostr events.
 * Handles agent creation, responses, completions, and delegations.
 */
export class AgentPublisher implements AgentRuntimePublisher {
    private agent: RuntimePublishAgent;
    private encoder: AgentEventEncoder;
    private readonly inboundAdapter = new NostrInboundAdapter();

    constructor(agent: RuntimePublishAgent) {
        this.agent = agent;
        this.encoder = new AgentEventEncoder();
    }

    private toPublishedMessageRef(event: NDKEvent): PublishedMessageRef {
        const envelope = this.inboundAdapter.toEnvelope(event);

        return {
            id: event.id ?? envelope.message.nativeId,
            transport: envelope.transport,
            envelope,
            encodedId: event.encode(),
        };
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
     * Publish a failure notification event when an event cannot be published after all retries.
     * Attaches the serialized failed event as a "failed-event" tag for observability on the relay.
     * Best-effort: errors are silently swallowed so the caller can proceed to throw.
     */
    private publishFailureNotification(failedEvent: NDKEvent, eventType: string): void {
        void (async () => {
            try {
                const notification = new NDKEvent(getNDK());
                notification.kind = NDKKind.Text as number;
                notification.content = `Failed to publish ${eventType}`;
                notification.tags = [
                    ["error", "publish_failure"],
                    ["failed-event", failedEvent.inspect],
                ];
                await this.agent.sign(notification);
                await enqueueSignedEventForRustPublish(notification, {
                    correlationId: "agent_publish_failure_notification",
                    projectId: "agent-publish-failure",
                    conversationId: failedEvent.id ?? notification.id ?? "unknown",
                    requestId: `agent-publish-failure:${notification.id}`,
                });
                logger.warn("[PUBLISHERROR] Enqueued failure notification for failed event", {
                    failedEventId: shortenOptionalEventId(failedEvent.id),
                    failedEventType: eventType,
                    notificationId: notification.id,
                    agent: this.agent.slug,
                });
            } catch (error) {
                logger.warn("[PUBLISHERROR] Failed to publish failure notification", {
                    failedEventId: shortenOptionalEventId(failedEvent.id),
                    failedEventType: eventType,
                    agent: this.agent.slug,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        })();
    }

    /**
     * Hand a signed event to Rust for relay publishing.
     * Assumes the event is already signed.
     */
    private async safePublish(event: NDKEvent, eventType: string): Promise<void> {
        try {
            await enqueueSignedEventForRustPublish(event, {
                correlationId: `agent_${eventType}`,
                projectId: event.tags.find((tag) => tag[0] === "a")?.[1] ?? "agent-event",
                conversationId: event.tags.find((tag) => tag[0] === "e")?.[1] ?? event.id ?? "agent-event",
                requestId: `agent:${eventType}:${event.id}`,
            });
            logger.info(`Enqueued ${eventType} event for Rust publish`, {
                eventId: shortenOptionalEventId(event.id),
                eventType,
                agent: this.agent.slug,
            });
        } catch (error) {
            logger.error(`Failed to enqueue ${eventType} for Rust publish`, {
                eventId: shortenOptionalEventId(event.id),
                agent: this.agent.slug,
                kind: event.kind,
                contentLength: event.content?.length || 0,
                tagCount: event.tags?.length || 0,
                rawEvent: JSON.stringify(event.rawEvent()),
            });
            logger.writeToWarnLog({
                timestamp: new Date().toISOString(),
                level: "error",
                component: "AgentPublisher",
                message: `Failed to enqueue ${eventType} for Rust publish`,
                context: {
                    eventId: shortenOptionalEventId(event.id),
                    agent: this.agent.slug,
                    rawEvent: JSON.stringify(event.rawEvent()),
                },
                error: error instanceof Error ? error.message : String(error),
            });
            this.publishFailureNotification(event, eventType);
            const message = error instanceof Error ? error.message : String(error);
            throw new AgentPublishError(
                `Failed to enqueue ${eventType} for Rust publish: ${message}`,
                {
                    cause: error,
                    event: this.toPublishedMessageRef(event),
                    eventType,
                }
            );
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
     * Guard delegation-style flows that require a parent conversation ID before
     * runtime accounting/logging touches the context.
     */
    private assertConversationId(context: EventContext, eventType: string): void {
        if (!context.conversationId) {
            throw new Error(
                `Cannot add delegation tag: conversationId is required in context for ${eventType} events`
            );
        }
    }

    /**
     * Publish a completion event.
     * Creates and publishes a properly tagged completion event with p-tag.
     * Includes both incremental runtime (llm-runtime) and total runtime (llm-runtime-total).
     *
     * DELEGATION CHAIN ROUTING: For conversations with a delegation chain, the completion
     * is routed to the immediate delegator (second-to-last in chain), not triggeringEnvelope.pubkey.
     * The recipient pubkey is pre-resolved by createEventContext (layer 3) and passed via
     * context.completionRecipientPubkey. This avoids a layer violation - AgentPublisher (layer 2)
     * cannot import ConversationStore directly.
     *
     * RACE CONDITION GUARD: If this conversation was killed via the kill tool,
     * this method returns undefined instead of publishing. This prevents the scenario
     * where an agent continues running (e.g., in a long tool execution) after being
     * killed and then publishes a completion that triggers the parent to process it.
     */
    async complete(intent: CompletionIntent, context: EventContext): Promise<PublishedMessageRef | undefined> {
        const ralRegistry = RALRegistry.getInstance();

        // RACE CONDITION GUARD: Check if this agent+conversation was killed
        // ISSUE 3 FIX: Using agent-scoped check ensures killing one agent
        // doesn't suppress completions for other agents in the same conversation.
        if (ralRegistry.isAgentConversationKilled(this.agent.pubkey, context.conversationId)) {
            logger.warn("[AgentPublisher.complete] Skipping completion - agent+conversation was killed", {
                agent: this.agent.slug,
                agentPubkey: shortenPubkey(this.agent.pubkey),
                conversationId: shortenConversationId(context.conversationId),
                ralNumber: context.ralNumber,
            });

            trace.getActiveSpan()?.addEvent("publisher.completion_skipped_killed", {
                "agent.slug": this.agent.slug,
                "agent.pubkey": shortenPubkey(this.agent.pubkey),
                "conversation.id": shortenConversationId(context.conversationId),
                "ral.number": context.ralNumber,
            });

            return undefined;
        }

        const enhancedContext = this.consumeAndEnhanceContext(context);

        // For completion events, include the total accumulated runtime for the entire RAL
        // This allows delegation aggregation to get the correct total runtime
        const totalRuntime = ralRegistry.getAccumulatedRuntime(
            this.agent.pubkey,
            context.conversationId,
            context.ralNumber
        );

        // completionRecipientPubkey is pre-resolved by createEventContext (layer 3)
        // from the delegation chain stored in ConversationStore. This avoids a layer
        // violation - AgentPublisher (layer 2) cannot import ConversationStore directly.
        const contextWithExtras: EventContext = {
            ...enhancedContext,
            llmRuntimeTotal: totalRuntime > 0 ? totalRuntime : undefined,
        };

        const event = this.encoder.encodeCompletion(intent, contextWithExtras);

        injectTraceContext(event);
        await this.agent.sign(event);
        await this.safePublish(event, "completion");

        return this.toPublishedMessageRef(event);
    }

    /**
     * Publish a conversation event (mid-loop response without p-tag).
     * Used when agent has text output but delegations are still pending.
     */
    async conversation(intent: ConversationIntent, context: EventContext): Promise<PublishedMessageRef> {
        const enhancedContext = this.consumeAndEnhanceContext(context);
        const event = this.encoder.encodeConversation(intent, enhancedContext);

        injectTraceContext(event);
        await this.agent.sign(event);
        await this.safePublish(event, "conversation");

        return this.toPublishedMessageRef(event);
    }

    async sendMessage(
        intent: TransportMessageIntent,
        context: EventContext
    ): Promise<PublishedMessageRef> {
        const enhancedContext = this.consumeAndEnhanceContext(context);
        const event = new NDKEvent(getNDK());
        event.kind = NDKKind.Text;
        event.content = intent.content;
        if (enhancedContext.rootEvent.id) {
            event.tag(["e", enhancedContext.rootEvent.id, "", "root"]);
        }
        event.tag(["tenex:egress", "telegram"]);
        event.tag(["tenex:channel", intent.channelId]);
        this.encoder.addStandardTags(event, enhancedContext);

        injectTraceContext(event);
        await this.agent.sign(event);
        await this.safePublish(event, "send_message");

        const ref = this.toPublishedMessageRef(event);
        return {
            ...ref,
            transport: "telegram",
            envelope: {
                ...ref.envelope,
                transport: "telegram",
                channel: {
                    ...ref.envelope.channel,
                    id: intent.channelId,
                    transport: "telegram",
                },
                message: {
                    ...ref.envelope.message,
                    transport: "telegram",
                },
            },
        };
    }

    /**
     * Publish a delegation event
     */
    async delegate(config: DelegateConfig, context: EventContext): Promise<string> {
        this.assertConversationId(context, "delegation");
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

        if (config.team) {
            event.tags.push(["team", config.team]);
        }

        // Add skill tags for the delegated agent (deduplicated for robustness)
        if (config.skills && config.skills.length > 0) {
            const uniqueSkills = [...new Set(config.skills)];
            for (const skillId of uniqueSkills) {
                event.tags.push(["skill", skillId]);
            }
        }

        if (config.variant) {
            event.tags.push(["variant", config.variant]);
        }

        // Add standard metadata (project tag, model, cost, execution time, etc)
        this.encoder.addStandardTags(event, enhancedContext);

        // Forward branch and team tags from triggering event if not explicitly set
        if (!config.branch && !config.team) {
            this.encoder.forwardBranchTag(event, enhancedContext);
            this.encoder.forwardTeamTag(event, enhancedContext);
        } else {
            if (!config.branch) {
                this.encoder.forwardBranchTag(event, enhancedContext);
            }
            if (!config.team) {
                this.encoder.forwardTeamTag(event, enhancedContext);
            }
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
     * Returns the published NDKEvent so callers can create a ConversationStore.
     */
    async ask(config: AskConfig, context: EventContext): Promise<PublishedMessageRef> {
        this.assertConversationId(context, "delegation");
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

        // Forward branch and team tags from triggering event
        this.encoder.forwardBranchTag(event, enhancedContext);
        this.encoder.forwardTeamTag(event, enhancedContext);

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

        return this.toPublishedMessageRef(event);
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
        event.tags.push(["e", params.delegationEventId, "", "root"]);

        // Reply to specific response event if provided (for threading)
        if (params.replyToEventId) {
            event.tags.push(["e", params.replyToEventId, "", "reply"]);
        }

        // Add standard metadata (project tag, model, cost, execution time, runtime, etc)
        this.encoder.addStandardTags(event, enhancedContext);

        // Forward branch and team tags from the triggering event when not explicitly set
        this.encoder.forwardBranchTag(event, enhancedContext);
        this.encoder.forwardTeamTag(event, enhancedContext);

        injectTraceContext(event);
        await this.agent.sign(event);
        await this.safePublish(event, "followup");

        return event.id;
    }

    /**
     * Publish an error event.
     * Creates and publishes an error notification event.
     */
    async error(intent: ErrorIntent, context: EventContext): Promise<PublishedMessageRef> {
        const enhancedContext = this.consumeAndEnhanceContext(context);
        const event = this.encoder.encodeError(intent, enhancedContext);

        injectTraceContext(event);
        await this.agent.sign(event);
        await this.safePublish(event, "error");

        return this.toPublishedMessageRef(event);
    }

    /**
     * Publish a lesson learned event.
     */
    async lesson(intent: LessonIntent, context: EventContext): Promise<PublishedMessageRef> {
        const enhancedContext = this.consumeAndEnhanceContext(context);
        const lessonEvent = this.encoder.encodeLesson(intent, enhancedContext, this.agent);

        injectTraceContext(lessonEvent);
        await this.agent.sign(lessonEvent);
        await this.safePublish(lessonEvent, "lesson");

        return this.toPublishedMessageRef(lessonEvent);
    }

    /**
     * Publish a tool usage event.
     * Creates and publishes an event with tool name and output tags.
     */
    async toolUse(intent: ToolUseIntent, context: EventContext): Promise<PublishedMessageRef> {
        const enhancedContext = this.consumeAndEnhanceContext(context);
        const event = this.encoder.encodeToolUse(intent, enhancedContext);

        injectTraceContext(event);
        await this.agent.sign(event);
        await this.safePublish(event, `tool:${intent.toolName}`);

        return this.toPublishedMessageRef(event);
    }

    /**
     * Publish an ephemeral stream text-delta event.
     * Best-effort only: failures are logged and swallowed to avoid disrupting execution.
     *
     * IMPORTANT: This path intentionally does NOT consume RAL runtime counters.
     * Runtime accounting remains tied to persistent kind:1 publications.
     */
    async streamTextDelta(intent: StreamTextDeltaIntent, context: EventContext): Promise<void> {
        try {
            const event = this.encoder.encodeStreamTextDelta(intent, context);
            injectTraceContext(event);
            await this.agent.sign(event);
            await enqueueSignedEventForRustPublish(event, {
                correlationId: "agent_stream_delta",
                projectId: event.tags.find((tag) => tag[0] === "a")?.[1] ?? "agent-stream-delta",
                conversationId: context.conversationId,
                requestId: `agent-stream-delta:${context.conversationId}:${intent.sequence}:${event.id}`,
                waitForRelayOk: false,
            });
        } catch (error) {
            logger.warn("[AgentPublisher.streamTextDelta] Failed to publish stream delta (best-effort)", {
                error: error instanceof Error ? error.message : String(error),
                agent: this.agent.slug,
                conversationId: shortenConversationId(context.conversationId),
                ralNumber: context.ralNumber,
                sequence: intent.sequence,
                deltaLength: intent.delta.length,
            });
        }
    }
}
