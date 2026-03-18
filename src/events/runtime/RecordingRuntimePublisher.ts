import type { AgentRuntimePublisher } from "@/events/runtime/AgentRuntimePublisher";
import type { AgentRuntimePublisherFactory } from "@/events/runtime/AgentRuntimePublisherFactory";
import type { RuntimePublishAgent } from "@/events/runtime/RuntimeAgent";
import type { PrincipalRef } from "@/events/runtime/InboundEnvelope";
import { NDKKind } from "@/nostr/kinds";
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
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { randomBytes } from "node:crypto";

export interface PublishedRuntimeRecord {
    agentSlug: string;
    conversationId?: string;
    eventId?: string;
    intent:
        | "ask"
        | "complete"
        | "conversation"
        | "delegate"
        | "delegateFollowup"
        | "delegationMarker"
        | "error"
        | "lesson"
        | "streamTextDelta"
        | "toolUse";
    payload: Record<string, string | number | boolean | undefined>;
}

export class RuntimePublishCollector {
    private readonly records: PublishedRuntimeRecord[] = [];

    push(record: PublishedRuntimeRecord): void {
        this.records.push(record);
    }

    list(): PublishedRuntimeRecord[] {
        return [...this.records];
    }
}

function createEventId(): string {
    return randomBytes(32).toString("hex");
}

function fallbackRecipientPrincipal(context: EventContext): PrincipalRef {
    const linkedPubkey =
        context.completionRecipientPubkey ??
        context.triggeringEnvelope.principal.linkedPubkey;

    return {
        id: linkedPubkey ? `nostr:${linkedPubkey}` : context.triggeringEnvelope.principal.id,
        transport: linkedPubkey ? "nostr" : context.triggeringEnvelope.principal.transport,
        linkedPubkey,
        displayName: context.triggeringEnvelope.principal.displayName,
        username: context.triggeringEnvelope.principal.username,
        kind: context.triggeringEnvelope.principal.kind,
    };
}

export class RecordingRuntimePublisher implements AgentRuntimePublisher {
    constructor(
        private readonly agent: RuntimePublishAgent,
        private readonly collector: RuntimePublishCollector
    ) {}

    private createEvent(
        kind: number,
        content: string,
        tags: string[][]
    ): NDKEvent {
        const event = new NDKEvent();
        event.id = createEventId();
        event.kind = kind;
        event.pubkey = this.agent.pubkey;
        event.created_at = Math.floor(Date.now() / 1000);
        event.content = content;
        event.tags = tags;

        return event;
    }

    private record(
        intent: PublishedRuntimeRecord["intent"],
        context: EventContext | undefined,
        payload: PublishedRuntimeRecord["payload"]
    ): void {
        this.collector.push({
            agentSlug: this.agent.slug,
            conversationId: context?.conversationId,
            intent,
            payload,
        });
    }

    async complete(intent: CompletionIntent, context: EventContext): Promise<NDKEvent | undefined> {
        const recipientPrincipal =
            context.completionRecipientPrincipal ?? fallbackRecipientPrincipal(context);
        const recipient =
            recipientPrincipal.linkedPubkey ??
            context.completionRecipientPubkey;
        const rootEventId = context.rootEvent.id ?? context.conversationId;
        const tags: string[][] = [
            ["recipient-principal", recipientPrincipal.id],
            ["status", "completed"],
            ["e", rootEventId],
        ];
        if (recipient) {
            tags.unshift(["p", recipient]);
        }
        const event = this.createEvent(NDKKind.Text, intent.content, tags);

        this.record("complete", context, {
            recipient,
            recipientPrincipalId: recipientPrincipal.id,
            recipientTransport: recipientPrincipal.transport,
            rootEventId,
            content: intent.content,
            contentLength: intent.content.length,
        });

        return event;
    }

    async conversation(intent: ConversationIntent, context: EventContext): Promise<NDKEvent> {
        const rootEventId = context.rootEvent.id ?? context.conversationId;
        const event = this.createEvent(NDKKind.Text, intent.content, [["e", rootEventId]]);

        this.record("conversation", context, {
            rootEventId,
            content: intent.content,
            contentLength: intent.content.length,
        });

        return event;
    }

    async delegate(config: DelegateConfig, context: EventContext): Promise<string> {
        const delegationConversationId = createEventId();
        this.record("delegate", context, {
            recipient: config.recipient,
            delegationConversationId,
            contentLength: config.content.length,
        });
        return delegationConversationId;
    }

    async ask(config: AskConfig, context: EventContext): Promise<NDKEvent> {
        const content = `${config.title}\n\n${config.context}`;
        const tags: string[][] = [["p", config.recipient]];
        const event = this.createEvent(NDKKind.Text, content, tags);

        this.record("ask", context, {
            recipient: config.recipient,
            title: config.title,
            questionCount: config.questions.length,
            content,
            contentLength: content.length,
        });

        return event;
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
        const eventId = createEventId();
        this.record("delegateFollowup", context, {
            recipient: params.recipient,
            delegationEventId: params.delegationEventId,
            replyToEventId: params.replyToEventId,
            followupEventId: eventId,
            content: params.content,
            contentLength: params.content.length,
        });
        return eventId;
    }

    async error(intent: ErrorIntent, context: EventContext): Promise<NDKEvent> {
        const rootEventId = context.rootEvent.id ?? context.conversationId;
        const event = this.createEvent(
            NDKKind.Text,
            intent.message,
            [
                ["error", intent.errorType ?? "execution_error"],
                ["e", rootEventId],
            ]
        );

        this.record("error", context, {
            errorType: intent.errorType,
            content: intent.message,
            contentLength: intent.message.length,
        });

        return event;
    }

    async lesson(intent: LessonIntent, context: EventContext): Promise<NDKEvent> {
        const content = `${intent.title}\n\n${intent.lesson}`;
        const rootEventId = context.rootEvent.id ?? context.conversationId;
        const event = this.createEvent(
            NDKKind.AgentLesson,
            content,
            [["e", rootEventId]]
        );

        this.record("lesson", context, {
            title: intent.title,
            content,
            contentLength: content.length,
        });

        return event;
    }

    async toolUse(intent: ToolUseIntent, context: EventContext): Promise<NDKEvent> {
        const event = this.createEvent(NDKKind.Text, intent.content, [["tool", intent.toolName]]);

        this.record("toolUse", context, {
            toolName: intent.toolName,
            content: intent.content,
            contentLength: intent.content.length,
        });

        return event;
    }

    async streamTextDelta(intent: StreamTextDeltaIntent, context: EventContext): Promise<void> {
        this.record("streamTextDelta", context, {
            delta: intent.delta,
            deltaLength: intent.delta.length,
            sequence: intent.sequence,
        });
    }

    async delegationMarker(intent: DelegationMarkerIntent): Promise<NDKEvent> {
        const event = this.createEvent(
            NDKKind.Text,
            "",
            [
                ["delegation-marker", intent.status],
                ["delegation-conversation", intent.delegationConversationId],
            ]
        );

        this.collector.push({
            agentSlug: this.agent.slug,
            conversationId: intent.parentConversationId,
            eventId: event.id,
            intent: "delegationMarker",
            payload: {
                delegationConversationId: intent.delegationConversationId,
                parentConversationId: intent.parentConversationId,
                status: intent.status,
            },
        });

        return event;
    }
}

export function createRecordingRuntimePublisherFactory(
    collector: RuntimePublishCollector
): AgentRuntimePublisherFactory {
    return (agent) => new RecordingRuntimePublisher(agent, collector);
}
