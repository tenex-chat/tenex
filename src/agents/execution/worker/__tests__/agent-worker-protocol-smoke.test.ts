import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "bun:test";
import workerProtocolFixture from "@/test-utils/fixtures/worker-protocol/agent-execution.compat.json";
import {
    AGENT_WORKER_PROTOCOL_VERSION,
    AGENT_WORKER_STREAM_BATCH_MAX_BYTES,
    AGENT_WORKER_STREAM_BATCH_MS,
    encodeAgentWorkerProtocolFrame,
    type AgentWorkerProtocolMessage,
} from "@/events/runtime/AgentWorkerProtocol";
import type { MCPManager } from "@/services/mcp/MCPManager";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { getEventHash, verifyEvent, type Event as NostrEvent } from "nostr-tools";
import { bootstrapProjectScope, runOneExecution } from "../bootstrap";
import { decodeAgentWorkerProtocolChunks } from "../protocol";
import { PublishResultCoordinator } from "../publisher-bridge";
import type { AgentWorkerOutboundProtocolMessage } from "../protocol-emitter";

const PROBE_WORKER_ENTRYPOINT = "tools/rust-migration/protocol-probe-worker.ts";
const AGENT_WORKER_ENTRYPOINT = "src/agents/execution/worker/agent-worker.ts";

describe("agent worker protocol process smoke test", () => {
    it("spawns a Bun worker process and exchanges framed ready/ping/shutdown messages", async () => {
        const worker = spawn(process.execPath, ["run", PROBE_WORKER_ENTRYPOINT], {
            cwd: process.cwd(),
            env: process.env,
            stdio: ["pipe", "pipe", "pipe"],
        });
        let stderr = "";
        worker.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
        });

        const messages = decodeAgentWorkerProtocolChunks(worker.stdout);

        try {
            const ready = await nextWorkerMessage(messages, "ready");
            expect(ready).toMatchObject({
                version: AGENT_WORKER_PROTOCOL_VERSION,
                type: "ready",
                correlationId: "worker_boot",
                protocol: {
                    version: AGENT_WORKER_PROTOCOL_VERSION,
                    streamBatchMs: AGENT_WORKER_STREAM_BATCH_MS,
                    streamBatchMaxBytes: AGENT_WORKER_STREAM_BATCH_MAX_BYTES,
                },
            });

            worker.stdin.write(
                encodeAgentWorkerProtocolFrame({
                    version: AGENT_WORKER_PROTOCOL_VERSION,
                    type: "ping",
                    correlationId: "protocol_smoke",
                    sequence: 10,
                    timestamp: 1710000600000,
                    timeoutMs: 5000,
                })
            );

            const pong = await nextWorkerMessage(messages, "pong");
            expect(pong).toMatchObject({
                version: AGENT_WORKER_PROTOCOL_VERSION,
                type: "pong",
                correlationId: "protocol_smoke",
                replyingToSequence: 10,
            });

            worker.stdin.write(
                encodeAgentWorkerProtocolFrame({
                    version: AGENT_WORKER_PROTOCOL_VERSION,
                    type: "shutdown",
                    correlationId: "protocol_smoke",
                    sequence: 11,
                    timestamp: 1710000600100,
                    reason: "protocol smoke test complete",
                    forceKillTimeoutMs: 5000,
                })
            );
            worker.stdin.end();

            const [code, signal] = (await withTimeout(
                once(worker, "exit"),
                "worker exit"
            )) as [number | null, NodeJS.Signals | null];
            expect({ code, signal, stderr }).toEqual({ code: 0, signal: null, stderr: "" });
        } finally {
            stopWorker(worker);
        }
    });

    it("spawns the agent worker and completes a bounded execute request", async () => {
        const executeMessage = workerProtocolFixture.validMessages.find(
            (fixtureMessage) => fixtureMessage.name === "execute"
        )?.message;
        expect(executeMessage).toBeDefined();

        const worker = spawn(process.execPath, ["run", AGENT_WORKER_ENTRYPOINT], {
            cwd: process.cwd(),
            env: {
                ...process.env,
                TENEX_AGENT_WORKER_ENGINE: "mock",
                TENEX_AGENT_WORKER_ID: "rust-assigned-worker-01",
            },
            stdio: ["pipe", "pipe", "pipe"],
        });
        let stderr = "";
        worker.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
        });

        const messages = decodeAgentWorkerProtocolChunks(worker.stdout);

        try {
            const ready = await nextWorkerMessage(messages, "ready");
            expect(ready).toMatchObject({
                version: AGENT_WORKER_PROTOCOL_VERSION,
                type: "ready",
                correlationId: "worker_boot",
                workerId: "rust-assigned-worker-01",
            });

            worker.stdin.write(encodeAgentWorkerProtocolFrame(executeMessage));

            const executionStarted = await nextWorkerMessage(messages, "execution_started");
            expect(executionStarted).toMatchObject({
                type: "execution_started",
                projectId: executeMessage?.projectId,
                agentPubkey: executeMessage?.agentPubkey,
                conversationId: executeMessage?.conversationId,
                ralNumber: executeMessage?.ralNumber,
            });

            const streamDelta = await nextWorkerMessage(messages, "stream_delta");
            expect(streamDelta).toMatchObject({
                type: "stream_delta",
                projectId: executeMessage?.projectId,
                agentPubkey: executeMessage?.agentPubkey,
                conversationId: executeMessage?.conversationId,
                ralNumber: executeMessage?.ralNumber,
                batchSequence: 1,
            });

            const complete = await nextWorkerMessage(messages, "complete");
            expect(complete).toMatchObject({
                type: "complete",
                projectId: executeMessage?.projectId,
                agentPubkey: executeMessage?.agentPubkey,
                conversationId: executeMessage?.conversationId,
                ralNumber: executeMessage?.ralNumber,
                finalRalState: "completed",
                pendingDelegationsRemain: false,
                keepWorkerWarm: false,
            });

            const [code, signal] = (await withTimeout(
                once(worker, "exit"),
                "agent worker exit"
            )) as [number | null, NodeJS.Signals | null];
            expect({ code, signal, stderr }).toEqual({ code: 0, signal: null, stderr: "" });
        } finally {
            stopWorker(worker);
        }
    });

    it("shuts down the worker MCP manager when executor execution fails", async () => {
        const fixture = await createFilesystemBackedAgentFixture({
            conversationId: "1".repeat(64),
            correlationId: "real_mcp_shutdown_failure_01",
        });
        const lifecycle: string[] = [];
        const fakeMcpManager = {
            initialize: async () => {
                lifecycle.push("initialize");
            },
            shutdown: async () => {
                lifecycle.push("shutdown");
            },
        } as unknown as MCPManager;
        try {
            if (fixture.executeMessage.type !== "execute") {
                throw new Error("fixture execute message must be an execute frame");
            }

            const dependencies = {
                createMcpManager: () => fakeMcpManager,
                createExecutor: () => ({
                    execute: async () => {
                        throw new Error("executor failed after MCP initialize");
                    },
                }),
            };
            const emit = async (message: AgentWorkerProtocolMessage) =>
                ({
                    version: AGENT_WORKER_PROTOCOL_VERSION,
                    sequence: 0,
                    timestamp: 0,
                    ...message,
                }) as AgentWorkerOutboundProtocolMessage;

            const { scope, cleanup } = await bootstrapProjectScope(
                fixture.executeMessage,
                dependencies
            );
            try {
                await expect(
                    runOneExecution(
                        fixture.executeMessage,
                        scope,
                        emit,
                        new PublishResultCoordinator(),
                        dependencies
                    )
                ).rejects.toThrow("executor failed after MCP initialize");
            } finally {
                await cleanup();
            }

            expect(lifecycle).toEqual(["initialize", "shutdown"]);
        } finally {
            await rm(fixture.rootPath, { recursive: true, force: true });
        }
    });

    it("boots the real executor path with a filesystem-backed mock agent", async () => {
        const fixture = await createFilesystemBackedAgentFixture();
        try {
            const worker = spawn(process.execPath, ["run", AGENT_WORKER_ENTRYPOINT], {
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    TENEX_AGENT_WORKER_ENGINE: "agent",
                    TENEX_BASE_DIR: fixture.tenexBasePath,
                    USE_MOCK_LLM: "true",
                    LOG_LEVEL: "silent",
                },
                stdio: ["pipe", "pipe", "pipe"],
            });
            let stderr = "";
            worker.stderr.on("data", (chunk: Buffer) => {
                stderr += chunk.toString("utf8");
            });

            const messages = decodeAgentWorkerProtocolChunks(worker.stdout);

            try {
                const ready = await nextWorkerMessage(messages, "ready");
                expect(ready).toMatchObject({
                    version: AGENT_WORKER_PROTOCOL_VERSION,
                    type: "ready",
                    correlationId: "worker_boot",
                });

                worker.stdin.write(encodeAgentWorkerProtocolFrame(fixture.executeMessage));

                const executionStarted = await nextWorkerMessage(messages, "execution_started");
                expect(executionStarted).toMatchObject({
                    type: "execution_started",
                    projectId: fixture.projectId,
                    agentPubkey: fixture.agentPubkey,
                    conversationId: fixture.conversationId,
                    ralNumber: 1,
                });

                const streamTextDelta = await nextWorkerMessage(
                    messages,
                    "stream_text_delta publish_request"
                );
                expect(streamTextDelta).toMatchObject({
                    type: "publish_request",
                    projectId: fixture.projectId,
                    agentPubkey: fixture.agentPubkey,
                    conversationId: fixture.conversationId,
                    ralNumber: 1,
                    runtimeEventClass: "stream_text_delta",
                    waitForRelayOk: false,
                });
                if (streamTextDelta.type !== "publish_request") {
                    throw new Error("expected stream_text_delta publish_request frame");
                }
                expectSignedPublishEvent(streamTextDelta);
                expect(streamTextDelta.event.content).toContain("Default mock response");
                expect(
                    streamTextDelta.event.tags.some(
                        (tag) => tag[0] === "stream-seq" && tag[1] === "1"
                    )
                ).toBe(true);
                ackPublishRequest(worker, streamTextDelta);

                const publishRequest = await nextWorkerMessage(messages, "publish_request");
                expect(publishRequest).toMatchObject({
                    type: "publish_request",
                    projectId: fixture.projectId,
                    agentPubkey: fixture.agentPubkey,
                    conversationId: fixture.conversationId,
                    ralNumber: 1,
                    runtimeEventClass: "complete",
                    waitForRelayOk: true,
                    event: {
                        kind: 1,
                    },
                });
                expect(
                    "event" in publishRequest && publishRequest.event.content.trim()
                ).toEqual("Default mock response");
                if (publishRequest.type !== "publish_request") {
                    throw new Error("expected publish_request frame");
                }
                expectSignedPublishEvent(publishRequest);
                ackPublishRequest(worker, publishRequest);

                const complete = await nextWorkerMessage(messages, "complete");
                expect(complete).toMatchObject({
                    type: "complete",
                    projectId: fixture.projectId,
                    agentPubkey: fixture.agentPubkey,
                    conversationId: fixture.conversationId,
                    ralNumber: 1,
                    finalRalState: "completed",
                    publishedUserVisibleEvent: true,
                    pendingDelegationsRemain: false,
                    keepWorkerWarm: true,
                });
                expect("finalEventIds" in complete && complete.finalEventIds).toHaveLength(1);
                expect("finalEventIds" in complete && complete.finalEventIds).toContain(
                    publishRequest.event.id
                );

                requestWorkerShutdown(worker, fixture.executeMessage.correlationId);
            } finally {
                stopWorker(worker);
            }
        } finally {
            await rm(fixture.rootPath, { recursive: true, force: true });
        }
    });

    it("round-trips a real executor tool call through protocol and filesystem state", async () => {
        const fixture = await createFilesystemBackedAgentFixture({
            conversationId: "d".repeat(64),
            correlationId: "real_tool_exec_01",
            triggerContent: "please write a todo before you answer",
            providerOptions: {
                responses: [
                    {
                        trigger: {
                            userMessage: "please write a todo before you answer",
                            agentName: "project-manager",
                            iterationCount: 1,
                        },
                        response: {
                            toolCalls: [
                                {
                                    function: "todo_write",
                                    args: {
                                        todos: [
                                            {
                                                id: "worker-tool-path",
                                                title: "Verify worker tool path",
                                                status: "done",
                                            },
                                        ],
                                        force: true,
                                    },
                                },
                            ],
                        },
                        priority: 20,
                    },
                    {
                        trigger: {
                            agentName: "project-manager",
                            iterationCount: 2,
                        },
                        response: {
                            content: "Todo tool path complete.",
                        },
                        priority: 10,
                    },
                ],
            },
        });

        try {
            const worker = spawn(process.execPath, ["run", AGENT_WORKER_ENTRYPOINT], {
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    TENEX_AGENT_WORKER_ENGINE: "agent",
                    TENEX_BASE_DIR: fixture.tenexBasePath,
                    USE_MOCK_LLM: "true",
                    LOG_LEVEL: "silent",
                },
                stdio: ["pipe", "pipe", "pipe"],
            });
            let stderr = "";
            worker.stderr.on("data", (chunk: Buffer) => {
                stderr += chunk.toString("utf8");
            });

            const messages = decodeAgentWorkerProtocolChunks(worker.stdout);

            try {
                const ready = await nextWorkerMessage(messages, "ready");
                expect(ready).toMatchObject({
                    version: AGENT_WORKER_PROTOCOL_VERSION,
                    type: "ready",
                    correlationId: "worker_boot",
                });

                worker.stdin.write(encodeAgentWorkerProtocolFrame(fixture.executeMessage));

                const executionStarted = await nextWorkerMessage(messages, "execution_started");
                expect(executionStarted).toMatchObject({
                    type: "execution_started",
                    projectId: fixture.projectId,
                    agentPubkey: fixture.agentPubkey,
                    conversationId: fixture.conversationId,
                    ralNumber: 1,
                });

                const observed = await collectWorkerMessagesUntilTerminal(
                    worker,
                    messages,
                    "tool execution"
                );
                const toolCompleted = observed.find(
                    (message) => message.type === "tool_call_completed"
                );
                expect(toolCompleted).toMatchObject({
                    type: "tool_call_completed",
                    projectId: fixture.projectId,
                    agentPubkey: fixture.agentPubkey,
                    conversationId: fixture.conversationId,
                    ralNumber: 1,
                    toolName: "todo_write",
                });

                const publishRequests = observed.filter(
                    (message): message is Extract<AgentWorkerProtocolMessage, { type: "publish_request" }> =>
                        message.type === "publish_request"
                );
                expect(
                    publishRequests.some(
                        (message) => message.event.content === "Executing todo_write"
                    )
                ).toBe(true);
                expect(
                    publishRequests.some(
                        (message) =>
                            message.runtimeEventClass === "stream_text_delta" &&
                            message.event.content.includes("Todo tool path complete.")
                    )
                ).toBe(true);
                expect(
                    publishRequests.some(
                        (message) => message.event.content.trim() === "Todo tool path complete."
                    )
                ).toBe(true);

                const complete = observed.find((message) => message.type === "complete");
                expect(complete).toMatchObject({
                    type: "complete",
                    projectId: fixture.projectId,
                    agentPubkey: fixture.agentPubkey,
                    conversationId: fixture.conversationId,
                    ralNumber: 1,
                    finalRalState: "completed",
                    publishedUserVisibleEvent: true,
                    pendingDelegationsRemain: false,
                    keepWorkerWarm: true,
                });
                expect(complete && "finalEventIds" in complete && complete.finalEventIds).toHaveLength(1);

                requestWorkerShutdown(worker, fixture.executeMessage.correlationId);

                const conversationPath = join(
                    fixture.tenexBasePath,
                    "projects",
                    fixture.projectId,
                    "conversations",
                    `${fixture.conversationId}.json`
                );
                const conversation = JSON.parse(await readFile(conversationPath, "utf8"));
                expect(
                    conversation.messages.some(
                        (message: { messageType?: string; toolData?: Array<{ toolName?: string }> }) =>
                            message.messageType === "tool-call" &&
                            message.toolData?.some((part) => part.toolName === "todo_write")
                    )
                ).toBe(true);
                expect(
                    conversation.messages.some(
                        (message: { messageType?: string; toolData?: Array<{ toolName?: string }> }) =>
                            message.messageType === "tool-result" &&
                            message.toolData?.some((part) => part.toolName === "todo_write")
                    )
                ).toBe(true);
                expect(conversation.agentTodos?.[fixture.agentPubkey]?.[0]).toMatchObject({
                    id: "worker-tool-path",
                    title: "Verify worker tool path",
                    status: "done",
                });
            } finally {
                stopWorker(worker);
            }
        } finally {
            await rm(fixture.rootPath, { recursive: true, force: true });
        }
    });

    it("reports a real executor delegation as a protocol waiting state", async () => {
        const triggerContent = "please delegate this to worker-agent and wait";
        const delegationPrompt = "Investigate the delegated worker path.";
        const fixture = await createFilesystemBackedAgentFixture({
            conversationId: "a".repeat(64),
            correlationId: "real_delegate_wait_01",
            triggerContent,
            includeDelegateAgent: true,
            providerOptions: {
                responses: [
                    {
                        trigger: {
                            userMessage: triggerContent,
                            agentName: "project-manager",
                            iterationCount: 1,
                        },
                        response: {
                            toolCalls: [
                                {
                                    function: "delegate",
                                    args: {
                                        recipient: "worker-agent",
                                        prompt: delegationPrompt,
                                    },
                                },
                            ],
                        },
                        priority: 20,
                    },
                    {
                        trigger: {
                            agentName: "project-manager",
                            iterationCount: 2,
                        },
                        response: {
                            content: "Waiting for worker-agent to finish.",
                        },
                        priority: 10,
                    },
                ],
            },
        });
        const delegateAgentPubkey = fixture.delegateAgentPubkey;
        if (!delegateAgentPubkey) {
            throw new Error("delegate fixture must include a worker-agent pubkey");
        }

        try {
            const worker = spawn(process.execPath, ["run", AGENT_WORKER_ENTRYPOINT], {
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    TENEX_AGENT_WORKER_ENGINE: "agent",
                    TENEX_BASE_DIR: fixture.tenexBasePath,
                    USE_MOCK_LLM: "true",
                    LOG_LEVEL: "silent",
                },
                stdio: ["pipe", "pipe", "pipe"],
            });
            let stderr = "";
            worker.stderr.on("data", (chunk: Buffer) => {
                stderr += chunk.toString("utf8");
            });

            const messages = decodeAgentWorkerProtocolChunks(worker.stdout);

            try {
                const ready = await nextWorkerMessage(messages, "ready");
                expect(ready).toMatchObject({
                    version: AGENT_WORKER_PROTOCOL_VERSION,
                    type: "ready",
                    correlationId: "worker_boot",
                });

                worker.stdin.write(encodeAgentWorkerProtocolFrame(fixture.executeMessage));

                const executionStarted = await nextWorkerMessage(messages, "execution_started");
                expect(executionStarted).toMatchObject({
                    type: "execution_started",
                    projectId: fixture.projectId,
                    agentPubkey: fixture.agentPubkey,
                    conversationId: fixture.conversationId,
                    ralNumber: 1,
                });

                const observed = await collectWorkerMessagesUntilTerminal(
                    worker,
                    messages,
                    "delegation wait"
                );
                const registration = observed.find(
                    (message) => message.type === "delegation_registered"
                );
                expect(registration).toMatchObject({
                    type: "delegation_registered",
                    projectId: fixture.projectId,
                    agentPubkey: fixture.agentPubkey,
                    conversationId: fixture.conversationId,
                    ralNumber: 1,
                    recipientPubkey: delegateAgentPubkey,
                    delegationType: "standard",
                });
                const delegationConversationId =
                    registration &&
                    "delegationConversationId" in registration &&
                    typeof registration.delegationConversationId === "string"
                        ? registration.delegationConversationId
                        : undefined;
                expect(delegationConversationId).toBeDefined();

                const toolCompleted = observed.find(
                    (message) => message.type === "tool_call_completed"
                );
                expect(toolCompleted).toMatchObject({
                    type: "tool_call_completed",
                    projectId: fixture.projectId,
                    agentPubkey: fixture.agentPubkey,
                    conversationId: fixture.conversationId,
                    ralNumber: 1,
                    toolName: "delegate",
                });

                const publishRequests = observed.filter(
                    (message): message is Extract<AgentWorkerProtocolMessage, { type: "publish_request" }> =>
                        message.type === "publish_request"
                );
                expect(
                    publishRequests.some(
                        (message) =>
                            message.event.content === delegationPrompt &&
                            message.event.tags.some(
                                (tag) => tag[0] === "p" && tag[1] === delegateAgentPubkey
                            )
                    )
                ).toBe(true);
                expect(
                    publishRequests.some(
                        (message) =>
                            message.event.content.trim() === "Waiting for worker-agent to finish."
                    )
                ).toBe(true);
                expect(
                    publishRequests.some(
                        (message) =>
                            message.runtimeEventClass === "stream_text_delta" &&
                            message.event.content.includes("Waiting for worker-agent to finish.")
                    )
                ).toBe(true);

                const waiting = observed.find((message) => message.type === "waiting_for_delegation");
                expect(waiting).toMatchObject({
                    type: "waiting_for_delegation",
                    projectId: fixture.projectId,
                    agentPubkey: fixture.agentPubkey,
                    conversationId: fixture.conversationId,
                    ralNumber: 1,
                    finalRalState: "waiting_for_delegation",
                    publishedUserVisibleEvent: true,
                    pendingDelegationsRemain: true,
                    keepWorkerWarm: true,
                });
                expect(
                    waiting &&
                        "pendingDelegations" in waiting &&
                        waiting.pendingDelegations.includes(delegationConversationId ?? "")
                ).toBe(true);
                expect(waiting && "finalEventIds" in waiting && waiting.finalEventIds).toHaveLength(1);
                expect(observed.some((message) => message.type === "complete")).toBe(false);

                requestWorkerShutdown(worker, fixture.executeMessage.correlationId);

                const conversationPath = join(
                    fixture.tenexBasePath,
                    "projects",
                    fixture.projectId,
                    "conversations",
                    `${fixture.conversationId}.json`
                );
                const conversation = JSON.parse(await readFile(conversationPath, "utf8"));
                expect(
                    conversation.messages.some(
                        (message: { messageType?: string; toolData?: Array<{ toolName?: string }> }) =>
                            message.messageType === "tool-call" &&
                            message.toolData?.some((part) => part.toolName === "delegate")
                    )
                ).toBe(true);
                expect(
                    conversation.messages.some(
                        (message: { messageType?: string; toolData?: Array<{ toolName?: string }> }) =>
                            message.messageType === "tool-result" &&
                            message.toolData?.some((part) => part.toolName === "delegate")
                    )
                ).toBe(true);
            } finally {
                stopWorker(worker);
            }
        } finally {
            await rm(fixture.rootPath, { recursive: true, force: true });
        }
    });

    it("reports a real executor no_response turn as a protocol terminal state", async () => {
        const triggerContent = "please count this silently and do not reply";
        const fixture = await createFilesystemBackedAgentFixture({
            conversationId: "e".repeat(64),
            correlationId: "real_no_response_01",
            triggerContent,
            triggerTransport: "telegram",
            providerOptions: {
                responses: [
                    {
                        trigger: {
                            userMessage: triggerContent,
                            agentName: "project-manager",
                            iterationCount: 1,
                        },
                        response: {
                            toolCalls: [
                                {
                                    function: "no_response",
                                    args: {},
                                },
                            ],
                        },
                        priority: 20,
                    },
                ],
            },
        });

        try {
            const worker = spawn(process.execPath, ["run", AGENT_WORKER_ENTRYPOINT], {
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    TENEX_AGENT_WORKER_ENGINE: "agent",
                    TENEX_BASE_DIR: fixture.tenexBasePath,
                    USE_MOCK_LLM: "true",
                    LOG_LEVEL: "silent",
                },
                stdio: ["pipe", "pipe", "pipe"],
            });
            let stderr = "";
            worker.stderr.on("data", (chunk: Buffer) => {
                stderr += chunk.toString("utf8");
            });

            const messages = decodeAgentWorkerProtocolChunks(worker.stdout);

            try {
                const ready = await nextWorkerMessage(messages, "ready");
                expect(ready).toMatchObject({
                    version: AGENT_WORKER_PROTOCOL_VERSION,
                    type: "ready",
                    correlationId: "worker_boot",
                });

                worker.stdin.write(encodeAgentWorkerProtocolFrame(fixture.executeMessage));

                const executionStarted = await nextWorkerMessage(messages, "execution_started");
                expect(executionStarted).toMatchObject({
                    type: "execution_started",
                    projectId: fixture.projectId,
                    agentPubkey: fixture.agentPubkey,
                    conversationId: fixture.conversationId,
                    ralNumber: 1,
                });

                const observed = await collectWorkerMessagesUntilTerminal(
                    worker,
                    messages,
                    "no_response"
                );
                const silentCompletionRequested = observed.find(
                    (message) => message.type === "silent_completion_requested"
                );
                expect(silentCompletionRequested).toMatchObject({
                    type: "silent_completion_requested",
                    projectId: fixture.projectId,
                    agentPubkey: fixture.agentPubkey,
                    conversationId: fixture.conversationId,
                    ralNumber: 1,
                });

                const toolCompleted = observed.find(
                    (message) => message.type === "tool_call_completed"
                );
                expect(toolCompleted).toMatchObject({
                    type: "tool_call_completed",
                    projectId: fixture.projectId,
                    agentPubkey: fixture.agentPubkey,
                    conversationId: fixture.conversationId,
                    ralNumber: 1,
                    toolName: "no_response",
                });

                const terminal = observed.find((message) => message.type === "no_response");
                expect(terminal).toMatchObject({
                    type: "no_response",
                    projectId: fixture.projectId,
                    agentPubkey: fixture.agentPubkey,
                    conversationId: fixture.conversationId,
                    ralNumber: 1,
                    finalRalState: "no_response",
                    publishedUserVisibleEvent: false,
                    pendingDelegationsRemain: false,
                    finalEventIds: [],
                    keepWorkerWarm: true,
                });
                expect(observed.some((message) => message.type === "complete")).toBe(false);

                requestWorkerShutdown(worker, fixture.executeMessage.correlationId);

                const conversationPath = join(
                    fixture.tenexBasePath,
                    "projects",
                    fixture.projectId,
                    "conversations",
                    `${fixture.conversationId}.json`
                );
                const conversation = JSON.parse(await readFile(conversationPath, "utf8"));
                expect(
                    conversation.messages.some(
                        (message: { messageType?: string; toolData?: Array<{ toolName?: string }> }) =>
                            message.messageType === "tool-call" &&
                            message.toolData?.some((part) => part.toolName === "no_response")
                    )
                ).toBe(true);
                expect(
                    conversation.messages.some(
                        (message: { messageType?: string; toolData?: Array<{ toolName?: string }> }) =>
                            message.messageType === "tool-result" &&
                            message.toolData?.some((part) => part.toolName === "no_response")
                    )
                ).toBe(true);
            } finally {
                stopWorker(worker);
            }
        } finally {
            await rm(fixture.rootPath, { recursive: true, force: true });
        }
    });

    it("seeds a non-initial RAL continuation for the real executor worker", async () => {
        const triggerContent = "please continue in ral two";
        const fixture = await createFilesystemBackedAgentFixture({
            conversationId: "f".repeat(64),
            correlationId: "real_ral_two_exec_01",
            ralNumber: 2,
            triggerContent,
            providerOptions: {
                responses: [
                    {
                        trigger: {
                            userMessage: triggerContent,
                            agentName: "project-manager",
                            iterationCount: 1,
                        },
                        response: {
                            content: "Continuation handled from RAL 2.",
                        },
                        priority: 10,
                    },
                ],
            },
        });

        try {
            const worker = spawn(process.execPath, ["run", AGENT_WORKER_ENTRYPOINT], {
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    TENEX_AGENT_WORKER_ENGINE: "agent",
                    TENEX_BASE_DIR: fixture.tenexBasePath,
                    USE_MOCK_LLM: "true",
                    LOG_LEVEL: "silent",
                },
                stdio: ["pipe", "pipe", "pipe"],
            });
            let stderr = "";
            worker.stderr.on("data", (chunk: Buffer) => {
                stderr += chunk.toString("utf8");
            });

            const messages = decodeAgentWorkerProtocolChunks(worker.stdout);

            try {
                const ready = await nextWorkerMessage(messages, "ready");
                expect(ready).toMatchObject({
                    version: AGENT_WORKER_PROTOCOL_VERSION,
                    type: "ready",
                    correlationId: "worker_boot",
                });

                worker.stdin.write(encodeAgentWorkerProtocolFrame(fixture.executeMessage));

                const executionStarted = await nextWorkerMessage(messages, "execution_started");
                expect(executionStarted).toMatchObject({
                    type: "execution_started",
                    projectId: fixture.projectId,
                    agentPubkey: fixture.agentPubkey,
                    conversationId: fixture.conversationId,
                    ralNumber: 2,
                });

                const observed = await collectWorkerMessagesUntilTerminal(
                    worker,
                    messages,
                    "RAL 2 continuation"
                );
                const publishRequests = observed.filter(
                    (message): message is Extract<AgentWorkerProtocolMessage, { type: "publish_request" }> =>
                        message.type === "publish_request"
                );
                expect(
                    publishRequests.some(
                        (message) => message.event.content.trim() === "Continuation handled from RAL 2."
                    )
                ).toBe(true);
                expect(
                    publishRequests.some(
                        (message) =>
                            message.runtimeEventClass === "stream_text_delta" &&
                            message.event.content.includes("Continuation handled from RAL 2.")
                    )
                ).toBe(true);

                const complete = observed.find((message) => message.type === "complete");
                expect(complete).toMatchObject({
                    type: "complete",
                    projectId: fixture.projectId,
                    agentPubkey: fixture.agentPubkey,
                    conversationId: fixture.conversationId,
                    ralNumber: 2,
                    finalRalState: "completed",
                    publishedUserVisibleEvent: true,
                    pendingDelegationsRemain: false,
                    keepWorkerWarm: true,
                });

                requestWorkerShutdown(worker, fixture.executeMessage.correlationId);

                const conversationPath = join(
                    fixture.tenexBasePath,
                    "projects",
                    fixture.projectId,
                    "conversations",
                    `${fixture.conversationId}.json`
                );
                const conversation = JSON.parse(await readFile(conversationPath, "utf8"));
                expect(
                    conversation.messages.some(
                        (message: {
                            content?: string;
                            ral?: number;
                            targetedPubkeys?: string[];
                        }) =>
                            message.content === triggerContent &&
                            message.ral === 2 &&
                            message.targetedPubkeys?.includes(fixture.agentPubkey)
                    )
                ).toBe(true);
            } finally {
                stopWorker(worker);
            }
        } finally {
            await rm(fixture.rootPath, { recursive: true, force: true });
        }
    });
});

async function nextWorkerMessage(
    messages: AsyncGenerator<AgentWorkerProtocolMessage>,
    label: string
): Promise<AgentWorkerProtocolMessage> {
    const result = await withTimeout(messages.next(), label);
    if (result.done) {
        throw new Error(`Worker stdout ended before ${label} message`);
    }
    return result.value;
}

async function collectWorkerMessagesUntilTerminal(
    worker: ChildProcessWithoutNullStreams,
    messages: AsyncGenerator<AgentWorkerProtocolMessage>,
    label: string
): Promise<AgentWorkerProtocolMessage[]> {
    const observed: AgentWorkerProtocolMessage[] = [];
    for (let i = 0; i < 30; i++) {
        const message = await nextWorkerMessage(messages, label);
        observed.push(message);
        if (message.type === "publish_request") {
            expectSignedPublishEvent(message);
            ackPublishRequest(worker, message);
        }
        if (
            message.type === "complete" ||
            message.type === "waiting_for_delegation" ||
            message.type === "no_response" ||
            message.type === "error"
        ) {
            return observed;
        }
    }

    throw new Error(`Worker did not emit a terminal message during ${label}`);
}

function ackPublishRequest(
    worker: ChildProcessWithoutNullStreams,
    message: Extract<AgentWorkerProtocolMessage, { type: "publish_request" }>
): void {
    worker.stdin.write(
        encodeAgentWorkerProtocolFrame({
            version: AGENT_WORKER_PROTOCOL_VERSION,
            type: "publish_result",
            correlationId: message.correlationId,
            sequence: message.sequence + 10_000,
            timestamp: message.timestamp + 1,
            requestId: message.requestId,
            requestSequence: message.sequence,
            status: "published",
            eventIds: [message.event.id],
        })
    );
}

function requestWorkerShutdown(
    worker: ChildProcessWithoutNullStreams,
    correlationId: string
): void {
    if (worker.stdin.destroyed || worker.stdin.writableEnded) {
        return;
    }
    worker.stdin.write(
        encodeAgentWorkerProtocolFrame({
            version: AGENT_WORKER_PROTOCOL_VERSION,
            type: "shutdown",
            correlationId,
            sequence: 90_000,
            timestamp: Date.now(),
            reason: "worker smoke test complete",
            forceKillTimeoutMs: 5000,
        })
    );
    worker.stdin.end();
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
    let timeout: Timer | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
            reject(new Error(`Timed out waiting for ${label}`));
        }, 5000);
    });

    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        if (timeout) {
            clearTimeout(timeout);
        }
    }
}

function stopWorker(worker: ChildProcessWithoutNullStreams): void {
    if (worker.exitCode !== null || worker.signalCode !== null) {
        return;
    }
    worker.kill("SIGTERM");
}

function expectSignedPublishEvent(
    message: Extract<AgentWorkerProtocolMessage, { type: "publish_request" }>
): void {
    const { event } = message;

    expect(event.pubkey).toBe(message.agentPubkey);
    expect(event.id).toBe(
        getEventHash({
            pubkey: event.pubkey,
            created_at: event.created_at,
            kind: event.kind,
            tags: event.tags,
            content: event.content,
        })
    );
    expect(verifyEvent(event as NostrEvent)).toBe(true);
}

async function createFilesystemBackedAgentFixture(options: {
    conversationId?: string;
    correlationId?: string;
    ralNumber?: number;
    triggerTransport?: "nostr" | "telegram";
    triggerContent?: string;
    includeDelegateAgent?: boolean;
    providerOptions?: Record<string, unknown>;
} = {}): Promise<{
    rootPath: string;
    tenexBasePath: string;
    projectId: string;
    agentPubkey: string;
    delegateAgentPubkey?: string;
    conversationId: string;
    executeMessage: AgentWorkerProtocolMessage;
}> {
    const rootPath = await mkdtemp(join(tmpdir(), "tenex-agent-worker-"));
    const tenexBasePath = join(rootPath, ".tenex");
    const projectId = "worker-real-project";
    const ownerPubkey = "b".repeat(64);
    const conversationId = options.conversationId ?? "c".repeat(64);
    const ralNumber = options.ralNumber ?? 1;
    const triggerTransport = options.triggerTransport ?? "nostr";
    const triggerEventId = conversationId;
    const projectBasePath = join(rootPath, "projects", projectId, "work");
    const metadataPath = join(tenexBasePath, "projects", projectId);
    const agentsPath = join(tenexBasePath, "agents");

    await mkdir(projectBasePath, { recursive: true });
    await mkdir(metadataPath, { recursive: true });
    await mkdir(agentsPath, { recursive: true });

    const gitInit = spawnSync("git", ["init"], {
        cwd: projectBasePath,
        encoding: "utf8",
    });
    if (gitInit.status !== 0) {
        throw new Error(`git init failed: ${gitInit.stderr}`);
    }

    const signer = NDKPrivateKeySigner.generate();
    const agentPubkey = signer.pubkey;
    const delegateSigner = options.includeDelegateAgent
        ? NDKPrivateKeySigner.generate()
        : undefined;
    const delegateAgentPubkey = delegateSigner?.pubkey;
    await writeFile(
        join(tenexBasePath, "config.json"),
        JSON.stringify(
            {
                whitelistedPubkeys: [ownerPubkey],
                relays: [],
                logging: { level: "silent" },
            },
            null,
            2
        )
    );
    await writeFile(
        join(tenexBasePath, "llms.json"),
        JSON.stringify(
            {
                default: "default",
                configurations: {
                    default: {
                        provider: "mock",
                        model: "mock-model",
                    },
                },
            },
            null,
            2
        )
    );
    await writeFile(
        join(tenexBasePath, "providers.json"),
        JSON.stringify(
            {
                providers: {
                    mock: {
                        apiKey: "mock",
                        ...(options.providerOptions ? { options: options.providerOptions } : {}),
                    },
                },
            },
            null,
            2
        )
    );
    await writeFile(
        join(agentsPath, `${agentPubkey}.json`),
        JSON.stringify(
            {
                nsec: signer.nsec,
                slug: "project-manager",
                name: "project-manager",
                role: "project-manager",
                category: "orchestrator",
                instructions:
                    "You are the project-manager agent. Current Phase: execute. Reply plainly.",
                status: "active",
                default: {
                    model: "default",
                    tools: [],
                    skills: [],
                    blockedSkills: [],
                    mcpAccess: [],
                },
            },
            null,
            2
        )
    );
    if (delegateSigner && delegateAgentPubkey) {
        await writeFile(
            join(agentsPath, `${delegateAgentPubkey}.json`),
            JSON.stringify(
                {
                    nsec: delegateSigner.nsec,
                    slug: "worker-agent",
                    name: "worker-agent",
                    role: "worker-agent",
                    category: "worker",
                    instructions:
                        "You are the worker-agent. Current Phase: execute. Reply plainly.",
                    status: "active",
                    default: {
                        model: "default",
                        tools: [],
                        skills: [],
                        blockedSkills: [],
                        mcpAccess: [],
                    },
                },
                null,
                2
            )
        );
    }
    const bySlug: Record<string, { pubkey: string; projectIds: string[] }> = {
        "project-manager": {
            pubkey: agentPubkey,
            projectIds: [projectId],
        },
    };
    const byProject = [agentPubkey];
    if (delegateAgentPubkey) {
        bySlug["worker-agent"] = {
            pubkey: delegateAgentPubkey,
            projectIds: [projectId],
        };
        byProject.push(delegateAgentPubkey);
    }
    await writeFile(
        join(agentsPath, "index.json"),
        JSON.stringify(
            {
                bySlug,
                byEventId: {},
                byProject: {
                    [projectId]: byProject,
                },
            },
            null,
            2
        )
    );

    return {
        rootPath,
        tenexBasePath,
        projectId,
        agentPubkey,
        delegateAgentPubkey,
        conversationId,
        executeMessage: {
            version: AGENT_WORKER_PROTOCOL_VERSION,
            type: "execute",
            correlationId: options.correlationId ?? "real_exec_01",
            sequence: 1,
            timestamp: 1710000800000,
            projectId,
            projectBasePath,
            metadataPath,
            agentPubkey,
            conversationId,
            ralNumber,
            ralClaimToken: "claim_real_exec_01",
            triggeringEnvelope: {
                transport: triggerTransport,
                principal: {
                    id:
                        triggerTransport === "telegram"
                            ? "telegram:user:project-owner"
                            : `nostr:${ownerPubkey}`,
                    transport: triggerTransport,
                    linkedPubkey: ownerPubkey,
                    displayName: "Project Owner",
                    kind: "human",
                },
                channel: {
                    id:
                        triggerTransport === "telegram"
                            ? `telegram:chat:${projectId}`
                            : `nostr:project:31933:${ownerPubkey}:${projectId}`,
                    transport: triggerTransport,
                    kind: triggerTransport === "telegram" ? "group" : "project",
                    projectBinding: `31933:${ownerPubkey}:${projectId}`,
                },
                message: {
                    id: `${triggerTransport}:${triggerEventId}`,
                    transport: triggerTransport,
                    nativeId: triggerEventId,
                },
                recipients: [
                    {
                        id: `nostr:${agentPubkey}`,
                        transport: "nostr",
                        linkedPubkey: agentPubkey,
                        kind: "agent",
                    },
                ],
                content: options.triggerContent ?? "please answer with the mock response",
                occurredAt: 1710000800,
                capabilities: ["reply"],
                metadata: {
                    eventKind: 1,
                    eventTagCount: 3,
                },
            },
            executionFlags: {
                isDelegationCompletion: false,
                hasPendingDelegations: false,
                debug: true,
            },
            agent: {
                pubkey: agentPubkey,
                slug: "project-manager",
                name: "project-manager",
                role: "project-manager",
                category: "orchestrator",
                signingPrivateKey: signer.privateKey,
                instructions:
                    "You are the project-manager agent. Current Phase: execute. Reply plainly.",
                llmConfig: "default",
                tools: [],
                alwaysSkills: [],
                blockedSkills: [],
                mcpAccess: [],
            },
            projectAgentInventory: [
                {
                    pubkey: agentPubkey,
                    slug: "project-manager",
                    name: "project-manager",
                    role: "project-manager",
                    isPM: true,
                },
                ...(delegateAgentPubkey
                    ? [
                          {
                              pubkey: delegateAgentPubkey,
                              slug: "worker-agent",
                              name: "worker-agent",
                              role: "worker-agent",
                          },
                      ]
                    : []),
            ],
        },
    };
}
