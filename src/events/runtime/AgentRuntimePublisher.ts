import type { InboundEnvelope, RuntimeTransport } from "@/events/runtime/InboundEnvelope";
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
} from "@/nostr/types";

export interface PublishedMessageRef {
    id: string;
    transport: RuntimeTransport;
    envelope: InboundEnvelope;
    encodedId?: string;
}

export interface TransportMessageIntent {
    channelId: string;
    content: string;
}

/**
 * Transport-neutral publishing contract for the conversation/runtime plane.
 *
 * This contract preserves the current runtime message intents and event context
 * while removing the executor/tool layers' dependency on the concrete
 * `AgentPublisher` implementation.
 */
export interface AgentRuntimePublisher {
    complete(intent: CompletionIntent, context: EventContext): Promise<PublishedMessageRef | undefined>;
    conversation(intent: ConversationIntent, context: EventContext): Promise<PublishedMessageRef>;
    delegate(config: DelegateConfig, context: EventContext): Promise<string>;
    ask(config: AskConfig, context: EventContext): Promise<PublishedMessageRef>;
    delegateFollowup(
        params: {
            recipient: string;
            content: string;
            delegationEventId: string;
            replyToEventId?: string;
        },
        context: EventContext
    ): Promise<string>;
    error(intent: ErrorIntent, context: EventContext): Promise<PublishedMessageRef>;
    lesson(intent: LessonIntent, context: EventContext): Promise<PublishedMessageRef>;
    toolUse(intent: ToolUseIntent, context: EventContext): Promise<PublishedMessageRef>;
    sendMessage(intent: TransportMessageIntent, context: EventContext): Promise<PublishedMessageRef>;
    streamTextDelta(intent: StreamTextDeltaIntent, context: EventContext): Promise<void>;
}
