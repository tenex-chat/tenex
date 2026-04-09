import type {
    AgentRuntimePublisher,
    PublishedMessageRef,
} from "@/events/runtime/AgentRuntimePublisher";
import type { AgentRuntimePublisherFactory } from "@/events/runtime/AgentRuntimePublisherFactory";
import type { RuntimePublishAgent } from "@/events/runtime/RuntimeAgent";
import type { InboundEnvelope, PrincipalRef } from "@/events/runtime/InboundEnvelope";
import { NDKKind } from "@/nostr/kinds";
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

function fallbackRecipientPrincipal(context: EventContext): PrincipalRef {
    const linkedPubkey =
        context.completionRecipientPubkey ??
        context.triggeringEnvelope.principal.linkedPubkey;

    return {
        id: linkedPubkey ? `nostr:${linkedPubkey}` : context.triggeringEnvelope.principal.id,
        transport: linkedPubkey ? "nostr" : context.triggeringEnvelope.principal.transport,
        ...(linkedPubkey ? { linkedPubkey } : {}),
        displayName: context.triggeringEnvelope.principal.displayName,
        username: context.triggeringEnvelope.principal.username,
        kind: context.triggeringEnvelope.principal.kind,
    };
}

export class RecordingRuntimePublisher implements AgentRuntimePublisher {
    private nextLocalId = 0;

    constructor(
        private readonly agent: RuntimePublishAgent,
        private readonly collector: RuntimePublishCollector
    ) {}

    private createEventId(): string {
        this.nextLocalId += 1;
        return this.nextLocalId.toString(16).padStart(64, "0");
    }

    private createEvent(
        kind: number,
        content: string,
        tags: string[][],
        conversationId?: string
    ): PublishedMessageRef {
        const id = this.createEventId();
        const replyTarget = tags.find((tag) => tag[0] === "e")?.[1];
        const channelId = conversationId ?? replyTarget ?? id;
        const envelope: InboundEnvelope = {
            transport: "local",
            principal: {
                id: `local:${this.agent.pubkey}`,
                transport: "local",
                linkedPubkey: this.agent.pubkey,
                displayName: this.agent.slug,
                kind: "agent",
            },
            channel: {
                id: `local:conversation:${channelId}`,
                transport: "local",
                kind: "conversation",
            },
            message: {
                id: `local:${id}`,
                transport: "local",
                nativeId: id,
                replyToId: replyTarget ? `local:${replyTarget}` : undefined,
            },
            recipients: tags
                .filter((tag) => tag[0] === "p" && typeof tag[1] === "string")
                .map((tag) => ({
                    id: `nostr:${tag[1]}`,
                    transport: "nostr" as const,
                    linkedPubkey: tag[1],
                })),
            content,
            occurredAt: Math.floor(Date.now() / 1000),
            capabilities: [],
            metadata: {
                eventKind: kind,
                eventTagCount: tags.length,
                toolName: tags.find((tag) => tag[0] === "tool")?.[1],
                statusValue: tags.find((tag) => tag[0] === "status")?.[1],
                delegationParentConversationId: tags.find((tag) => tag[0] === "delegation")?.[1],
            },
        };

        return {
            id,
            transport: envelope.transport,
            envelope,
            encodedId: `local:${id}`,
        };
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

    async complete(intent: CompletionIntent, context: EventContext): Promise<PublishedMessageRef | undefined> {
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
        const event = this.createEvent(NDKKind.Text, intent.content, tags, context.conversationId);

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

    async conversation(intent: ConversationIntent, context: EventContext): Promise<PublishedMessageRef> {
        const rootEventId = context.rootEvent.id ?? context.conversationId;
        const event = this.createEvent(NDKKind.Text, intent.content, [["e", rootEventId]], context.conversationId);

        this.record("conversation", context, {
            rootEventId,
            content: intent.content,
            contentLength: intent.content.length,
        });

        return event;
    }

    async delegate(config: DelegateConfig, context: EventContext): Promise<string> {
        const delegationConversationId = this.createEventId();
        this.record("delegate", context, {
            recipient: config.recipient,
            delegationConversationId,
            contentLength: config.content.length,
        });
        return delegationConversationId;
    }

    async ask(config: AskConfig, context: EventContext): Promise<PublishedMessageRef> {
        const content = `${config.title}\n\n${config.context}`;
        const tags: string[][] = [["p", config.recipient]];
        const event = this.createEvent(NDKKind.Text, content, tags, context.conversationId);

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
        const eventId = this.createEventId();
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

    async error(intent: ErrorIntent, context: EventContext): Promise<PublishedMessageRef> {
        const rootEventId = context.rootEvent.id ?? context.conversationId;
        const event = this.createEvent(
            NDKKind.Text,
            intent.message,
            [
                ["error", intent.errorType ?? "execution_error"],
                ["e", rootEventId],
            ],
            context.conversationId
        );

        this.record("error", context, {
            errorType: intent.errorType,
            content: intent.message,
            contentLength: intent.message.length,
        });

        return event;
    }

    async lesson(intent: LessonIntent, context: EventContext): Promise<PublishedMessageRef> {
        const content = `${intent.title}\n\n${intent.lesson}`;
        const rootEventId = context.rootEvent.id ?? context.conversationId;
        const event = this.createEvent(
            NDKKind.AgentLesson,
            content,
            [["e", rootEventId]],
            context.conversationId
        );

        this.record("lesson", context, {
            title: intent.title,
            content,
            contentLength: content.length,
        });

        return event;
    }

    async toolUse(intent: ToolUseIntent, context: EventContext): Promise<PublishedMessageRef> {
        const event = this.createEvent(
            NDKKind.Text,
            intent.content,
            [["tool", intent.toolName]],
            context.conversationId
        );

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
}

export function createRecordingRuntimePublisherFactory(
    collector: RuntimePublishCollector
): AgentRuntimePublisherFactory {
    return (agent) => new RecordingRuntimePublisher(agent, collector);
}
