import type {
    AgentRuntimePublisher,
    PublishedMessageRef,
    TransportMessageIntent,
} from "@/events/runtime/AgentRuntimePublisher";
import type { RuntimePublishAgent } from "@/events/runtime/RuntimeAgent";
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
import { PendingDelegationsRegistry, RALRegistry } from "@/services/ral";
import type { PendingDelegation } from "@/services/ral/types";
import type { AgentWorkerProtocolMessage } from "@/events/runtime/AgentWorkerProtocol";
import type { InboundEnvelope, PrincipalRef } from "@/events/runtime/InboundEnvelope";
import type { AgentWorkerProtocolEmit } from "./protocol-emitter";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { getEventHash } from "nostr-tools";

type ExecuteMessage = Extract<AgentWorkerProtocolMessage, { type: "execute" }>;
type PublishResultMessage = Extract<AgentWorkerProtocolMessage, { type: "publish_result" }>;
type PublishRequestMessage = Extract<AgentWorkerProtocolMessage, { type: "publish_request" }>;

interface WorkerProtocolPublisherOptions {
    agent: RuntimePublishAgent;
    emit: AgentWorkerProtocolEmit;
    execution: ExecuteMessage;
    executionState?: WorkerProtocolPublisherExecutionState;
    publishResults?: WorkerProtocolPublishResultSource;
}

export interface WorkerProtocolPublisherExecutionState {
    silentCompletionRequested: boolean;
}

export interface WorkerProtocolPublishResultSource {
    waitForPublishResult(requestId: string, timeoutMs: number): Promise<PublishResultMessage>;
}

export function createWorkerProtocolPublisherFactory(
    options: Omit<WorkerProtocolPublisherOptions, "agent">
) {
    return (agent: RuntimePublishAgent): AgentRuntimePublisher =>
        new WorkerProtocolPublisher({
            ...options,
            agent,
        });
}

class WorkerProtocolPublisher implements AgentRuntimePublisher {
    constructor(private readonly options: WorkerProtocolPublisherOptions) {}

    async complete(
        intent: CompletionIntent,
        context: EventContext
    ): Promise<PublishedMessageRef | undefined> {
        const ralRegistry = RALRegistry.getInstance();

        if (
            ralRegistry.isAgentConversationKilled(
                this.options.agent.pubkey,
                context.conversationId
            )
        ) {
            return undefined;
        }

        const enhancedContext = this.consumeAndEnhanceContext(context);
        const totalRuntime = ralRegistry.getAccumulatedRuntime(
            this.options.agent.pubkey,
            context.conversationId,
            context.ralNumber
        );

        return this.publishTextEvent(intent.content, {
            context: {
                ...enhancedContext,
                llmRuntimeTotal: totalRuntime > 0 ? totalRuntime : undefined,
            },
            runtimeEventClass: "complete",
            status: "completed",
            usage: intent.usage,
            metadata: {
                statusValue: "completed",
            },
        });
    }

    async conversation(
        intent: ConversationIntent,
        context: EventContext
    ): Promise<PublishedMessageRef> {
        return this.publishTextEvent(intent.content, {
            context: this.consumeAndEnhanceContext(context),
            runtimeEventClass: "conversation",
            conversationVariant: intent.isReasoning ? "reasoning" : "primary",
            usage: intent.usage,
            metadata: {},
        });
    }

    async delegate(config: DelegateConfig, context: EventContext): Promise<string> {
        const ref = await this.publishTextEvent(config.content, {
            context: this.consumeAndEnhanceContext(context),
            runtimeEventClass: "delegation",
            recipientPubkey: config.recipient,
            metadata: {
                delegationParentConversationId: context.conversationId,
                branchName: config.branch,
            },
            tags: [
                ["delegation", context.conversationId],
                ...(config.branch ? [["branch", config.branch]] : []),
                ...(config.team ? [["team", config.team]] : []),
                ...(config.variant ? [["variant", config.variant]] : []),
                ...(config.skills ?? []).map((skillId) => ["skill", skillId]),
            ],
        });

        PendingDelegationsRegistry.register(
            this.options.agent.pubkey,
            context.conversationId,
            ref.id
        );

        await this.registerPendingDelegation({
            context,
            delegationConversationId: ref.id,
            recipientPubkey: config.recipient,
            delegationType: "standard",
            prompt: config.content,
            parentDelegationConversationId: config.parentDelegationConversationId,
        });

        return ref.id;
    }

    async ask(config: AskConfig, context: EventContext): Promise<PublishedMessageRef> {
        const ref = await this.publishTextEvent(config.context, {
            context: this.consumeAndEnhanceContext(context),
            runtimeEventClass: "ask",
            recipientPubkey: config.recipient,
            metadata: {
                delegationParentConversationId: context.conversationId,
            },
            tags: [
                ["title", config.title],
                ["ask", "true"],
                ["t", "ask"],
                ["delegation", context.conversationId],
                ...config.questions.map((question) =>
                    question.type === "question"
                        ? [
                              "question",
                              question.title,
                              question.question,
                              ...(question.suggestions ?? []),
                          ]
                        : [
                              "multiselect",
                              question.title,
                              question.question,
                              ...(question.options ?? []),
                          ]
                ),
            ],
        });

        PendingDelegationsRegistry.register(
            this.options.agent.pubkey,
            context.conversationId,
            ref.id
        );

        await this.registerPendingDelegation({
            context,
            delegationConversationId: ref.id,
            recipientPubkey: config.recipient,
            delegationType: "ask",
            prompt: buildAskPrompt(config),
            parentDelegationConversationId: config.parentDelegationConversationId,
            suggestions: config.suggestions,
        });

        return ref;
    }

    async delegateFollowup(
        params: {
            recipient: string;
            content: string;
            delegationEventId: string;
            replyToEventId?: string;
            parentDelegationConversationId?: string;
        },
        context: EventContext
    ): Promise<string> {
        const ref = await this.publishTextEvent(params.content, {
            context: this.consumeAndEnhanceContext(context),
            runtimeEventClass: "delegate_followup",
            recipientPubkey: params.recipient,
            tags: [
                ["e", params.delegationEventId, "", "root"],
                ...(params.replyToEventId
                    ? [["e", params.replyToEventId, "", "reply"]]
                    : []),
            ],
        });

        await this.registerPendingDelegation({
            context,
            delegationConversationId: params.delegationEventId,
            recipientPubkey: params.recipient,
            delegationType: "followup",
            prompt: params.content,
            followupEventId: ref.id,
            parentDelegationConversationId: params.parentDelegationConversationId,
        });

        return ref.id;
    }

    async error(intent: ErrorIntent, context: EventContext): Promise<PublishedMessageRef> {
        return this.publishTextEvent(intent.message, {
            context: this.consumeAndEnhanceContext(context),
            runtimeEventClass: "error",
            status: intent.errorType ?? "execution_error",
            metadata: {
                statusValue: intent.errorType ?? "execution_error",
            },
        });
    }

    async lesson(intent: LessonIntent, context: EventContext): Promise<PublishedMessageRef> {
        return this.publishTextEvent(intent.lesson, {
            context: this.consumeAndEnhanceContext(context),
            runtimeEventClass: "lesson",
            kind: NDKKind.AgentLesson,
            metadata: {},
            tags: [
                ["title", intent.title],
                ...(intent.category ? [["category", intent.category]] : []),
                ...(intent.hashtags ?? []).map((tag) => ["t", tag]),
            ],
        });
    }

    async toolUse(intent: ToolUseIntent, context: EventContext): Promise<PublishedMessageRef> {
        const ref = await this.publishTextEvent(intent.content, {
            context: this.consumeAndEnhanceContext(context),
            runtimeEventClass: "tool_use",
            metadata: {
                toolName: intent.toolName,
            },
            tags: [
                ["tool", intent.toolName],
                ...(intent.referencedEventIds ?? []).map((eventId) => ["q", eventId]),
            ],
        });

        if (intent.toolName === "no_response") {
            if (this.options.executionState) {
                this.options.executionState.silentCompletionRequested = true;
            }
            await this.options.emit({
                type: "silent_completion_requested",
                correlationId: this.options.execution.correlationId,
                ...this.identity(),
                reason: "no_response tool completed",
            });
        }

        await this.options.emit({
            type: "tool_call_completed",
            correlationId: this.options.execution.correlationId,
            ...this.identity(),
            toolCallId: ref.id,
            toolName: intent.toolName,
            durationMs: 0,
            resultSummary: intent.content,
        });

        return ref;
    }

    async sendMessage(
        intent: TransportMessageIntent,
        context: EventContext
    ): Promise<PublishedMessageRef> {
        return this.publishTextEvent(intent.content, {
            context: this.consumeAndEnhanceContext(context),
            runtimeEventClass: "conversation",
            conversationVariant: "primary",
            tags: [
                ["tenex:egress", "telegram"],
                ["tenex:channel", intent.channelId],
            ],
            outputTransport: "telegram",
        });
    }

    async streamTextDelta(
        intent: StreamTextDeltaIntent,
        context: EventContext
    ): Promise<void> {
        try {
            await this.publishTextEvent(intent.delta, {
                context,
                runtimeEventClass: "stream_text_delta",
                kind: NDKKind.TenexStreamTextDelta,
                tags: [
                    ["llm-ral", context.ralNumber.toString()],
                    ["stream-seq", intent.sequence.toString()],
                    ...(context.model ? [["llm-model", context.model]] : []),
                    ...(context.triggeringEnvelope.metadata.branchName
                        ? [["branch", String(context.triggeringEnvelope.metadata.branchName)]]
                        : []),
                ],
                waitForRelayOk: false,
            });
        } catch {
            // Stream deltas are best-effort live updates; final kind:1 snapshots carry the durable result.
        }
    }

    private consumeAndEnhanceContext(context: EventContext): EventContext {
        const ralRegistry = RALRegistry.getInstance();
        const unreportedRuntime = ralRegistry.consumeUnreportedRuntime(
            this.options.agent.pubkey,
            context.conversationId,
            context.ralNumber
        );

        if (context.llmRuntime !== undefined) {
            return context;
        }

        return {
            ...context,
            llmRuntime: unreportedRuntime > 0 ? unreportedRuntime : undefined,
        };
    }

    private async registerPendingDelegation(params: {
        context: EventContext;
        delegationConversationId: string;
        recipientPubkey: string;
        delegationType: "standard" | "ask" | "followup";
        prompt: string;
        parentDelegationConversationId?: string;
        followupEventId?: string;
        suggestions?: string[];
    }): Promise<void> {
        if (!isHexPubkey(params.recipientPubkey)) {
            return;
        }

        const ralRegistry = RALRegistry.getInstance();
        const basePending = {
            delegationConversationId: params.delegationConversationId,
            recipientPubkey: params.recipientPubkey,
            senderPubkey: this.options.agent.pubkey,
            prompt: params.prompt,
            ralNumber: params.context.ralNumber,
            ...(params.parentDelegationConversationId
                ? { parentDelegationConversationId: params.parentDelegationConversationId }
                : {}),
        };
        const pending: PendingDelegation =
            params.delegationType === "followup"
                ? {
                      ...basePending,
                      type: "followup",
                      ...(params.followupEventId ? { followupEventId: params.followupEventId } : {}),
                  }
                : params.delegationType === "ask"
                  ? {
                        ...basePending,
                        type: "ask",
                        ...(params.suggestions && params.suggestions.length > 0
                            ? { suggestions: params.suggestions }
                            : {}),
                    }
                  : { ...basePending, type: "standard" };
        ralRegistry.mergePendingDelegations(
            this.options.agent.pubkey,
            params.context.conversationId,
            params.context.ralNumber,
            [pending]
        );
        if (params.parentDelegationConversationId) {
            ralRegistry.registerPendingSubDelegation(
                params.parentDelegationConversationId,
                pending
            );
        }

        await this.options.emit({
            type: "delegation_registered",
            correlationId: this.options.execution.correlationId,
            ...this.identity(),
            delegationConversationId: params.delegationConversationId,
            recipientPubkey: params.recipientPubkey,
            delegationType: params.delegationType,
            senderPubkey: this.options.agent.pubkey,
            prompt: params.prompt,
            ...(params.parentDelegationConversationId
                ? { parentDelegationConversationId: params.parentDelegationConversationId }
                : {}),
            ...(params.followupEventId ? { followupEventId: params.followupEventId } : {}),
            ...(params.suggestions && params.suggestions.length > 0
                ? { suggestions: params.suggestions }
                : {}),
        });
    }

    private async publishTextEvent(
        content: string,
        options: {
            context: EventContext;
            runtimeEventClass: PublishRequestMessage["runtimeEventClass"];
            conversationVariant?: PublishRequestMessage["conversationVariant"];
            kind?: number;
            status?: string;
            recipientPubkey?: string;
            tags?: string[][];
            usage?: unknown;
            metadata?: Partial<InboundEnvelope["metadata"]>;
            outputTransport?: PublishedMessageRef["transport"];
            waitForRelayOk?: boolean;
            timeoutMs?: number;
        }
    ): Promise<PublishedMessageRef> {
        const kind = options.kind ?? NDKKind.Text;
        const tags = this.buildTags(options);
        const createdAt = Math.floor(Date.now() / 1000);
        const event = new NDKEvent(undefined, {
            kind,
            content,
            tags,
            created_at: createdAt,
        });
        await this.options.agent.sign(event);
        const signedEvent = requireSignedPublishEvent(event, this.options.agent.pubkey);
        const eventId = signedEvent.id;
        const requestId = `publish-${eventId}`;
        const envelope = this.toEnvelope({
            id: eventId,
            kind,
            content,
            tags,
            context: options.context,
            metadata: options.metadata ?? {},
            occurredAt: createdAt,
            transport: options.outputTransport ?? "nostr",
        });

        await this.options.emit({
            type: "publish_request",
            correlationId: this.options.execution.correlationId,
            ...this.identity(),
            requestId,
            waitForRelayOk: options.waitForRelayOk ?? true,
            timeoutMs: options.timeoutMs ?? 30_000,
            runtimeEventClass: options.runtimeEventClass,
            ...(options.conversationVariant
                ? { conversationVariant: options.conversationVariant }
                : {}),
            event: signedEvent,
        });
        await this.waitForPublishAcceptance(
            requestId,
            eventId,
            this.options.publishResults?.waitForPublishResult(requestId, 30_000)
        );

        return {
            id: eventId,
            transport: options.outputTransport ?? "nostr",
            envelope,
        };
    }

    private async waitForPublishAcceptance(
        requestId: string,
        eventId: string,
        publishResult: Promise<PublishResultMessage> | undefined
    ): Promise<void> {
        if (!publishResult) {
            return;
        }

        const result = await publishResult;
        if (result.status === "accepted" || result.status === "published") {
            if (!result.eventIds.includes(eventId)) {
                throw new Error(
                    `Publish result for ${requestId} did not include signed event id ${eventId}`
                );
            }
            return;
        }

        const errorMessage =
            result.error?.message ?? `Publish request ${requestId} ended with ${result.status}`;
        throw new Error(errorMessage);
    }

    private buildTags(options: {
        context: EventContext;
        runtimeEventClass: PublishRequestMessage["runtimeEventClass"];
        status?: string;
        recipientPubkey?: string;
        tags?: string[][];
    }): string[][] {
        const tags: string[][] = [];

        const startsNewConversation =
            options.runtimeEventClass === "delegation" ||
            options.runtimeEventClass === "ask";
        const hasExplicitRootTag = options.tags?.some(
            (tag) => tag[0] === "e" && tag[3] === "root"
        );
        if (!startsNewConversation && !hasExplicitRootTag && options.context.rootEvent.id) {
            tags.push(["e", options.context.rootEvent.id, "", "root"]);
        }

        const projectBinding = options.context.triggeringEnvelope.channel.projectBinding;
        if (projectBinding) {
            tags.push(["a", projectBinding]);
        }

        const recipient =
            options.recipientPubkey ??
            options.context.completionRecipientPubkey ??
            options.context.triggeringEnvelope.principal.linkedPubkey;
        if (recipient) {
            tags.push(["p", recipient]);
        }

        if (options.status) {
            tags.push(["status", options.status]);
        }

        if (options.context.model) {
            tags.push(["model", options.context.model]);
        }

        if (options.context.llmRuntime !== undefined && options.context.llmRuntime > 0) {
            tags.push(["llm-runtime", options.context.llmRuntime.toString(), "ms"]);
        }

        if (
            options.context.llmRuntimeTotal !== undefined &&
            options.context.llmRuntimeTotal > 0
        ) {
            tags.push(["llm-runtime-total", options.context.llmRuntimeTotal.toString(), "ms"]);
        }

        tags.push(...(options.tags ?? []));
        return tags;
    }

    private toEnvelope(params: {
        id: string;
        kind: number;
        content: string;
        tags: string[][];
        context: EventContext;
        metadata: Partial<InboundEnvelope["metadata"]>;
        occurredAt: number;
        transport: PublishedMessageRef["transport"];
    }): InboundEnvelope {
        const agentPrincipal: PrincipalRef = {
            id: `${params.transport}:${this.options.agent.pubkey}`,
            transport: params.transport,
            linkedPubkey: this.options.agent.pubkey,
            displayName: this.options.agent.name,
            kind: "agent",
        };

        const recipientPubkeys = params.tags
            .filter((tag) => tag[0] === "p" && tag[1])
            .map((tag) => tag[1])
            .filter((pubkey): pubkey is string => Boolean(pubkey));
        const recipients =
            params.context.completionRecipientPrincipal &&
            recipientPubkeys.includes(params.context.completionRecipientPrincipal.linkedPubkey ?? "")
                ? [params.context.completionRecipientPrincipal]
                : recipientPubkeys.map((pubkey) => ({
                      id: `nostr:${pubkey}`,
                      transport: "nostr" as const,
                      linkedPubkey: pubkey,
                  }));

        return {
            transport: params.transport,
            principal: agentPrincipal,
            channel: {
                ...params.context.triggeringEnvelope.channel,
                transport: params.transport,
            },
            message: {
                id: `${params.transport}:${params.id}`,
                transport: params.transport,
                nativeId: params.id,
                replyToId: params.context.rootEvent.id
                    ? `${params.transport}:${params.context.rootEvent.id}`
                    : undefined,
            },
            recipients,
            content: params.content,
            occurredAt: params.occurredAt,
            capabilities: ["project-routing-a-tag", "threaded-replies"],
            metadata: {
                eventKind: params.kind,
                eventTagCount: params.tags.length,
                ...params.metadata,
            },
        };
    }

    private identity(): {
        projectId: string;
        agentPubkey: string;
        conversationId: string;
        ralNumber: number;
    } {
        return {
            projectId: this.options.execution.projectId,
            agentPubkey: this.options.execution.agentPubkey,
            conversationId: this.options.execution.conversationId,
            ralNumber: this.options.execution.ralNumber,
        };
    }
}

function isHexPubkey(value: string): boolean {
    return /^[0-9a-f]{64}$/.test(value);
}

function buildAskPrompt(config: AskConfig): string {
    const questionSummary = config.questions
        .map((question) => `[${question.title}] ${question.question}`)
        .join("\n");
    return `${config.title}\n\n${config.context}\n\n---\n\n${questionSummary}`;
}

function requireSignedPublishEvent(
    event: NDKEvent,
    expectedPubkey: string
): {
    id: string;
    pubkey: string;
    kind: number;
    content: string;
    tags: string[][];
    created_at: number;
    sig: string;
} {
    if (!event.id || !event.pubkey || !event.sig || event.created_at === undefined) {
        throw new Error("Agent signing did not produce a complete Nostr event");
    }

    if (event.pubkey !== expectedPubkey) {
        throw new Error("Agent signing produced an event for the wrong pubkey");
    }

    const expectedId = getEventHash({
        pubkey: event.pubkey,
        created_at: event.created_at,
        kind: event.kind,
        tags: event.tags,
        content: event.content,
    });
    if (event.id !== expectedId) {
        throw new Error("Agent signing produced an event with an invalid NIP-01 id");
    }

    return {
        id: event.id,
        pubkey: event.pubkey,
        kind: event.kind,
        content: event.content,
        tags: event.tags.map((tag) => [...tag]),
        created_at: event.created_at,
        sig: event.sig,
    };
}
