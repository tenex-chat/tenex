import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentInstance } from "@/agents/types";
import type { ExecutionContext } from "@/agents/execution/types";
import { ConversationStore } from "@/conversations/ConversationStore";
import {
    AGENT_WORKER_MAX_FRAME_BYTES,
    AGENT_WORKER_PROTOCOL_ENCODING,
    AGENT_WORKER_PROTOCOL_VERSION,
    AGENT_WORKER_STREAM_BATCH_MAX_BYTES,
    AGENT_WORKER_STREAM_BATCH_MS,
    encodeAgentWorkerProtocolFrame,
    type AgentWorkerProtocolMessage,
} from "@/events/runtime/AgentWorkerProtocol";
import { publishWorkerProtocolNostrEvent } from "@/nostr/WorkerPublishRequestPublisher";
import type { ProjectContext } from "@/services/projects";
import { RALRegistry } from "@/services/ral";
import type { RALRegistryEntry } from "@/services/ral/types";
import {
    executeDispatchViaAgentWorker,
    getAgentWorkerDispatchIneligibility,
    isAgentWorkerDispatchEnabled,
} from "../dispatch-adapter";
import { AgentWorkerProtocolStreamDecoder } from "../protocol";

const AGENT_PUBKEY = "a".repeat(64);
const RECIPIENT_PUBKEY = "b".repeat(64);
const CONVERSATION_ID = "c".repeat(64);
const EVENT_ID = "d".repeat(64);
const TRIGGER_EVENT_ID = "e".repeat(64);
const PROJECT_ID = "worker-dispatch-project";
const NOW = 1710000900000;

describe("agent worker dispatch adapter gate", () => {
    beforeEach(() => {
        RALRegistry.getInstance().clearAll();
    });

    afterEach(() => {
        RALRegistry.getInstance().clearAll();
    });

    it("enables worker dispatch only for explicit truthy env values", () => {
        expect(isAgentWorkerDispatchEnabled({ TENEX_AGENT_WORKER: "1" })).toBe(true);
        expect(isAgentWorkerDispatchEnabled({ TENEX_AGENT_WORKER: "true" })).toBe(true);
        expect(isAgentWorkerDispatchEnabled({ TENEX_AGENT_WORKER: "yes" })).toBe(true);
        expect(isAgentWorkerDispatchEnabled({ TENEX_AGENT_WORKER: "0" })).toBe(false);
        expect(isAgentWorkerDispatchEnabled({})).toBe(false);
    });

    it("accepts only fresh first-turn executions for worker routing", () => {
        const originalGet = ConversationStore.get;
        try {
            ConversationStore.get = (() => ({
                getMessageCount: () => 1,
            })) as typeof ConversationStore.get;

            const eligible = baseEligibilityParams();
            expect(getAgentWorkerDispatchIneligibility(eligible)).toBeUndefined();

            expect(
                getAgentWorkerDispatchIneligibility({
                    ...eligible,
                    activeRal: {} as RALRegistryEntry,
                })
            ).toBe("active_ral_present");
            expect(
                getAgentWorkerDispatchIneligibility({
                    ...eligible,
                    resumptionClaim: { ralNumber: 2, token: "claim" },
                })
            ).toBe("resumption_claim_present");
            expect(
                getAgentWorkerDispatchIneligibility({
                    ...eligible,
                    executionContext: {
                        ...eligible.executionContext,
                        isDelegationCompletion: true,
                    },
                })
            ).toBe("delegation_completion");

            ConversationStore.get = (() => ({
                getMessageCount: () => 2,
            })) as typeof ConversationStore.get;
            expect(getAgentWorkerDispatchIneligibility(eligible)).toBe(
                "not_fresh_initial_conversation"
            );
        } finally {
            ConversationStore.get = originalGet;
        }
    });

    it("drives a child worker over framed protocol and clears parent RAL on completion", async () => {
        const fakeWorker = new FakeAgentWorker();
        const spawnCalls: SpawnCall[] = [];
        const publishedEvents: unknown[] = [];
        const spawnWorker = createSpawnWorker(fakeWorker, spawnCalls);
        const publishEvent: typeof publishWorkerProtocolNostrEvent = async (rawEvent) => {
            publishedEvents.push(rawEvent);
            return [EVENT_ID];
        };

        fakeWorker.onProtocolMessage((message) => {
            if (message.type === "execute") {
                fakeWorker.writeProtocolMessage(executionStartedFrame(message, 1));
                fakeWorker.writeProtocolMessage(publishRequestFrame(message, 2));
                return;
            }

            if (message.type === "publish_result") {
                fakeWorker.writeProtocolMessage(completeFrame(fakeWorker.executeMessage(), 3));
                fakeWorker.finish(0);
            }
        });

        fakeWorker.writeProtocolMessage(readyFrame());

        await executeDispatchViaAgentWorker(baseDispatchParams(), {
            spawnWorker,
            publishEvent,
            env: {
                TENEX_AGENT_WORKER_BUN_BIN: "/usr/local/bin/bun",
                TENEX_AGENT_WORKER_ENTRYPOINT: "custom-worker.ts",
                TENEX_AGENT_WORKER_CWD: "/project/root",
            },
            now: () => NOW,
            bootTimeoutMs: 500,
            messageTimeoutMs: 500,
            exitTimeoutMs: 500,
        });

        expect(spawnCalls).toEqual([
            {
                command: "/usr/local/bin/bun",
                args: ["run", "custom-worker.ts"],
                cwd: "/project/root",
                engine: "agent",
            },
        ]);

        const execute = fakeWorker.receivedMessages.find((message) => message.type === "execute");
        expect(execute).toMatchObject({
            type: "execute",
            projectId: PROJECT_ID,
            projectBasePath: "/project/root",
            metadataPath: "/project/root/.tenex",
            agentPubkey: AGENT_PUBKEY,
            conversationId: CONVERSATION_ID,
            ralNumber: 1,
            triggeringEnvelope: {
                message: {
                    nativeId: TRIGGER_EVENT_ID,
                },
            },
            executionFlags: {
                isDelegationCompletion: false,
                hasPendingDelegations: false,
                debug: false,
            },
        });
        expect(publishedEvents).toEqual([publishEventPayload()]);
        expect(fakeWorker.receivedMessages).toContainEqual(
            expect.objectContaining({
                type: "publish_result",
                requestId: "publish-1",
                requestSequence: 2,
                status: "published",
                eventIds: [EVENT_ID],
            })
        );
        expect(RALRegistry.getInstance().getRAL(AGENT_PUBKEY, CONVERSATION_ID, 1)).toBeUndefined();
        expect(fakeWorker.killed).toBe(false);
    });

    it("keeps parent RAL idle and mirrors delegation state when worker waits", async () => {
        const fakeWorker = new FakeAgentWorker();
        const spawnWorker = createSpawnWorker(fakeWorker, []);
        const publishEvent: typeof publishWorkerProtocolNostrEvent = async () => [EVENT_ID];

        fakeWorker.onProtocolMessage((message) => {
            if (message.type === "execute") {
                fakeWorker.writeProtocolMessage(executionStartedFrame(message, 1));
                fakeWorker.writeProtocolMessage(publishRequestFrame(message, 2));
                fakeWorker.writeProtocolMessage(delegationRegisteredFrame(message, 3));
                fakeWorker.writeProtocolMessage(waitingForDelegationFrame(message, 4));
                fakeWorker.finish(0);
            }
        });

        fakeWorker.writeProtocolMessage(readyFrame());

        await executeDispatchViaAgentWorker(baseDispatchParams(), {
            spawnWorker,
            publishEvent,
            now: () => NOW,
            bootTimeoutMs: 500,
            messageTimeoutMs: 500,
            exitTimeoutMs: 500,
        });

        const ral = RALRegistry.getInstance().getRAL(AGENT_PUBKEY, CONVERSATION_ID, 1);
        expect(ral?.isStreaming).toBe(false);

        expect(
            RALRegistry.getInstance().getConversationPendingDelegations(
                AGENT_PUBKEY,
                CONVERSATION_ID,
                1
            )
        ).toEqual([
            {
                delegationConversationId: EVENT_ID,
                recipientPubkey: RECIPIENT_PUBKEY,
                senderPubkey: AGENT_PUBKEY,
                prompt: "delegate this",
                ralNumber: 1,
            },
        ]);
    });

    it("reports failed publish_result frames before surfacing publish failures", async () => {
        const fakeWorker = new FakeAgentWorker();
        const spawnWorker = createSpawnWorker(fakeWorker, []);
        const publishEvent: typeof publishWorkerProtocolNostrEvent = async () => {
            throw new Error("relay publish failed");
        };

        fakeWorker.onProtocolMessage((message) => {
            if (message.type === "execute") {
                fakeWorker.writeProtocolMessage(executionStartedFrame(message, 1));
                fakeWorker.writeProtocolMessage(publishRequestFrame(message, 2));
            }
        });

        fakeWorker.writeProtocolMessage(readyFrame());

        await expect(
            executeDispatchViaAgentWorker(baseDispatchParams(), {
                spawnWorker,
                publishEvent,
                now: () => NOW,
                bootTimeoutMs: 500,
                messageTimeoutMs: 500,
                exitTimeoutMs: 500,
            })
        ).rejects.toThrow("relay publish failed");

        expect(fakeWorker.receivedMessages).toContainEqual(
            expect.objectContaining({
                type: "publish_result",
                requestId: "publish-1",
                requestSequence: 2,
                status: "failed",
                eventIds: [],
                error: {
                    code: "publish_failed",
                    message: "relay publish failed",
                    retryable: true,
                },
            })
        );
        expect(RALRegistry.getInstance().getRAL(AGENT_PUBKEY, CONVERSATION_ID, 1)).toBeUndefined();
        expect(fakeWorker.killed).toBe(true);
    });
});

function baseEligibilityParams(): Parameters<typeof getAgentWorkerDispatchIneligibility>[0] {
    return {
        targetAgent: {
            pubkey: AGENT_PUBKEY,
        } as AgentInstance,
        projectCtx: {} as ProjectContext,
        executionContext: {
            conversationId: CONVERSATION_ID,
            triggeringEnvelope: triggeringEnvelope(),
        } as ExecutionContext,
    };
}

function baseDispatchParams(): Parameters<typeof executeDispatchViaAgentWorker>[0] {
    return {
        targetAgent: {
            pubkey: AGENT_PUBKEY,
        } as AgentInstance,
        projectCtx: projectContext(),
        executionContext: {
            conversationId: CONVERSATION_ID,
            triggeringEnvelope: triggeringEnvelope(),
            isDelegationCompletion: false,
            hasPendingDelegations: false,
            debug: false,
        } as ExecutionContext,
    };
}

function projectContext(): ProjectContext {
    return {
        project: {
            dTag: PROJECT_ID,
            tagValue: (name: string) => (name === "d" ? PROJECT_ID : undefined),
        },
        agentRegistry: {
            getBasePath: () => "/project/root",
            getMetadataPath: () => "/project/root/.tenex",
        },
    } as unknown as ProjectContext;
}

function triggeringEnvelope(): ExecutionContext["triggeringEnvelope"] {
    return {
        transport: "nostr",
        principal: {
            id: `nostr:${RECIPIENT_PUBKEY}`,
            transport: "nostr",
            linkedPubkey: RECIPIENT_PUBKEY,
            kind: "human",
        },
        channel: {
            id: "conversation",
            transport: "nostr",
            kind: "conversation",
            projectBinding: `31933:${RECIPIENT_PUBKEY}:${PROJECT_ID}`,
        },
        message: {
            id: `nostr:${TRIGGER_EVENT_ID}`,
            transport: "nostr",
            nativeId: TRIGGER_EVENT_ID,
        },
        recipients: [],
        content: "hello",
        occurredAt: 1710000800,
        capabilities: ["reply"],
        metadata: {},
    };
}

function readyFrame(): AgentWorkerProtocolMessage {
    return {
        version: AGENT_WORKER_PROTOCOL_VERSION,
        type: "ready",
        correlationId: "worker_boot",
        sequence: 0,
        timestamp: NOW,
        workerId: "fake-worker",
        pid: 123,
        protocol: {
            version: AGENT_WORKER_PROTOCOL_VERSION,
            encoding: AGENT_WORKER_PROTOCOL_ENCODING,
            maxFrameBytes: AGENT_WORKER_MAX_FRAME_BYTES,
            streamBatchMs: AGENT_WORKER_STREAM_BATCH_MS,
            streamBatchMaxBytes: AGENT_WORKER_STREAM_BATCH_MAX_BYTES,
        },
    };
}

function executionStartedFrame(
    execute: Extract<AgentWorkerProtocolMessage, { type: "execute" }>,
    sequence: number
): AgentWorkerProtocolMessage {
    return {
        version: AGENT_WORKER_PROTOCOL_VERSION,
        type: "execution_started",
        correlationId: execute.correlationId,
        sequence,
        timestamp: NOW + sequence,
        projectId: execute.projectId,
        agentPubkey: execute.agentPubkey,
        conversationId: execute.conversationId,
        ralNumber: execute.ralNumber,
    };
}

function publishRequestFrame(
    execute: Extract<AgentWorkerProtocolMessage, { type: "execute" }>,
    sequence: number
): AgentWorkerProtocolMessage {
    return {
        version: AGENT_WORKER_PROTOCOL_VERSION,
        type: "publish_request",
        correlationId: execute.correlationId,
        sequence,
        timestamp: NOW + sequence,
        projectId: execute.projectId,
        agentPubkey: execute.agentPubkey,
        conversationId: execute.conversationId,
        ralNumber: execute.ralNumber,
        requestId: "publish-1",
        requiresEventId: true,
        timeoutMs: 5000,
        runtimeEventClass: "complete",
        event: publishEventPayload(),
    };
}

function delegationRegisteredFrame(
    execute: Extract<AgentWorkerProtocolMessage, { type: "execute" }>,
    sequence: number
): AgentWorkerProtocolMessage {
    return {
        version: AGENT_WORKER_PROTOCOL_VERSION,
        type: "delegation_registered",
        correlationId: execute.correlationId,
        sequence,
        timestamp: NOW + sequence,
        projectId: execute.projectId,
        agentPubkey: execute.agentPubkey,
        conversationId: execute.conversationId,
        ralNumber: execute.ralNumber,
        delegationConversationId: EVENT_ID,
        recipientPubkey: RECIPIENT_PUBKEY,
        delegationType: "standard",
    };
}

function waitingForDelegationFrame(
    execute: Extract<AgentWorkerProtocolMessage, { type: "execute" }>,
    sequence: number
): AgentWorkerProtocolMessage {
    return {
        version: AGENT_WORKER_PROTOCOL_VERSION,
        type: "waiting_for_delegation",
        correlationId: execute.correlationId,
        sequence,
        timestamp: NOW + sequence,
        projectId: execute.projectId,
        agentPubkey: execute.agentPubkey,
        conversationId: execute.conversationId,
        ralNumber: execute.ralNumber,
        pendingDelegations: [EVENT_ID],
        finalRalState: "waiting_for_delegation",
        publishedUserVisibleEvent: true,
        pendingDelegationsRemain: true,
        accumulatedRuntimeMs: 10,
        finalEventIds: [EVENT_ID],
        keepWorkerWarm: false,
    };
}

function completeFrame(
    execute: Extract<AgentWorkerProtocolMessage, { type: "execute" }>,
    sequence: number
): AgentWorkerProtocolMessage {
    return {
        version: AGENT_WORKER_PROTOCOL_VERSION,
        type: "complete",
        correlationId: execute.correlationId,
        sequence,
        timestamp: NOW + sequence,
        projectId: execute.projectId,
        agentPubkey: execute.agentPubkey,
        conversationId: execute.conversationId,
        ralNumber: execute.ralNumber,
        finalRalState: "completed",
        publishedUserVisibleEvent: true,
        pendingDelegationsRemain: false,
        accumulatedRuntimeMs: 10,
        finalEventIds: [EVENT_ID],
        keepWorkerWarm: false,
    };
}

function publishEventPayload(): NonNullable<
    Extract<AgentWorkerProtocolMessage, { type: "publish_request" }>["event"]
> {
    return {
        id: EVENT_ID,
        pubkey: AGENT_PUBKEY,
        kind: 1111,
        content: "delegate this",
        tags: [["p", RECIPIENT_PUBKEY]],
        created_at: 1710000800,
        sig: "f".repeat(128),
    };
}

interface SpawnCall {
    command: string;
    args: string[];
    cwd?: string;
    engine?: string;
}

function createSpawnWorker(worker: FakeAgentWorker, calls: SpawnCall[]): typeof spawn {
    return ((command: string, args?: readonly string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
        calls.push({
            command,
            args: [...(args ?? [])],
            cwd: typeof options?.cwd === "string" ? options.cwd : undefined,
            engine: options?.env?.TENEX_AGENT_WORKER_ENGINE,
        });
        return worker as unknown as ChildProcessWithoutNullStreams;
    }) as typeof spawn;
}

class FakeAgentWorker extends EventEmitter {
    readonly stdin = new PassThrough();
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    readonly receivedMessages: AgentWorkerProtocolMessage[] = [];
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    killed = false;

    private readonly stdinDecoder = new AgentWorkerProtocolStreamDecoder();
    private messageHandler?: (message: AgentWorkerProtocolMessage) => void;

    constructor() {
        super();
        this.stdin.on("data", (chunk: Buffer) => {
            for (const message of this.stdinDecoder.push(chunk)) {
                this.receivedMessages.push(message);
                this.messageHandler?.(message);
            }
        });
    }

    onProtocolMessage(handler: (message: AgentWorkerProtocolMessage) => void): void {
        this.messageHandler = handler;
    }

    writeProtocolMessage(message: AgentWorkerProtocolMessage): void {
        this.stdout.write(encodeAgentWorkerProtocolFrame(message));
    }

    executeMessage(): Extract<AgentWorkerProtocolMessage, { type: "execute" }> {
        const message = this.receivedMessages.find((candidate) => candidate.type === "execute");
        if (!message || message.type !== "execute") {
            throw new Error("fake worker did not receive execute message");
        }
        return message;
    }

    finish(code: number): void {
        this.exitCode = code;
        this.stdout.end();
        this.emit("exit", code, null);
    }

    kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
        this.killed = true;
        this.signalCode = signal;
        this.stdout.end();
        this.emit("exit", null, signal);
        return true;
    }
}
