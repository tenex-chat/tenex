import type {
    AgentRuntimePublisher,
    PublishedMessageRef,
} from "@/events/runtime/AgentRuntimePublisher";
import type { RuntimePublishAgent } from "@/events/runtime/RuntimeAgent";
import { AgentPublisher } from "@/nostr/AgentPublisher";
import { isAgentPublishError } from "@/nostr/AgentPublishError";
import type {
    AskConfig,
    CompletionIntent,
    ConversationIntent,
    DelegateConfig,
    DelegationMarkerIntent,
    ErrorIntent,
    EventContext,
    LessonIntent,
    StreamTextDeltaIntent,
    ToolUseIntent,
} from "@/nostr/types";
import { PendingDelegationsRegistry } from "@/services/ral";
import { withActiveTraceLogFields } from "@/telemetry/TelegramTelemetry";
import { logger } from "@/utils/logger";
import { trace } from "@opentelemetry/api";
import { TelegramDeliveryService } from "@/services/telegram/TelegramDeliveryService";
import { renderTelegramToolPublication } from "@/services/telegram/telegram-runtime-tool-publications";

type TelegramPublishReason = "ask" | "complete" | "conversation" | "error" | "toolUse";

export class TelegramRuntimePublisherService implements AgentRuntimePublisher {
    private readonly nostrPublisher: AgentPublisher;

    constructor(
        private readonly agent: RuntimePublishAgent,
        private readonly telegramDeliveryService: TelegramDeliveryService = new TelegramDeliveryService()
    ) {
        this.nostrPublisher = new AgentPublisher(agent);
    }

    async complete(intent: CompletionIntent, context: EventContext): Promise<PublishedMessageRef | undefined> {
        try {
            const event = await this.nostrPublisher.complete(intent, context);
            trace.getActiveSpan()?.addEvent("telegram.runtime_published", {
                "telegram.publish.reason": "complete",
                "nostr.event.id": event?.id ?? "",
            });
            await this.deliverTelegramMessage(context, intent.content, "complete");
            return event;
        } catch (error) {
            const recoveredEvent = await this.recoverPublishFailure(
                error,
                context,
                intent.content,
                "complete"
            );
            if (recoveredEvent) {
                return recoveredEvent;
            }
            throw error;
        }
    }

    async conversation(intent: ConversationIntent, context: EventContext): Promise<PublishedMessageRef> {
        try {
            const event = await this.nostrPublisher.conversation(intent, context);
            trace.getActiveSpan()?.addEvent("telegram.runtime_published", {
                "telegram.publish.reason": "conversation",
                "nostr.event.id": event.id,
            });

            // Check if we should publish to Telegram based on config
            const shouldPublishToTelegram = intent.isReasoning
                ? this.agent.telegram?.publishReasoningToTelegram ?? false
                : this.agent.telegram?.publishConversationToTelegram ?? false;

            if (shouldPublishToTelegram) {
                await this.deliverTelegramMessage(context, intent.content, "conversation");
            }

            return event;
        } catch (error) {
            const recoveredEvent = await this.recoverPublishFailure(
                error,
                context,
                intent.content,
                "conversation"
            );
            if (recoveredEvent) {
                return recoveredEvent;
            }
            throw error;
        }
    }

    async delegate(config: DelegateConfig, context: EventContext): Promise<string> {
        return this.nostrPublisher.delegate(config, context);
    }

    async ask(config: AskConfig, context: EventContext): Promise<PublishedMessageRef> {
        const content = `${config.title}\n\n${config.context}`;
        try {
            const event = await this.nostrPublisher.ask(config, context);
            trace.getActiveSpan()?.addEvent("telegram.runtime_published", {
                "telegram.publish.reason": "ask",
                "nostr.event.id": event.id,
            });
            await this.deliverTelegramMessage(context, content, "ask");
            return event;
        } catch (error) {
            const recoveredEvent = await this.recoverPublishFailure(error, context, content, "ask");
            if (recoveredEvent) {
                PendingDelegationsRegistry.register(this.agent.pubkey, context.conversationId, recoveredEvent.id);
                return recoveredEvent;
            }
            throw error;
        }
    }

    async delegateFollowup(
        params: {
            recipient: string;
            content: string;
            delegationEventId: string;
            replyToEventId?: string;
        },
        context: EventContext
    ): Promise<string> {
        return this.nostrPublisher.delegateFollowup(params, context);
    }

    async error(intent: ErrorIntent, context: EventContext): Promise<PublishedMessageRef> {
        try {
            const event = await this.nostrPublisher.error(intent, context);
            trace.getActiveSpan()?.addEvent("telegram.runtime_published", {
                "telegram.publish.reason": "error",
                "nostr.event.id": event.id,
            });
            await this.deliverTelegramMessage(context, intent.message, "error");
            return event;
        } catch (error) {
            const recoveredEvent = await this.recoverPublishFailure(
                error,
                context,
                intent.message,
                "error"
            );
            if (recoveredEvent) {
                return recoveredEvent;
            }
            throw error;
        }
    }

    async lesson(intent: LessonIntent, context: EventContext): Promise<PublishedMessageRef> {
        return this.nostrPublisher.lesson(intent, context);
    }

    async toolUse(intent: ToolUseIntent, context: EventContext): Promise<PublishedMessageRef> {
        const telegramContent = renderTelegramToolPublication(intent);

        try {
            const event = await this.nostrPublisher.toolUse(intent, context);
            trace.getActiveSpan()?.addEvent("telegram.runtime_published", {
                "telegram.publish.reason": "toolUse",
                "nostr.event.id": event.id,
                "tool.name": intent.toolName,
            });
            if (telegramContent) {
                await this.deliverTelegramMessage(context, telegramContent, "toolUse");
            }
            return event;
        } catch (error) {
            if (!telegramContent) {
                throw error;
            }

            const recoveredEvent = await this.recoverPublishFailure(
                error,
                context,
                telegramContent,
                "toolUse"
            );
            if (recoveredEvent) {
                return recoveredEvent;
            }
            throw error;
        }
    }

    async streamTextDelta(intent: StreamTextDeltaIntent, context: EventContext): Promise<void> {
        return this.nostrPublisher.streamTextDelta(intent, context);
    }

    async delegationMarker(intent: DelegationMarkerIntent): Promise<PublishedMessageRef> {
        return this.nostrPublisher.delegationMarker(intent);
    }

    private async deliverTelegramMessage(
        context: EventContext,
        content: string,
        reason: TelegramPublishReason
    ): Promise<boolean> {
        if (!this.telegramDeliveryService.canHandle(this.agent, context)) {
            return false;
        }

        try {
            trace.getActiveSpan()?.addEvent("telegram.delivery.requested", {
                "telegram.delivery.reason": reason,
                "conversation.id": context.conversationId,
            });
            await this.telegramDeliveryService.sendReply(this.agent, context, content);
            logger.info("[TelegramRuntimePublisherService] Delivered Telegram reply", withActiveTraceLogFields({
                agentSlug: this.agent.slug,
                conversationId: context.conversationId,
                reason,
                content,
            }));
            return true;
        } catch (error) {
            logger.warn("[TelegramRuntimePublisherService] Failed to deliver Telegram reply", withActiveTraceLogFields({
                agentSlug: this.agent.slug,
                conversationId: context.conversationId,
                reason,
                content,
                error: error instanceof Error ? error.message : String(error),
            }));
            return false;
        }
    }

    private async recoverPublishFailure(
        error: unknown,
        context: EventContext,
        content: string,
        reason: TelegramPublishReason
    ): Promise<PublishedMessageRef | undefined> {
        if (!isAgentPublishError(error)) {
            return undefined;
        }

        const delivered = await this.deliverTelegramMessage(context, content, reason);
        if (!delivered) {
            return undefined;
        }

        logger.warn("[TelegramRuntimePublisherService] Recovered Telegram delivery after Nostr publish failure", withActiveTraceLogFields({
            agentSlug: this.agent.slug,
            conversationId: context.conversationId,
            reason,
            eventType: error.eventType,
            eventId: error.event.id,
            error: error.message,
        }));

        return error.event;
    }
}
