import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AgentInstance } from "@/agents/types";
import type { ExecutionContext } from "@/agents/execution/types";
import { ConversationStore } from "@/conversations/ConversationStore";
import {
    AGENT_WORKER_PROTOCOL_VERSION,
    type AgentWorkerProtocolMessage,
} from "@/events/runtime/AgentWorkerProtocol";
import { publishWorkerProtocolNostrEvent } from "@/nostr/WorkerPublishRequestPublisher";
import { config } from "@/services/ConfigService";
import type { ProjectContext } from "@/services/projects";
import { RALRegistry } from "@/services/ral";
import type { PendingDelegation, RALRegistryEntry } from "@/services/ral/types";
import { createProjectDTag } from "@/types/project-ids";
import {
    decodeAgentWorkerProtocolChunks,
    writeAgentWorkerProtocolFrame,
} from "./protocol";

const AGENT_WORKER_ENTRYPOINT = "src/agents/execution/worker/agent-worker.ts";
const DEFAULT_WORKER_BOOT_TIMEOUT_MS = 30_000;
const DEFAULT_WORKER_MESSAGE_TIMEOUT_MS = 120_000;
const DEFAULT_WORKER_EXIT_TIMEOUT_MS = 5_000;

type PublishRequestMessage = Extract<AgentWorkerProtocolMessage, { type: "publish_request" }>;
type ExecuteMessage = Extract<AgentWorkerProtocolMessage, { type: "execute" }>;
type DelegationRegisteredMessage = Extract<
    AgentWorkerProtocolMessage,
    { type: "delegation_registered" }
>;
type ExecutionStartedMessage = Extract<
    AgentWorkerProtocolMessage,
    { type: "execution_started" }
>;
type TerminalMessage = Extract<
    AgentWorkerProtocolMessage,
    { type: "complete" | "waiting_for_delegation" | "no_response" | "aborted" | "error" }
>;

export interface AgentWorkerDispatchParams {
    executionContext: ExecutionContext;
    projectCtx: ProjectContext;
    targetAgent: AgentInstance;
}

export interface AgentWorkerDispatchEligibilityParams extends AgentWorkerDispatchParams {
    activeRal?: RALRegistryEntry;
    resumptionClaim?: { ralNumber: number; token: string };
}

export interface AgentWorkerDispatchDependencies {
    spawnWorker?: typeof spawn;
    publishEvent?: typeof publishWorkerProtocolNostrEvent;
    env?: NodeJS.ProcessEnv;
    now?: () => number;
    bootTimeoutMs?: number;
    messageTimeoutMs?: number;
    exitTimeoutMs?: number;
}

export function isAgentWorkerDispatchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const value = env.TENEX_AGENT_WORKER?.toLowerCase();
    return value === "1" || value === "true" || value === "yes";
}

export function getAgentWorkerDispatchIneligibility(
    params: AgentWorkerDispatchEligibilityParams
): string | undefined {
    if (!isHexPubkey(params.targetAgent.pubkey)) {
        return "target_agent_pubkey_not_hex";
    }

    if (params.activeRal) {
        return "active_ral_present";
    }

    if (params.resumptionClaim) {
        return "resumption_claim_present";
    }

    if (params.executionContext.isDelegationCompletion) {
        return "delegation_completion";
    }

    if (params.executionContext.hasPendingDelegations) {
        return "pending_delegations_present";
    }

    if (params.executionContext.triggeringEnvelope.metadata.isKillSignal === true) {
        return "kill_signal";
    }

    const conversation = ConversationStore.get(params.executionContext.conversationId);
    if (!conversation || conversation.getMessageCount() !== 1) {
        return "not_fresh_initial_conversation";
    }

    return undefined;
}

export async function executeDispatchViaAgentWorker(
    params: AgentWorkerDispatchParams,
    dependencies: AgentWorkerDispatchDependencies = {}
): Promise<void> {
    const env = dependencies.env ?? process.env;
    const spawnWorker = dependencies.spawnWorker ?? spawn;
    const publishEvent = dependencies.publishEvent ?? publishWorkerProtocolNostrEvent;
    const now = dependencies.now ?? Date.now;
    const bootTimeoutMs = dependencies.bootTimeoutMs ?? DEFAULT_WORKER_BOOT_TIMEOUT_MS;
    const messageTimeoutMs = dependencies.messageTimeoutMs ?? DEFAULT_WORKER_MESSAGE_TIMEOUT_MS;
    const exitTimeoutMs = dependencies.exitTimeoutMs ?? DEFAULT_WORKER_EXIT_TIMEOUT_MS;
    const projectId = resolveProjectId(params.projectCtx);
    const correlationId = `worker-dispatch-${randomUUID()}`;
    const ralNumber = 1;
    const ralClaimToken = `worker-claim-${randomUUID()}`;
    let sequence = 0;
    let parentRalSeeded = false;
    const publishContentByEventId = new Map<string, string>();
    let terminal: TerminalMessage | undefined;

    const worker = spawnWorker(
        env.TENEX_AGENT_WORKER_BUN_BIN ?? process.execPath,
        ["run", env.TENEX_AGENT_WORKER_ENTRYPOINT ?? AGENT_WORKER_ENTRYPOINT],
        {
            cwd: env.TENEX_AGENT_WORKER_CWD ?? process.cwd(),
            env: {
                ...env,
                TENEX_AGENT_WORKER_ENGINE: "agent",
                TENEX_BASE_DIR: config.getGlobalPath(),
            },
            stdio: ["pipe", "pipe", "pipe"],
        }
    );
    let stderr = "";
    worker.stderr.on("data", (chunk: Buffer) => {
        stderr = tail(`${stderr}${chunk.toString("utf8")}`, 16_384);
    });

    const messages = decodeAgentWorkerProtocolChunks(worker.stdout);

    try {
        const ready = await nextWorkerMessage(messages, "agent worker ready", bootTimeoutMs);
        if (ready.type !== "ready") {
            throw new Error(`Agent worker booted with unexpected frame: ${ready.type}`);
        }
        if (ready.protocol.version !== AGENT_WORKER_PROTOCOL_VERSION) {
            throw new Error(
                `Agent worker protocol version mismatch: expected ${AGENT_WORKER_PROTOCOL_VERSION}, got ${ready.protocol.version}`
            );
        }

        const executeMessage: ExecuteMessage = {
            version: AGENT_WORKER_PROTOCOL_VERSION,
            type: "execute",
            correlationId,
            sequence: nextSequence(),
            timestamp: now(),
            projectId,
            projectBasePath: params.projectCtx.agentRegistry.getBasePath(),
            metadataPath: params.projectCtx.agentRegistry.getMetadataPath(),
            agentPubkey: params.targetAgent.pubkey,
            conversationId: params.executionContext.conversationId,
            ralNumber,
            ralClaimToken,
            triggeringEnvelope: params.executionContext
                .triggeringEnvelope as ExecuteMessage["triggeringEnvelope"],
            executionFlags: {
                isDelegationCompletion: params.executionContext.isDelegationCompletion === true,
                hasPendingDelegations: params.executionContext.hasPendingDelegations === true,
                debug: params.executionContext.debug === true,
            },
        };
        await writeAgentWorkerProtocolFrame(worker.stdin, executeMessage);

        while (!terminal) {
            const message = await nextWorkerMessage(
                messages,
                "agent worker terminal frame",
                messageTimeoutMs
            );

            if (message.type === "execution_started") {
                ensureParentRalSeeded(message);
                continue;
            }

            if (message.type === "publish_request") {
                ensureParentRalSeeded(message);
                await handlePublishRequest(message);
                continue;
            }

            if (message.type === "delegation_registered") {
                ensureParentRalSeeded(message);
                handleDelegationRegistered(message);
                continue;
            }

            if (isTerminalMessage(message)) {
                terminal = message;
            }
        }

        refreshParentConversationFromDisk(projectId, params.executionContext.conversationId);
        finalizeParentRalState(terminal);

        if (terminal.type === "error") {
            throw new Error(`Agent worker execution failed: ${terminal.error.message}`);
        }

        if (terminal.type === "aborted") {
            throw new Error(`Agent worker execution aborted: ${terminal.abortReason}`);
        }

        worker.stdin.end();
        const exitStatus = await waitForWorkerExit(worker, exitTimeoutMs);
        if (exitStatus.code !== 0) {
            throw new Error(
                `Agent worker exited with code ${exitStatus.code ?? "null"} signal ${exitStatus.signal ?? "null"}${formatStderr(stderr)}`
            );
        }
    } catch (error) {
        clearParentRalAfterNonTerminalFailure();
        throw new Error(
            `Agent worker dispatch failed: ${error instanceof Error ? error.message : String(error)}${formatStderr(stderr)}`,
            { cause: error }
        );
    } finally {
        stopWorker(worker);
    }

    function nextSequence(): number {
        sequence += 1;
        return sequence;
    }

    function ensureParentRalSeeded(
        message: ExecutionStartedMessage | PublishRequestMessage | DelegationRegisteredMessage
    ): void {
        if (parentRalSeeded) {
            return;
        }

        const ralRegistry = RALRegistry.getInstance();
        ralRegistry.seed({
            agentPubkey: message.agentPubkey,
            conversationId: message.conversationId,
            projectId: createProjectDTag(message.projectId),
            ralNumber: message.ralNumber,
            originalTriggeringEventId:
                params.executionContext.triggeringEnvelope.message.nativeId,
        });
        ralRegistry.setStreaming(
            message.agentPubkey,
            message.conversationId,
            message.ralNumber,
            true
        );
        parentRalSeeded = true;
    }

    async function handlePublishRequest(message: PublishRequestMessage): Promise<void> {
        try {
            const eventIds = await publishEvent(message.event, params.targetAgent);
            const primaryEventId = eventIds[0];
            if (primaryEventId) {
                publishContentByEventId.set(primaryEventId, message.event.content);
            }
            await writePublishResult(message, "published", eventIds);
        } catch (error) {
            await writePublishResult(message, "failed", [], {
                code: "publish_failed",
                message: error instanceof Error ? error.message : String(error),
                retryable: true,
            });
            throw error;
        }
    }

    async function writePublishResult(
        request: PublishRequestMessage,
        status: "accepted" | "published" | "failed" | "timeout",
        eventIds: string[],
        error?: { code: string; message: string; retryable: boolean }
    ): Promise<void> {
        await writeAgentWorkerProtocolFrame(worker.stdin, {
            version: AGENT_WORKER_PROTOCOL_VERSION,
            type: "publish_result",
            correlationId: request.correlationId,
            sequence: nextSequence(),
            timestamp: now(),
            requestId: request.requestId,
            requestSequence: request.sequence,
            status,
            eventIds,
            ...(error ? { error } : {}),
        } satisfies AgentWorkerProtocolMessage);
    }

    function handleDelegationRegistered(message: DelegationRegisteredMessage): void {
        const pendingDelegation: PendingDelegation = {
            ...(message.delegationType === "standard"
                ? {}
                : { type: message.delegationType }),
            delegationConversationId: message.delegationConversationId,
            recipientPubkey: message.recipientPubkey,
            senderPubkey: message.agentPubkey,
            prompt: publishContentByEventId.get(message.delegationConversationId) ?? "",
            ralNumber: message.ralNumber,
        };

        RALRegistry.getInstance().mergePendingDelegations(
            message.agentPubkey,
            message.conversationId,
            message.ralNumber,
            [pendingDelegation]
        );
    }

    function finalizeParentRalState(message: TerminalMessage): void {
        const ralRegistry = RALRegistry.getInstance();
        if (message.type === "waiting_for_delegation") {
            ralRegistry.setStreaming(
                message.agentPubkey,
                message.conversationId,
                message.ralNumber,
                false
            );
            return;
        }

        ralRegistry.clearRAL(message.agentPubkey, message.conversationId, message.ralNumber);
    }

    function clearParentRalAfterNonTerminalFailure(): void {
        if (!parentRalSeeded || terminal) {
            return;
        }

        RALRegistry.getInstance().clearRAL(
            params.targetAgent.pubkey,
            params.executionContext.conversationId,
            ralNumber
        );
    }
}

function resolveProjectId(projectCtx: ProjectContext): string {
    const dTag = projectCtx.project.dTag ?? projectCtx.project.tagValue("d");
    if (!dTag) {
        throw new Error("Project missing d-tag");
    }
    return dTag;
}

async function nextWorkerMessage(
    messages: AsyncGenerator<AgentWorkerProtocolMessage>,
    label: string,
    timeoutMs: number
): Promise<AgentWorkerProtocolMessage> {
    const result = await withTimeout(messages.next(), label, timeoutMs);
    if (result.done) {
        throw new Error(`Agent worker stdout ended before ${label}`);
    }
    return result.value;
}

async function waitForWorkerExit(
    worker: ChildProcessWithoutNullStreams,
    timeoutMs: number
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (worker.exitCode !== null || worker.signalCode !== null) {
        return { code: worker.exitCode, signal: worker.signalCode };
    }

    const [code, signal] = (await withTimeout(
        once(worker, "exit"),
        "agent worker exit",
        timeoutMs
    )) as [number | null, NodeJS.Signals | null];
    return { code, signal };
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
            reject(new Error(`Timed out waiting for ${label}`));
        }, timeoutMs);
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

function refreshParentConversationFromDisk(projectId: string, conversationId: string): void {
    const conversation = ConversationStore.get(conversationId);
    if (conversation) {
        conversation.load(createProjectDTag(projectId), conversationId);
    }
}

function isTerminalMessage(message: AgentWorkerProtocolMessage): message is TerminalMessage {
    return (
        message.type === "complete" ||
        message.type === "waiting_for_delegation" ||
        message.type === "no_response" ||
        message.type === "aborted" ||
        message.type === "error"
    );
}

function isHexPubkey(value: string): boolean {
    return /^[0-9a-f]{64}$/.test(value);
}

function formatStderr(stderr: string): string {
    return stderr.trim().length > 0 ? `\nWorker stderr:\n${stderr.trim()}` : "";
}

function tail(value: string, maxLength: number): string {
    return value.length > maxLength ? value.slice(value.length - maxLength) : value;
}
