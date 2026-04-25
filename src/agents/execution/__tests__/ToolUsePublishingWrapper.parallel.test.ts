/**
 * Regression test: parallel delegate tool calls each publish their own tool_use
 * event with the correct q-tag pointing at their own delegationEventId.
 *
 * The bug this catches: when two delegate tools execute concurrently, the old
 * listener-driven path raced against worker exit and either merged both event
 * IDs into one call, called toolUse only once, or swapped the IDs between the
 * two calls. The wrapper captures each call's result within its own execute()
 * closure, so each publish is isolated.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { ConversationStore } from "@/conversations/ConversationStore";
import type { AgentRuntimePublisher, PublishedMessageRef } from "@/events/runtime/AgentRuntimePublisher";
import type { InboundEnvelope } from "@/events/runtime/InboundEnvelope";
import { ToolExecutionTracker } from "../ToolExecutionTracker";
import type { FullRuntimeContext } from "../types";
import * as toolUsePublishingModule from "../ToolUsePublishingWrapper";

mock.module("@/utils/logger", () => ({
    logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        warning: () => undefined,
        error: () => undefined,
        success: () => undefined,
        isLevelEnabled: () => false,
        initDaemonLogging: async () => undefined,
        writeToWarnLog: () => undefined,
    },
}));

mock.module("@opentelemetry/api", () => ({
    trace: {
        getActiveSpan: () => undefined,
        getTracer: () => ({
            startSpan: () => ({
                end: () => undefined,
                setAttribute: () => undefined,
                setStatus: () => undefined,
                addEvent: () => undefined,
                recordException: () => undefined,
            }),
            startActiveSpan: (_name: string, fn: (span: unknown) => unknown) =>
                fn({
                    end: () => undefined,
                    setAttribute: () => undefined,
                    setStatus: () => undefined,
                    addEvent: () => undefined,
                    recordException: () => undefined,
                }),
        }),
    },
}));

const { wrapToolsWithToolUsePublishing } = toolUsePublishingModule;

function makePublishedRef(id: string): PublishedMessageRef {
    return {
        id,
        transport: "nostr",
        envelope: {
            transport: "nostr",
            principal: {
                id: "mock-pubkey",
                transport: "nostr",
                linkedPubkey: "mock-pubkey",
                kind: "agent",
            },
            channel: {
                id: "mock-conv",
                transport: "nostr",
                kind: "conversation",
            },
            message: { id, transport: "nostr", nativeId: id },
            recipients: [],
            content: "",
            occurredAt: Math.floor(Date.now() / 1000),
            capabilities: [],
            metadata: {
                eventKind: 1,
                eventTagCount: 0,
                replyTargets: [],
                articleReferences: [],
                skillEventIds: [],
            },
        } satisfies InboundEnvelope,
    };
}

function buildContext(agentPublisher: AgentRuntimePublisher): FullRuntimeContext {
    const triggeringEnvelope: InboundEnvelope = {
        transport: "nostr",
        principal: {
            id: "user-pubkey",
            transport: "nostr",
            linkedPubkey: "user-pubkey",
            kind: "human",
        },
        channel: { id: "conv-parallel-test", transport: "nostr", kind: "conversation" },
        message: {
            id: "trigger-event-id",
            transport: "nostr",
            nativeId: "trigger-event-id",
        },
        recipients: [],
        content: "test trigger",
        occurredAt: Math.floor(Date.now() / 1000),
        capabilities: [],
        metadata: {
            eventKind: 1,
            eventTagCount: 0,
            replyTargets: [],
            articleReferences: [],
            skillEventIds: [],
        },
    };

    const conversationStore = {
        id: "conv-parallel-test",
        getRootEventId: () => "conv-parallel-test",
        getAllMessages: () => [],
        metadata: {},
    } as any;

    return {
        agent: {
            name: "Test Agent",
            slug: "test-agent",
            pubkey: "a".repeat(64),
            llmConfig: "test-model",
            tools: [],
            category: "orchestrator",
        },
        conversationId: "conv-parallel-test",
        projectBasePath: "/tmp/test",
        workingDirectory: "/tmp/test",
        currentBranch: "main",
        triggeringEnvelope,
        agentPublisher,
        ralNumber: 1,
        conversationStore,
        getConversation: () => conversationStore,
    } as unknown as FullRuntimeContext;
}

describe("wrapToolsWithToolUsePublishing — parallel delegate calls", () => {
    beforeEach(() => {
        spyOn(ConversationStore, "addEnvelope").mockResolvedValue(undefined as never);
    });

    afterEach(() => {
        mock.restore();
    });

    it("publishes toolUse exactly twice when two delegate tools execute in parallel, each with its own delegationEventId", async () => {
        const toolUseCallArgs: Array<{ referencedEventIds: string[] | undefined }> = [];

        const agentPublisher: AgentRuntimePublisher = {
            toolUse: mock(async (intent) => {
                toolUseCallArgs.push({ referencedEventIds: intent.referencedEventIds });
                return makePublishedRef(`tool-use-event-${toolUseCallArgs.length}`);
            }),
            complete: mock(async () => undefined),
            conversation: mock(async () => makePublishedRef("conv-ref")),
            delegate: mock(async () => "delegate-ref"),
            ask: mock(async () => makePublishedRef("ask-ref")),
            delegateFollowup: mock(async () => "followup-ref"),
            error: mock(async () => makePublishedRef("error-ref")),
            lesson: mock(async () => makePublishedRef("lesson-ref")),
            streamTextDelta: mock(async () => undefined),
        } as unknown as AgentRuntimePublisher;

        const tracker = new ToolExecutionTracker();
        const context = buildContext(agentPublisher);

        const delegationIdA = "a".repeat(64);
        const delegationIdB = "b".repeat(64);

        const tools = {
            delegate: {
                execute: async (_input: unknown) => ({
                    success: true,
                    delegationEventId: delegationIdA,
                }),
            },
            ask: {
                execute: async (_input: unknown) => ({
                    success: true,
                    delegationEventId: delegationIdB,
                }),
            },
        };

        const wrapped = wrapToolsWithToolUsePublishing(tools as any, context, tracker);

        await Promise.all([
            wrapped.delegate.execute?.(
                { recipient: "agent2", prompt: "task A" },
                { toolCallId: "call-A", messages: [], abortSignal: new AbortController().signal } as any
            ),
            wrapped.ask.execute?.(
                { recipient: "agent3", prompt: "task B" },
                { toolCallId: "call-B", messages: [], abortSignal: new AbortController().signal } as any
            ),
        ]);

        expect(agentPublisher.toolUse).toHaveBeenCalledTimes(2);

        const callA = toolUseCallArgs.find((c) => c.referencedEventIds?.[0] === delegationIdA);
        const callB = toolUseCallArgs.find((c) => c.referencedEventIds?.[0] === delegationIdB);

        expect(callA).toBeDefined();
        expect(callA?.referencedEventIds).toEqual([delegationIdA]);

        expect(callB).toBeDefined();
        expect(callB?.referencedEventIds).toEqual([delegationIdB]);

        // IDs are not merged or swapped: neither call contains both IDs
        expect(callA?.referencedEventIds).not.toContain(delegationIdB);
        expect(callB?.referencedEventIds).not.toContain(delegationIdA);
    });

    it("does not include delegationEventId in referencedEventIds for non-delegate tools", async () => {
        const toolUseMock = mock(async () => makePublishedRef("tool-use-event-1"));
        const agentPublisher = {
            toolUse: toolUseMock,
            complete: mock(async () => undefined),
            conversation: mock(async () => makePublishedRef("conv-ref")),
            delegate: mock(async () => "delegate-ref"),
            ask: mock(async () => makePublishedRef("ask-ref")),
            delegateFollowup: mock(async () => "followup-ref"),
            error: mock(async () => makePublishedRef("error-ref")),
            lesson: mock(async () => makePublishedRef("lesson-ref")),
            streamTextDelta: mock(async () => undefined),
        } as unknown as AgentRuntimePublisher;

        const tracker = new ToolExecutionTracker();
        const context = buildContext(agentPublisher);

        const tools = {
            rag_search: {
                execute: async () => ({ results: ["result1"] }),
            },
        };

        const wrapped = wrapToolsWithToolUsePublishing(tools as any, context, tracker);

        await wrapped.rag_search.execute?.(
            { query: "test" },
            { toolCallId: "call-search", messages: [], abortSignal: new AbortController().signal } as any
        );

        expect(toolUseMock).toHaveBeenCalledTimes(1);
        const [[intent]] = (toolUseMock as ReturnType<typeof mock>).mock.calls;
        expect((intent as any).referencedEventIds).toBeUndefined();
    });
});
