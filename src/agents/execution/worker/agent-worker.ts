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

class AgentWorkerSession {
    private sequence = 0;
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

    private readonly activeExecutions = new Set<Promise<void>>();
    private executionSettled: Deferred<void> = createDeferred<void>();
    private exitWhenDrained = false;

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
        let pendingNext: Promise<IteratorResult<AgentWorkerProtocolMessage>> | undefined;
        let stdinExhausted = false;
        let shutdownRequested = false;

        while (true) {
            // Exit: stdin closed or shutdown requested, and no executions in flight.
            if (this.activeExecutions.size === 0 && (stdinExhausted || shutdownRequested || this.exitWhenDrained)) {
                if (shutdownRequested) {
                    this.nip46Results.rejectAll(new Error("worker shutdown requested"));
                }
                // Before returning we MUST drain the stdout writable buffer.
                // Without this, the terminal frame (or any tail-end emit) can
                // sit in Node's writable queue while process.exit cuts off the
                // pipe mid-frame. The daemon then sees
                // "worker frame receive failed: failed to fill whole buffer"
                // and marks the session failed even though the worker did
                // its job correctly.
                await drainProcessStdoutInline();
                return;
            }

            const acceptingMessages =
                !shutdownRequested && !stdinExhausted && !this.exitWhenDrained;
            if (acceptingMessages) {
                pendingNext ??= messages.next();
            }

            type RaceResult =
                | { kind: "message"; iteration: IteratorResult<AgentWorkerProtocolMessage> }
                | { kind: "execution_settled" };
            const waiters: Promise<RaceResult>[] = [];
            if (pendingNext) {
                waiters.push(
                    pendingNext.then((iteration) => ({ kind: "message" as const, iteration }))
                );
            }
            if (this.activeExecutions.size > 0) {
                waiters.push(
                    this.executionSettled.promise.then(() => ({ kind: "execution_settled" as const }))
                );
            }
            if (waiters.length === 0) {
                return;
            }

            const result = await Promise.race(waiters);
            if (result.kind === "execution_settled") {
                continue;
            }

            pendingNext = undefined;
            if (result.iteration.done) {
                stdinExhausted = true;
                continue;
            }

            // After shutdown or drain-exit was requested, drop any late-arriving messages.
            if (shutdownRequested || this.exitWhenDrained) {
                continue;
            }

            const nextExecution = this.handleIncomingMessage(result.iteration.value);
            if (nextExecution === "shutdown") {
                shutdownRequested = true;
                continue;
            }
            if (nextExecution) {
                this.trackExecution(nextExecution);
            }
        }
    }

    private trackExecution(promise: Promise<boolean>): void {
        let entry: Promise<void>;
        entry = promise
            .then(
                (keepRunning) => {
                    if (!keepRunning) {
                        this.exitWhenDrained = true;
                    }
                },
                (error: unknown) => {
                    this.exitWhenDrained = true;
                    process.stderr.write(
                        `agent-worker: unhandled execution error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
                    );
                }
            )
            .finally(() => {
                this.activeExecutions.delete(entry);
                const prev = this.executionSettled;
                this.executionSettled = createDeferred<void>();
                prev.resolve();
            });
        this.activeExecutions.add(entry);
    }

    private handleIncomingMessage(
        message: AgentWorkerProtocolMessage
    ): Promise<boolean> | "shutdown" | undefined {
        if (message.type === "ping") {
            void this.handlePing(message);
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
            // Rust's inbound runtime has already written the DelegationCompleted
            // journal record before dispatching this inject, so the journal is
            // authoritative for delegation state. Update the parent conversation
            // store's marker so the UI reflects the completion; the delegation
            // state itself is read from the journal on next query.
            const parentConversationId = message.conversationId;
            const parentStore = ConversationStore.get(parentConversationId);
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
                            parentConversationId,
                            completedAt: delegationCompletion.completedAt,
                            status: "completed",
                        },
                        message.agentPubkey,
                        message.ralNumber
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
                const result = await executeAgentWorkerRequest(message, this.emit);

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

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

initializeTelemetry(true, "tenex-agent-worker");

async function exitWithTelemetryFlush(code: number): Promise<never> {
    try {
        await shutdownTelemetry();
    } catch {
        // Swallow shutdown errors so the worker always exits with the intended code.
    }
    // Drain stdout before exiting. process.exit terminates immediately and the
    // daemon reads stdout until EOF; without an explicit drain a partially
    // buffered protocol frame can be cut mid-byte, manifesting daemon-side as
    // "worker frame receive failed: failed to fill whole buffer". The
    // daemon's frame decoder cannot recover from a half-frame.
    await drainProcessStdout();
    process.exit(code);
}

// Capture the *real* process.stdout.write before installProcessStdoutSuppressor
// replaces it with a no-op. We need this to drain the underlying pipe before
// process.exit; the suppressed write only queues a microtask callback and does
// not actually wait for the pipe to flush.
const realStdoutWrite = process.stdout.write.bind(process.stdout);

async function drainProcessStdoutInline(): Promise<void> {
    // Wait for the writable stream's internal queue to fully drain into the
    // underlying pipe. Used at end-of-run before returning so the terminal
    // frame is in the kernel pipe buffer before process.exit closes the FD.
    //
    // The process.exit() docs warn it "may not flush pending writes to
    // process.stdout", which manifests daemon-side as
    // "worker frame receive failed: failed to fill whole buffer" when the
    // tail of a frame gets cut off. We use a small Buffer write whose
    // callback only fires after libuv has accepted the write into the
    // kernel pipe, which guarantees the prior queued frames are also flushed
    // (Node serializes pipe writes).
    const stdout = process.stdout as unknown as {
        writableLength?: number;
        writableNeedDrain?: boolean;
    };
    if ((stdout.writableLength ?? 0) > 0 || stdout.writableNeedDrain === true) {
        await new Promise<void>((resolve) => {
            realStdoutWrite(Buffer.alloc(0), () => resolve());
        });
    }
    // After the userland buffer is empty, the libuv write to the OS pipe is
    // complete. Wait one tick to allow any followup writes (e.g. fsync hooks)
    // to settle before returning.
    await new Promise<void>((resolve) => setImmediate(resolve));
}

function drainProcessStdout(): Promise<void> {
    // process.exit() force-terminates; per the Node docs it "may not flush
    // pending writes to process.stdout". The worker emits its terminal frame
    // (waiting_for_delegation, complete, no_response, error) just before
    // returning from run(); a partial flush would manifest daemon-side as
    // "worker frame receive failed: failed to fill whole buffer". To prevent
    // that we (1) wait for the stdout writable buffer to fully drain, then
    // (2) end the stream so the OS sees a clean EOF instead of a kill.
    return new Promise<void>((resolve) => {
        const stdout = process.stdout;
        const finish = () => {
            // End signals EOF to the parent's read end. After end, process.exit
            // is safe — there is nothing left to flush.
            try {
                stdout.end(() => resolve());
            } catch {
                resolve();
            }
        };
        if (stdout.writableLength === 0) {
            finish();
            return;
        }
        // Empty write with a callback fires after the current write queue
        // drains; the callback runs when the kernel pipe has accepted the
        // bytes (not when the daemon has read them, but that's OK — the OS
        // pipe buffer carries them across).
        realStdoutWrite("", () => finish());
    });
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
