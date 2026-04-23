import {
    AGENT_WORKER_MAX_FRAME_BYTES,
    AGENT_WORKER_PROTOCOL_ENCODING,
    AGENT_WORKER_PROTOCOL_VERSION,
    AGENT_WORKER_STREAM_BATCH_MAX_BYTES,
    AGENT_WORKER_STREAM_BATCH_MS,
    type AgentWorkerProtocolMessage,
} from "@/events/runtime/AgentWorkerProtocol";
import { ConversationStore } from "@/conversations/ConversationStore";
import { RALRegistry } from "@/services/ral";
import { initializeTelemetry, shutdownTelemetry } from "@/telemetry/setup";
import { logger } from "@/utils/logger";
import {
    decodeAgentWorkerProtocolChunks,
    type AgentWorkerProtocolFrameSink,
    writeAgentWorkerProtocolFrame,
} from "./protocol";
import { AgentWorkerExecutionFailure, executeAgentWorkerRequest } from "./bootstrap";
import { Nip46PublishCoordinator, Nip46WorkerBridge } from "./nip46-bridge";
import type {
    AgentWorkerOutboundProtocolMessage,
    AgentWorkerProtocolEmit,
} from "./protocol-emitter";

type ExecuteMessage = Extract<AgentWorkerProtocolMessage, { type: "execute" }>;
type PingMessage = Extract<AgentWorkerProtocolMessage, { type: "ping" }>;
type InjectMessage = Extract<AgentWorkerProtocolMessage, { type: "inject" }>;
type PublishResultMessage = Extract<AgentWorkerProtocolMessage, { type: "publish_result" }>;

class AgentWorkerSession {
    private sequence = 0;
    private readonly publishResults = new PublishResultCoordinator();
    private readonly nip46Results = new Nip46PublishCoordinator();
    private readonly protocolSink = createProtocolStdoutSink();
    private readonly emit: AgentWorkerProtocolEmit = async (message) => {
        const framedMessage = {
            version: AGENT_WORKER_PROTOCOL_VERSION,
            sequence: this.nextSequence(),
            timestamp: Date.now(),
            ...message,
        } as AgentWorkerOutboundProtocolMessage;
        await this.write(framedMessage);
        return framedMessage;
    };

    constructor() {
        installProcessStdoutSuppressor();
        installConsoleSuppressor();
        Nip46WorkerBridge.install(this.emit, this.nip46Results);
    }

    async run(): Promise<void> {
        const configuredWorkerId = process.env.TENEX_AGENT_WORKER_ID?.trim();
        await this.emit({
            type: "ready",
            correlationId: "worker_boot",
            workerId: configuredWorkerId || `agent-worker-${process.pid}`,
            pid: process.pid,
            protocol: {
                version: AGENT_WORKER_PROTOCOL_VERSION,
                encoding: AGENT_WORKER_PROTOCOL_ENCODING,
                maxFrameBytes: AGENT_WORKER_MAX_FRAME_BYTES,
                streamBatchMs: AGENT_WORKER_STREAM_BATCH_MS,
                streamBatchMaxBytes: AGENT_WORKER_STREAM_BATCH_MAX_BYTES,
            },
        });

        const messages = decodeAgentWorkerProtocolChunks(
            process.stdin as AsyncIterable<Uint8Array | string>
        );
        let activeExecution: Promise<boolean> | undefined;
        let pendingNext: Promise<IteratorResult<AgentWorkerProtocolMessage>> | undefined;

        while (true) {
            pendingNext ??= messages.next();

            if (activeExecution) {
                const result = await Promise.race([
                    pendingNext.then((iteration) => ({ type: "message" as const, iteration })),
                    activeExecution.then((keepRunning) => ({
                        type: "execution" as const,
                        keepRunning,
                    })),
                ]);

                if (result.type === "execution") {
                    activeExecution = undefined;
                    if (!result.keepRunning) {
                        return;
                    }
                    continue;
                }

                pendingNext = undefined;
                if (result.iteration.done) {
                    const keepRunning = await activeExecution;
                    activeExecution = undefined;
                    if (!keepRunning) {
                        return;
                    }
                    continue;
                }

                const nextExecution = this.handleIncomingMessage(result.iteration.value);
                if (nextExecution === "shutdown") {
                    this.publishResults.rejectAll(new Error("worker shutdown requested"));
                    this.nip46Results.rejectAll(new Error("worker shutdown requested"));
                    return;
                }
                if (nextExecution) {
                    throw new Error("Agent worker received execute while execution is active");
                }
                continue;
            }

            const result = await pendingNext;
            pendingNext = undefined;
            if (result.done) {
                return;
            }

            const nextExecution = this.handleIncomingMessage(result.value);
            if (nextExecution === "shutdown") {
                this.publishResults.rejectAll(new Error("worker shutdown requested"));
                return;
            }
            activeExecution = nextExecution;
        }
    }

    private handleIncomingMessage(
        message: AgentWorkerProtocolMessage
    ): Promise<boolean> | "shutdown" | undefined {
        if (message.type === "ping") {
            void this.handlePing(message);
            return undefined;
        }

        if (message.type === "publish_result") {
            this.publishResults.resolve(message);
            return undefined;
        }

        if (message.type === "nip46_publish_result") {
            this.nip46Results.resolve(message);
            return undefined;
        }

        if (message.type === "inject") {
            this.handleInject(message);
            return undefined;
        }

        if (message.type === "execute") {
            return this.handleExecute(message);
        }

        if (message.type === "shutdown") {
            return "shutdown";
        }

        throw new Error(`Unsupported agent worker message type: ${message.type}`);
    }

    private async handlePing(message: PingMessage): Promise<void> {
        await this.emit({
            type: "pong",
            correlationId: message.correlationId,
            replyingToSequence: message.sequence,
        });
    }

    private handleInject(message: InjectMessage): void {
        const ralRegistry = RALRegistry.getInstance();
        const delegationCompletion = message.delegationCompletion;
        if (delegationCompletion) {
            const location = ralRegistry.recordCompletion({
                delegationConversationId: delegationCompletion.delegationConversationId,
                recipientPubkey: delegationCompletion.recipientPubkey,
                response: message.content,
                completedAt: delegationCompletion.completedAt,
            });

            if (location) {
                const parentStore = ConversationStore.get(location.conversationId);
                if (parentStore) {
                    const updated = parentStore.updateDelegationMarker(
                        delegationCompletion.delegationConversationId,
                        {
                            status: "completed",
                            completedAt: delegationCompletion.completedAt,
                        }
                    );

                    if (!updated) {
                        parentStore.addDelegationMarker(
                            {
                                delegationConversationId:
                                    delegationCompletion.delegationConversationId,
                                recipientPubkey: delegationCompletion.recipientPubkey,
                                parentConversationId: location.conversationId,
                                completedAt: delegationCompletion.completedAt,
                                status: "completed",
                            },
                            location.agentPubkey,
                            location.ralNumber
                        );
                    }

                    void parentStore.save().catch((error: unknown) => {
                        logger.warn("[AgentWorker] Failed to persist injected delegation marker", {
                            delegationConversationId:
                                delegationCompletion.delegationConversationId,
                            error: error instanceof Error ? error.message : String(error),
                        });
                    });
                }
                return;
            }

            logger.warn("[AgentWorker] Delegation completion inject did not match a pending RAL", {
                delegationConversationId: delegationCompletion.delegationConversationId,
                agentPubkey: message.agentPubkey.substring(0, 8),
                conversationId: message.conversationId.substring(0, 8),
                ralNumber: message.ralNumber,
            });
        }

        if (message.role === "system") {
            ralRegistry.queueSystemMessage(
                message.agentPubkey,
                message.conversationId,
                message.ralNumber,
                message.content
            );
            return;
        }

        ralRegistry.queueUserMessage(
            message.agentPubkey,
            message.conversationId,
            message.ralNumber,
            message.content,
            {
                senderPubkey: message.senderPubkey,
                senderPrincipal: message.senderPrincipal,
                targetedPrincipals: message.targetedPrincipals,
                eventId: message.eventId,
            }
        );
    }

    private async handleExecute(message: ExecuteMessage): Promise<boolean> {
        const startedAt = Date.now();
        const engine = process.env.TENEX_AGENT_WORKER_ENGINE;

        if (engine === "mock") {
            await this.handleMockExecute(message, startedAt);
            return false;
        }

        if (engine === "agent") {
            try {
                const result = await executeAgentWorkerRequest(message, this.emit, {
                    publishResults: this.publishResults,
                });

                const terminalBase = {
                    correlationId: message.correlationId,
                    ...executionIdentity(message),
                    publishedUserVisibleEvent: result.publishedUserVisibleEvent,
                    pendingDelegationsRemain: result.pendingDelegationsRemain,
                    accumulatedRuntimeMs: Date.now() - startedAt,
                    finalEventIds: result.finalEventIds,
                    keepWorkerWarm: result.keepWorkerWarm,
                };

                if (result.finalRalState === "no_response") {
                    await this.emit({
                        type: "no_response",
                        ...terminalBase,
                        finalRalState: "no_response",
                    });
                } else if (result.finalRalState === "waiting_for_delegation") {
                    await this.emit({
                        type: "waiting_for_delegation",
                        ...terminalBase,
                        pendingDelegations: result.pendingDelegations,
                        finalRalState: "waiting_for_delegation",
                    });
                } else {
                    await this.emit({
                        type: "complete",
                        ...terminalBase,
                        finalRalState: "completed",
                    });
                }

                return result.keepWorkerWarm;
            } catch (error) {
                const executionError =
                    error instanceof AgentWorkerExecutionFailure
                        ? {
                              code: error.code,
                              message: error.message,
                              retryable: error.retryable,
                          }
                        : {
                              code: "agent_execution_failed",
                              message: error instanceof Error ? error.message : String(error),
                              retryable: false,
                          };
                await this.writeTerminalError(message, startedAt, executionError);
                return false;
            }
        }

        {
            await this.writeTerminalError(message, startedAt, {
                code: "execution_engine_unavailable",
                message: "TENEX_AGENT_WORKER_ENGINE must be set to mock or agent",
                retryable: false,
            });
        }

        return false;
    }

    private async handleMockExecute(message: ExecuteMessage, startedAt: number): Promise<void> {
        await this.emit({
            type: "execution_started",
            correlationId: message.correlationId,
            ...executionIdentity(message),
        });

        await this.emit({
            type: "stream_delta",
            correlationId: message.correlationId,
            ...executionIdentity(message),
            batchSequence: 1,
            delta: mockDelta(message),
        });

        await this.emit({
            type: "complete",
            correlationId: message.correlationId,
            ...executionIdentity(message),
            finalRalState: "completed",
            publishedUserVisibleEvent: false,
            pendingDelegationsRemain: false,
            accumulatedRuntimeMs: Date.now() - startedAt,
            finalEventIds: [],
            keepWorkerWarm: false,
        });
    }

    private async writeTerminalError(
        message: ExecuteMessage,
        startedAt: number,
        error: { code: string; message: string; retryable: boolean }
    ): Promise<void> {
        await this.emit({
            type: "error",
            correlationId: message.correlationId,
            ...executionIdentity(message),
            terminal: true,
            error,
            finalRalState: "error",
            publishedUserVisibleEvent: false,
            pendingDelegationsRemain: false,
            accumulatedRuntimeMs: Date.now() - startedAt,
            finalEventIds: [],
            keepWorkerWarm: false,
        });
    }

    private async write(value: AgentWorkerOutboundProtocolMessage): Promise<void> {
        await writeAgentWorkerProtocolFrame(this.protocolSink, value);
    }

    private nextSequence(): number {
        this.sequence += 1;
        return this.sequence;
    }
}

class PublishResultCoordinator {
    private readonly bufferedResults = new Map<string, PublishResultMessage>();
    private readonly waiters = new Map<
        string,
        {
            resolve: (message: PublishResultMessage) => void;
            reject: (error: Error) => void;
            timeout: ReturnType<typeof setTimeout>;
        }
    >();

    waitForPublishResult(requestId: string, timeoutMs: number): Promise<PublishResultMessage> {
        const bufferedResult = this.bufferedResults.get(requestId);
        if (bufferedResult) {
            this.bufferedResults.delete(requestId);
            return Promise.resolve(bufferedResult);
        }

        return new Promise<PublishResultMessage>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.waiters.delete(requestId);
                reject(new Error(`Timed out waiting for publish_result ${requestId}`));
            }, timeoutMs);

            this.waiters.set(requestId, { resolve, reject, timeout });
        });
    }

    resolve(message: PublishResultMessage): void {
        const waiter = this.waiters.get(message.requestId);
        if (!waiter) {
            this.bufferedResults.set(message.requestId, message);
            return;
        }

        clearTimeout(waiter.timeout);
        this.waiters.delete(message.requestId);
        waiter.resolve(message);
    }

    rejectAll(error: Error): void {
        for (const [requestId, waiter] of this.waiters) {
            clearTimeout(waiter.timeout);
            this.waiters.delete(requestId);
            waiter.reject(error);
        }
    }
}

function createProtocolStdoutSink(): AgentWorkerProtocolFrameSink {
    const write = process.stdout.write.bind(process.stdout);
    const once = process.stdout.once.bind(process.stdout);

    return {
        write: (chunk) => write(chunk),
        once: (event, listener) => once(event, listener),
    };
}

function installProcessStdoutSuppressor(): void {
    const suppressedWrite: typeof process.stdout.write = ((
        _chunk: string | Uint8Array,
        encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
        callback?: (error?: Error | null) => void
    ) => {
        const writeCallback =
            typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
        if (writeCallback) {
            queueMicrotask(() => writeCallback());
        }
        return true;
    }) as typeof process.stdout.write;

    process.stdout.write = suppressedWrite;
}

function installConsoleSuppressor(): void {
    const noop = (): void => {};
    console.log = noop;
    console.info = noop;
    console.warn = noop;
    console.debug = noop;
    console.error = noop;
}

function executionIdentity(message: ExecuteMessage): {
    projectId: string;
    agentPubkey: string;
    conversationId: string;
    ralNumber: number;
} {
    return {
        projectId: message.projectId,
        agentPubkey: message.agentPubkey,
        conversationId: message.conversationId,
        ralNumber: message.ralNumber,
    };
}

function mockDelta(message: ExecuteMessage): string {
    return `Accepted ${message.triggeringEnvelope.transport} execution for ${message.conversationId}`;
}

initializeTelemetry(true, "tenex-agent-worker");

async function exitWithTelemetryFlush(code: number): Promise<never> {
    try {
        await shutdownTelemetry();
    } catch {
        // Swallow shutdown errors so the worker always exits with the intended code.
    }
    process.exit(code);
}

new AgentWorkerSession()
    .run()
    .then(() => {
        process.exitCode = 0;
        setImmediate(() => {
            const code = typeof process.exitCode === "number" ? process.exitCode : 0;
            void exitWithTelemetryFlush(code);
        });
    })
    .catch((error: unknown) => {
        const message = error instanceof Error ? error.stack ?? error.message : String(error);
        process.stderr.write(`${message}\n`);
        void exitWithTelemetryFlush(1);
    });
