import type { AgentRuntimePublisher } from "@/events/runtime/AgentRuntimePublisher";
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
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { TelegramDeliveryService } from "@/services/telegram/TelegramDeliveryService";

export class TelegramRuntimePublisher implements AgentRuntimePublisher {
    private readonly nostrPublisher: AgentPublisher;

    constructor(
        private readonly agent: RuntimePublishAgent,
        private readonly telegramDeliveryService: TelegramDeliveryService = new TelegramDeliveryService()
    ) {
        this.nostrPublisher = new AgentPublisher(agent);
    }

    async complete(intent: CompletionIntent, context: EventContext): Promise<NDKEvent | undefined> {
        try {
            const event = await this.nostrPublisher.complete(intent, context);
            await this.deliverTelegramReply(context, intent.content, "complete");
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

    async conversation(intent: ConversationIntent, context: EventContext): Promise<NDKEvent> {
        return this.nostrPublisher.conversation(intent, context);
    }

    async delegate(config: DelegateConfig, context: EventContext): Promise<string> {
        return this.nostrPublisher.delegate(config, context);
    }

    async ask(config: AskConfig, context: EventContext): Promise<NDKEvent> {
        const content = `${config.title}\n\n${config.context}`;
        try {
            const event = await this.nostrPublisher.ask(config, context);
            await this.deliverTelegramReply(context, content, "ask");
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

    async error(intent: ErrorIntent, context: EventContext): Promise<NDKEvent> {
        try {
            const event = await this.nostrPublisher.error(intent, context);
            await this.deliverTelegramReply(context, intent.message, "error");
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

    async lesson(intent: LessonIntent, context: EventContext): Promise<NDKEvent> {
        return this.nostrPublisher.lesson(intent, context);
    }

    async toolUse(intent: ToolUseIntent, context: EventContext): Promise<NDKEvent> {
        return this.nostrPublisher.toolUse(intent, context);
    }

    async streamTextDelta(intent: StreamTextDeltaIntent, context: EventContext): Promise<void> {
        return this.nostrPublisher.streamTextDelta(intent, context);
    }

    async delegationMarker(intent: DelegationMarkerIntent): Promise<NDKEvent> {
        return this.nostrPublisher.delegationMarker(intent);
    }

    private async deliverTelegramReply(
        context: EventContext,
        content: string,
        reason: "ask" | "complete" | "error"
    ): Promise<boolean> {
        if (!this.telegramDeliveryService.canHandle(this.agent, context)) {
            return false;
        }

        try {
            await this.telegramDeliveryService.sendReply(this.agent, context, content);
            return true;
        } catch (error) {
            logger.warn("[TelegramRuntimePublisher] Failed to deliver Telegram reply", {
                agentSlug: this.agent.slug,
                conversationId: context.conversationId,
                reason,
                error: error instanceof Error ? error.message : String(error),
            });
            return false;
        }
    }

    private async recoverPublishFailure(
        error: unknown,
        context: EventContext,
        content: string,
        reason: "ask" | "complete" | "error"
    ): Promise<NDKEvent | undefined> {
        if (!isAgentPublishError(error)) {
            return undefined;
        }

        const delivered = await this.deliverTelegramReply(context, content, reason);
        if (!delivered) {
            return undefined;
        }

        logger.warn("[TelegramRuntimePublisher] Recovered Telegram delivery after Nostr publish failure", {
            agentSlug: this.agent.slug,
            conversationId: context.conversationId,
            reason,
            eventType: error.eventType,
            eventId: error.event.id,
            error: error.message,
        });

        return error.event;
    }
}
