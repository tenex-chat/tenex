import type {
    AgentRuntimePublisher,
    PublishedMessageRef,
    TransportMessageIntent,
} from "@/events/runtime/AgentRuntimePublisher";
import type { RuntimePublishAgent } from "@/events/runtime/RuntimeAgent";
import { AgentEventEncoder } from "@/nostr/AgentEventEncoder";
import { NDKKind } from "@/nostr/kinds";
import { NostrInboundAdapter } from "@/nostr/NostrInboundAdapter";
import { injectTraceContext } from "@/nostr/trace-context";
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
import { DelegationJournalReader } from "@/services/ral/DelegationJournalReader";
import type { ProjectContext } from "@/services/projects/ProjectContext";
import type { AgentWorkerProtocolMessage } from "@/events/runtime/AgentWorkerProtocol";
import type { InboundEnvelope } from "@/events/runtime/InboundEnvelope";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { getEventHash } from "nostr-tools";
import type { AgentWorkerProtocolEmit } from "./protocol-emitter";

type ExecuteMessage = Extract<AgentWorkerProtocolMessage, { type: "execute" }>;
type PublishRequestMessage = Extract<AgentWorkerProtocolMessage, { type: "publish_request" }>;

interface WorkerProtocolPublisherOptions {
    agent: RuntimePublishAgent;
    projectContext: Pick<ProjectContext, "project" | "agentRegistry">;
    emit: AgentWorkerProtocolEmit;
    execution: ExecuteMessage;
    executionState?: WorkerProtocolPublisherExecutionState;
}

export interface WorkerProtocolPublisherExecutionState {
    silentCompletionRequested: boolean;
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

/**
 * Worker-side publisher that bridges `AgentRuntimePublisher` to the worker↔daemon
 * stdin/stdout protocol.
 *
 * Event tagging is fully delegated to `AgentEventEncoder` (the canonical encoder
 * also used by the daemon-side `AgentPublisher`) so worker-published events match
 * TENEX client expectations. The only responsibility left here is the transport:
 * sign the encoded event, emit a `publish_request` frame, await the daemon's
 * `publish_result` for acceptance, and fan out worker-protocol side-channel
 * messages (`delegation_registered`, `tool_call_completed`,
 * `silent_completion_requested`, `delegation_killed`).
 */
class WorkerProtocolPublisher implements AgentRuntimePublisher {
    private readonly encoder: AgentEventEncoder;
    private readonly inboundAdapter = new NostrInboundAdapter();

    constructor(private readonly options: WorkerProtocolPublisherOptions) {
        this.encoder = new AgentEventEncoder(options.projectContext);
    }

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
        const contextWithExtras: EventContext = {
            ...enhancedContext,
            llmRuntimeTotal: totalRuntime > 0 ? totalRuntime : undefined,
        };

        const event = this.encoder.encodeCompletion(intent, contextWithExtras);
        return this.signAndEmit(event, "complete");
    }

    async conversation(
        intent: ConversationIntent,
        context: EventContext
    ): Promise<PublishedMessageRef> {
        const enhancedContext = this.consumeAndEnhanceContext(context);
        const event = this.encoder.encodeConversation(intent, enhancedContext);
        return this.signAndEmit(event, "conversation", {
            conversationVariant: intent.isReasoning ? "reasoning" : "primary",
        });
    }

    async delegate(config: DelegateConfig, context: EventContext): Promise<string> {
        const enhancedContext = this.consumeAndEnhanceContext(context);
        const event = new NDKEvent();
        event.kind = NDKKind.Text;
        event.content = config.content;

        event.tags.push(["p", config.recipient]);

        if (config.branch) {
            event.tags.push(["branch", config.branch]);
        }

        if (config.team) {
            event.tags.push(["team", config.team]);
        }

        if (config.skills && config.skills.length > 0) {
            const uniqueSkills = [...new Set(config.skills)];
            for (const skillId of uniqueSkills) {
                event.tags.push(["skill", skillId]);
            }
        }

        if (config.variant) {
            event.tags.push(["variant", config.variant]);
        }

        this.encoder.addStandardTags(event, enhancedContext);

        if (!config.branch) {
            this.encoder.forwardBranchTag(event, enhancedContext);
        }
        if (!config.team) {
            this.encoder.forwardTeamTag(event, enhancedContext);
        }

        event.tags.push(["delegation", context.conversationId]);

        const ref = await this.signAndEmit(event, "delegation");

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
        const enhancedContext = this.consumeAndEnhanceContext(context);
        const event = new NDKEvent();
        event.kind = NDKKind.Text;
        event.content = config.context;

        event.tags.push(["title", config.title]);

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

        event.tags.push(["p", config.recipient]);

        this.encoder.addStandardTags(event, enhancedContext);
        this.encoder.forwardBranchTag(event, enhancedContext);
        this.encoder.forwardTeamTag(event, enhancedContext);

        event.tags.push(["ask", "true"]);
        event.tags.push(["t", "ask"]);
        event.tags.push(["delegation", context.conversationId]);

        const ref = await this.signAndEmit(event, "ask");

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
        const enhancedContext = this.consumeAndEnhanceContext(context);
        const event = new NDKEvent();
        event.kind = NDKKind.Text;
        event.content = params.content;

        event.tags.push(["p", params.recipient]);
        event.tags.push(["e", params.delegationEventId, "", "root"]);

        if (params.replyToEventId) {
            event.tags.push(["e", params.replyToEventId, "", "reply"]);
        }

        this.encoder.addStandardTags(event, enhancedContext);
        this.encoder.forwardBranchTag(event, enhancedContext);
        this.encoder.forwardTeamTag(event, enhancedContext);

        const ref = await this.signAndEmit(event, "delegate_followup");

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
        const enhancedContext = this.consumeAndEnhanceContext(context);
        const event = this.encoder.encodeError(intent, enhancedContext);
        return this.signAndEmit(event, "error");
    }

    async lesson(intent: LessonIntent, context: EventContext): Promise<PublishedMessageRef> {
        const enhancedContext = this.consumeAndEnhanceContext(context);
        const lessonEvent = this.encoder.encodeLesson(intent, enhancedContext, this.options.agent);
        return this.signAndEmit(lessonEvent, "lesson");
    }

    async toolUse(intent: ToolUseIntent, context: EventContext): Promise<PublishedMessageRef> {
        const enhancedContext = this.consumeAndEnhanceContext(context);
        const event = this.encoder.encodeToolUse(intent, enhancedContext);
        const ref = await this.signAndEmit(event, "tool_use");

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
        const enhancedContext = this.consumeAndEnhanceContext(context);
        const event = new NDKEvent();
        event.kind = NDKKind.Text;
        event.content = intent.content;
        if (enhancedContext.rootEvent.id) {
            event.tag(["e", enhancedContext.rootEvent.id, "", "root"]);
        }
        event.tag(["tenex:egress", "telegram"]);
        event.tag(["tenex:channel", intent.channelId]);
        this.encoder.addStandardTags(event, enhancedContext);

        const ref = await this.signAndEmit(event, "conversation", {
            conversationVariant: "primary",
            outputTransport: "telegram",
        });

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

    async streamTextDelta(
        intent: StreamTextDeltaIntent,
        context: EventContext
    ): Promise<void> {
        try {
            const event = this.encoder.encodeStreamTextDelta(intent, context);
            await this.signAndEmit(event, "stream_text_delta", { waitForRelayOk: false });
        } catch {
            // Stream deltas are best-effort live updates; final kind:1 snapshots carry the durable result.
        }
    }

    async killDelegation(delegationConversationId: string, reason: string): Promise<void> {
        DelegationJournalReader.getInstance().appendOverlay({
            event: "delegation_killed",
            projectId: this.options.execution.projectId,
            agentPubkey: this.options.execution.agentPubkey,
            conversationId: this.options.execution.conversationId,
            ralNumber: this.options.execution.ralNumber,
            delegationConversationId,
            killedAt: Date.now(),
            reason,
        });
        await this.options.emit({
            type: "delegation_killed",
            correlationId: this.options.execution.correlationId,
            ...this.identity(),
            delegationConversationId,
            reason,
        });
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

        const pendingEntry = {
            delegationConversationId: params.delegationConversationId,
            recipientPubkey: params.recipientPubkey,
            senderPubkey: this.options.agent.pubkey,
            prompt: params.prompt,
            ralNumber: params.context.ralNumber,
            type: params.delegationType,
            ...(params.parentDelegationConversationId
                ? { parentDelegationConversationId: params.parentDelegationConversationId }
                : {}),
            ...(params.followupEventId ? { followupEventId: params.followupEventId } : {}),
            ...(params.suggestions && params.suggestions.length > 0
                ? { suggestions: params.suggestions }
                : {}),
        };
        DelegationJournalReader.getInstance().appendOverlay({
            event: "delegation_registered",
            projectId: this.options.execution.projectId,
            agentPubkey: this.options.execution.agentPubkey,
            conversationId: this.options.execution.conversationId,
            ralNumber: this.options.execution.ralNumber,
            pendingDelegation: pendingEntry,
        });

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

    private async signAndEmit(
        event: NDKEvent,
        runtimeEventClass: PublishRequestMessage["runtimeEventClass"],
        options?: {
            conversationVariant?: PublishRequestMessage["conversationVariant"];
            outputTransport?: PublishedMessageRef["transport"];
            timeoutMs?: number;
            waitForRelayOk?: boolean;
        }
    ): Promise<PublishedMessageRef> {
        injectTraceContext(event);
        await this.options.agent.sign(event);
        const signedEvent = requireSignedPublishEvent(event, this.options.agent.pubkey);
        const requestId = `publish-${signedEvent.id}`;

        await this.options.emit({
            type: "publish_request",
            correlationId: this.options.execution.correlationId,
            ...this.identity(),
            requestId,
            waitForRelayOk: options?.waitForRelayOk ?? true,
            timeoutMs: options?.timeoutMs ?? 30_000,
            runtimeEventClass,
            ...(options?.conversationVariant
                ? { conversationVariant: options.conversationVariant }
                : {}),
            event: signedEvent,
        });

        return this.toPublishedMessageRef(event, options?.outputTransport);
    }

    private toPublishedMessageRef(
        event: NDKEvent,
        outputTransport?: PublishedMessageRef["transport"]
    ): PublishedMessageRef {
        const envelope: InboundEnvelope = this.inboundAdapter.toEnvelope(event);
        return {
            id: event.id ?? envelope.message.nativeId,
            transport: outputTransport ?? envelope.transport,
            envelope,
            ...(event.id ? { encodedId: event.encode() } : {}),
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
