import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { NDKPrivateKeySigner, type NDKEvent } from "@nostr-dev-kit/ndk";
import { getEventHash, verifyEvent, type Event as NostrEvent } from "nostr-tools";
import type { AgentRuntimePublisher } from "@/events/runtime/AgentRuntimePublisher";
import {
    AGENT_WORKER_PROTOCOL_VERSION,
    AgentWorkerProtocolMessageSchema,
    type AgentWorkerProtocolMessage,
} from "@/events/runtime/AgentWorkerProtocol";
import type { RuntimePublishAgent } from "@/events/runtime/RuntimeAgent";
import type { EventContext } from "@/nostr/types";
import type { ProjectContext } from "@/services/projects";
import { projectContextStore } from "@/services/projects";
import { PendingDelegationsRegistry, RALRegistry } from "@/services/ral";
import type {
    AgentWorkerOutboundProtocolMessage,
    AgentWorkerProtocolEmit,
} from "../protocol-emitter";
import { createWorkerProtocolPublisherFactory } from "../publisher-bridge";

const OWNER_PUBKEY = "b".repeat(64);
const RECIPIENT_PUBKEY = "d".repeat(64);
const CONVERSATION_ID = "c".repeat(64);
const ROOT_EVENT_ID = "e".repeat(64);
const TRIGGER_EVENT_ID = "f".repeat(64);
const PROJECT_ID = "publisher-bridge-project";
const NOW = 1710001200000;

type ExecuteMessage = Extract<AgentWorkerProtocolMessage, { type: "execute" }>;
type PublishRequestMessage = Extract<AgentWorkerProtocolMessage, { type: "publish_request" }>;
type ConsumeUnreportedRuntime = RALRegistry["consumeUnreportedRuntime"];
type GetAccumulatedRuntime = RALRegistry["getAccumulatedRuntime"];

interface PublishRequestCase {
    name: string;
    runtimeEventClass: PublishRequestMessage["runtimeEventClass"];
    conversationVariant?: PublishRequestMessage["conversationVariant"];
    act(publisher: AgentRuntimePublisher, context: EventContext): Promise<unknown>;
}

const publishRequestCases: PublishRequestCase[] = [
    {
        name: "complete",
        runtimeEventClass: "complete",
        act: (publisher, context) => publisher.complete({ content: "Done." }, context),
    },
    {
        name: "conversation primary",
        runtimeEventClass: "conversation",
        conversationVariant: "primary",
        act: (publisher, context) =>
            publisher.conversation({ content: "Working update.", isReasoning: false }, context),
    },
    {
        name: "conversation reasoning",
        runtimeEventClass: "conversation",
        conversationVariant: "reasoning",
        act: (publisher, context) =>
            publisher.conversation({ content: "Internal reasoning.", isReasoning: true }, context),
    },
    {
        name: "delegate",
        runtimeEventClass: "delegation",
        act: (publisher, context) =>
            publisher.delegate(
                {
                    recipient: RECIPIENT_PUBKEY,
                    content: "Please handle this.",
                    branch: "worker-publishing",
                    skills: ["skill-a"],
                },
                context
            ),
    },
    {
        name: "ask",
        runtimeEventClass: "ask",
        act: (publisher, context) =>
            publisher.ask(
                {
                    recipient: OWNER_PUBKEY,
                    title: "Clarification",
                    context: "Need a decision.",
                    questions: [
                        {
                            type: "question",
                            title: "Direction",
                            question: "Which route should I take?",
                            suggestions: ["A", "B"],
                        },
                    ],
                },
                context
            ),
    },
    {
        name: "delegate followup",
        runtimeEventClass: "delegate_followup",
        act: (publisher, context) =>
            publisher.delegateFollowup(
                {
                    recipient: RECIPIENT_PUBKEY,
                    content: "One more detail.",
                    delegationEventId: "a".repeat(64),
                    replyToEventId: "9".repeat(64),
                },
                context
            ),
    },
    {
        name: "error",
        runtimeEventClass: "error",
        act: (publisher, context) =>
            publisher.error({ message: "Execution failed.", errorType: "execution_error" }, context),
    },
    {
        name: "lesson",
        runtimeEventClass: "lesson",
        act: (publisher, context) =>
            publisher.lesson(
                {
                    title: "Use precise assertions",
                    lesson: "Check protocol metadata directly.",
                    category: "testing",
                    hashtags: ["worker"],
                },
                context
            ),
    },
    {
        name: "toolUse",
        runtimeEventClass: "tool_use",
        act: (publisher, context) =>
            publisher.toolUse(
                {
                    toolName: "todo_write",
                    content: "Updated todo list.",
                    referencedEventIds: ["8".repeat(64)],
                },
                context
            ),
    },
];

describe("WorkerProtocolPublisher publish_request metadata", () => {
    let originalConsumeUnreportedRuntime: ConsumeUnreportedRuntime | undefined;
    let originalGetAccumulatedRuntime: GetAccumulatedRuntime | undefined;

    beforeEach(() => {
        const registry = RALRegistry.getInstance();
        originalConsumeUnreportedRuntime = registry.consumeUnreportedRuntime;
        originalGetAccumulatedRuntime = registry.getAccumulatedRuntime;
        registry.consumeUnreportedRuntime = (() => 0) as ConsumeUnreportedRuntime;
        registry.getAccumulatedRuntime = (() => 0) as GetAccumulatedRuntime;
        registry.clearAll();
        PendingDelegationsRegistry.clear();
    });

    afterEach(() => {
        const registry = RALRegistry.getInstance();
        if (originalConsumeUnreportedRuntime) {
            registry.consumeUnreportedRuntime = originalConsumeUnreportedRuntime;
        }
        if (originalGetAccumulatedRuntime) {
            registry.getAccumulatedRuntime = originalGetAccumulatedRuntime;
        }
        registry.clearAll();
        PendingDelegationsRegistry.clear();
    });

    for (const testCase of publishRequestCases) {
        it(`emits ${testCase.name} publish_request metadata`, async () => {
            await withProjectContext(async () => {
                const harness = createHarness();

                await testCase.act(harness.publisher, harness.context);

                const publishRequests = harness.emitted.filter(isPublishRequest);
                expect(publishRequests).toHaveLength(1);

                const [publishRequest] = publishRequests;
                expect(publishRequest.runtimeEventClass).toBe(testCase.runtimeEventClass);
                expectSignedPublishRequest(publishRequest, harness.agent.pubkey);

                if (testCase.conversationVariant) {
                    expect(publishRequest.conversationVariant).toBe(testCase.conversationVariant);
                } else {
                    expect("conversationVariant" in publishRequest).toBe(false);
                }

                expect(AgentWorkerProtocolMessageSchema.safeParse(publishRequest).success).toBe(
                    true
                );
            });
        });
    }

    it("emits signed Telegram egress publish_request metadata", async () => {
        await withProjectContext(async () => {
        const harness = createHarness();

        const ref = await harness.publisher.sendMessage(
            {
                channelId: "telegram-channel-123",
                content: "Telegram update from worker.",
            },
            harness.context
        );

        expect(ref.transport).toBe("telegram");
        expect(ref.envelope.transport).toBe("telegram");
        expect(ref.envelope.channel.transport).toBe("telegram");

        const publishRequests = harness.emitted.filter(isPublishRequest);
        expect(publishRequests).toHaveLength(1);

        const [publishRequest] = publishRequests;
        expect(publishRequest.runtimeEventClass).toBe("conversation");
        expect(publishRequest.conversationVariant).toBe("primary");
        expectSignedPublishRequest(publishRequest, harness.agent.pubkey);
        expect(publishRequest.event.content).toBe("Telegram update from worker.");
        expect(publishRequest.event.tags).toContainEqual(["tenex:egress", "telegram"]);
        expect(publishRequest.event.tags).toContainEqual(["tenex:channel", "telegram-channel-123"]);
        expect(publishRequest.event.tags).toContainEqual([
            "a",
            `31933:${OWNER_PUBKEY}:${PROJECT_ID}`,
        ]);
        expect(AgentWorkerProtocolMessageSchema.safeParse(publishRequest).success).toBe(true);
        });
    });

    it("emits signed stream text delta publish_request metadata", async () => {
        await withProjectContext(async () => {
            const harness = createHarness();

            await harness.publisher.streamTextDelta(
                {
                    delta: "partial response",
                    sequence: 3,
                },
                harness.context
            );

            const publishRequests = harness.emitted.filter(isPublishRequest);
            expect(publishRequests).toHaveLength(1);

            const [publishRequest] = publishRequests;
            expect(publishRequest.runtimeEventClass).toBe("stream_text_delta");
            expect(publishRequest.waitForRelayOk).toBe(false);
            expect(publishRequest.event.kind).toBe(24135);
            expect(publishRequest.event.content).toBe("partial response");
            expect(publishRequest.event.tags).toContainEqual(["llm-ral", "1"]);
            expect(publishRequest.event.tags).toContainEqual(["stream-seq", "3"]);
            expect(publishRequest.event.tags).toContainEqual(["llm-model", "mock-model"]);
            expectSignedPublishRequest(publishRequest, harness.agent.pubkey);
            expect(AgentWorkerProtocolMessageSchema.safeParse(publishRequest).success).toBe(true);
        });
    });

    it("anchors delegate followups to the delegated conversation root", async () => {
        await withProjectContext(async () => {
            const harness = createHarness();
            const delegationEventId = "a".repeat(64);

            await harness.publisher.delegateFollowup(
                {
                    recipient: RECIPIENT_PUBKEY,
                    content: "Follow up in delegated thread.",
                    delegationEventId,
                    replyToEventId: "9".repeat(64),
                },
                harness.context
            );

            const publishRequest = harness.emitted.find(isPublishRequest);
            expect(publishRequest).toBeDefined();
            const rootTags = publishRequest!.event.tags.filter(
                (tag) => tag[0] === "e" && tag[3] === "root"
            );
            expect(rootTags).toEqual([["e", delegationEventId, "", "root"]]);
            expect(rootTags).not.toContainEqual(["e", ROOT_EVENT_ID, "", "root"]);
        });
    });
});

function createMockProjectContext(): ProjectContext {
    const projectRef = `31933:${OWNER_PUBKEY}:${PROJECT_ID}`;
    return {
        project: {
            pubkey: OWNER_PUBKEY,
            dTag: PROJECT_ID,
            tagValue: (tag: string) => (tag === "d" ? PROJECT_ID : undefined),
            tagReference: () => ["a", projectRef] as string[],
        },
        agentRegistry: {
            getAgentByPubkey: () => undefined,
        },
    } as unknown as ProjectContext;
}

function withProjectContext<T>(fn: () => Promise<T>): Promise<T> {
    return projectContextStore.run(createMockProjectContext(), fn);
}

function createHarness(): {
    agent: RuntimePublishAgent;
    context: EventContext;
    emitted: AgentWorkerProtocolMessage[];
    publisher: AgentRuntimePublisher;
} {
    const signer = NDKPrivateKeySigner.generate();
    const agent: RuntimePublishAgent = {
        name: "Publisher Bridge Agent",
        slug: "publisher-bridge-agent",
        pubkey: signer.pubkey,
        async sign(event: NDKEvent): Promise<void> {
            await event.sign(signer);
        },
    };
    const context = baseEventContext();
    const emitted: AgentWorkerProtocolMessage[] = [];
    const emit: AgentWorkerProtocolEmit = async (message) => {
        const parsed = AgentWorkerProtocolMessageSchema.parse({
            version: AGENT_WORKER_PROTOCOL_VERSION,
            sequence: emitted.length + 1,
            timestamp: NOW + emitted.length,
            ...message,
        }) as AgentWorkerOutboundProtocolMessage;
        emitted.push(parsed);
        return parsed;
    };
    const publisher = createWorkerProtocolPublisherFactory({
        execution: baseExecution(agent.pubkey, context.triggeringEnvelope),
        emit,
    })(agent);

    return {
        agent,
        context,
        emitted,
        publisher,
    };
}

function baseExecution(
    agentPubkey: string,
    triggeringEnvelope: EventContext["triggeringEnvelope"]
): ExecuteMessage {
    return {
        version: AGENT_WORKER_PROTOCOL_VERSION,
        type: "execute",
        correlationId: "publisher_bridge_metadata",
        sequence: 0,
        timestamp: NOW,
        projectId: PROJECT_ID,
        projectBasePath: "/project/root",
        metadataPath: "/project/root/.tenex",
        agentPubkey,
        conversationId: CONVERSATION_ID,
        ralNumber: 1,
        ralClaimToken: "claim-publisher-bridge",
        triggeringEnvelope,
        executionFlags: {
            isDelegationCompletion: false,
            hasPendingDelegations: false,
            debug: false,
        },
    };
}

function baseEventContext(): EventContext {
    return {
        triggeringEnvelope: {
            transport: "nostr",
            principal: {
                id: `nostr:${OWNER_PUBKEY}`,
                transport: "nostr",
                linkedPubkey: OWNER_PUBKEY,
                kind: "human",
            },
            channel: {
                id: "conversation",
                transport: "nostr",
                kind: "conversation",
                projectBinding: `31933:${OWNER_PUBKEY}:${PROJECT_ID}`,
            },
            message: {
                id: `nostr:${TRIGGER_EVENT_ID}`,
                transport: "nostr",
                nativeId: TRIGGER_EVENT_ID,
            },
            recipients: [],
            content: "Please work on this.",
            occurredAt: NOW / 1000,
            capabilities: ["reply"],
            metadata: {},
        },
        rootEvent: {
            id: ROOT_EVENT_ID,
        },
        conversationId: CONVERSATION_ID,
        ralNumber: 1,
        llmRuntime: 0,
        model: "mock-model",
    };
}

function isPublishRequest(message: AgentWorkerProtocolMessage): message is PublishRequestMessage {
    return message.type === "publish_request";
}

function expectSignedPublishRequest(message: PublishRequestMessage, agentPubkey: string): void {
    expect(message.event.pubkey).toBe(agentPubkey);
    expect(message.event.pubkey).toBe(message.agentPubkey);
    expect(message.event.id).toBe(getEventHash(message.event));
    expect(verifyEvent(message.event as NostrEvent)).toBe(true);
}
