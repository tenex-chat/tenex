import { z } from "zod";
import type { InboundEnvelope } from "./InboundEnvelope";

export const AGENT_WORKER_PROTOCOL_VERSION = 1;
export const AGENT_WORKER_PROTOCOL_ENCODING = "length-prefixed-json";
export const AGENT_WORKER_MAX_FRAME_BYTES = 1_048_576;
export const AGENT_WORKER_FRAME_LENGTH_PREFIX_BYTES = 4;
export const AGENT_WORKER_STREAM_BATCH_MS = 250;
export const AGENT_WORKER_STREAM_BATCH_MAX_BYTES = 8_192;

export const DAEMON_TO_WORKER_MESSAGE_TYPES = [
    "execute",
    "abort",
    "inject",
    "shutdown",
    "ping",
    "publish_result",
    "ack",
] as const;

export const WORKER_TO_DAEMON_MESSAGE_TYPES = [
    "ready",
    "boot_error",
    "pong",
    "execution_started",
    "stream_delta",
    "reasoning_delta",
    "tool_call_started",
    "tool_call_completed",
    "tool_call_failed",
    "delegation_registered",
    "waiting_for_delegation",
    "publish_request",
    "published",
    "complete",
    "silent_completion_requested",
    "no_response",
    "aborted",
    "error",
    "heartbeat",
] as const;

export type AgentWorkerProtocolDirection = "daemon_to_worker" | "worker_to_daemon";

const hexPubkeySchema = z.string().regex(/^[0-9a-f]{64}$/);
const positiveIntegerSchema = z.number().int().positive();
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const utf8Encoder = new TextEncoder();

const runtimeTransportSchema = z.enum(["local", "mcp", "nostr", "telegram"]);

const principalRefSchema = z
    .object({
        id: z.string().min(1),
        transport: runtimeTransportSchema,
        linkedPubkey: z.string().optional(),
        displayName: z.string().optional(),
        username: z.string().optional(),
        kind: z.enum(["agent", "human", "system"]).optional(),
    })
    .passthrough();

const channelRefSchema = z
    .object({
        id: z.string().min(1),
        transport: runtimeTransportSchema,
        kind: z.enum(["conversation", "dm", "group", "project", "topic"]),
        projectBinding: z.string().optional(),
    })
    .passthrough();

const externalMessageRefSchema = z
    .object({
        id: z.string().min(1),
        transport: runtimeTransportSchema,
        nativeId: z.string().min(1),
        replyToId: z.string().optional(),
    })
    .passthrough();

export const InboundEnvelopeProtocolSchema = z
    .object({
        transport: runtimeTransportSchema,
        principal: principalRefSchema,
        channel: channelRefSchema,
        message: externalMessageRefSchema,
        recipients: z.array(principalRefSchema),
        content: z.string(),
        occurredAt: nonNegativeIntegerSchema,
        capabilities: z.array(z.string()),
        metadata: z.record(z.string(), z.unknown()),
    })
    .passthrough() satisfies z.ZodType<InboundEnvelope>;

const protocolConfigSchema = z
    .object({
        version: z.literal(AGENT_WORKER_PROTOCOL_VERSION),
        encoding: z.literal(AGENT_WORKER_PROTOCOL_ENCODING),
        maxFrameBytes: z.literal(AGENT_WORKER_MAX_FRAME_BYTES),
        streamBatchMs: z.literal(AGENT_WORKER_STREAM_BATCH_MS),
        streamBatchMaxBytes: z.literal(AGENT_WORKER_STREAM_BATCH_MAX_BYTES),
    })
    .passthrough();

const commonFrameShape = {
    version: z.literal(AGENT_WORKER_PROTOCOL_VERSION),
    type: z.string().min(1),
    correlationId: z.string().min(1),
    sequence: nonNegativeIntegerSchema,
    timestamp: nonNegativeIntegerSchema,
} satisfies z.ZodRawShape;

const executionIdentityShape = {
    projectId: z.string().min(1),
    agentPubkey: hexPubkeySchema,
    conversationId: z.string().min(1),
    ralNumber: positiveIntegerSchema,
} satisfies z.ZodRawShape;

const terminalShape = {
    finalRalState: z.enum(["completed", "waiting_for_delegation", "no_response", "aborted", "error"]),
    publishedUserVisibleEvent: z.boolean(),
    pendingDelegationsRemain: z.boolean(),
    accumulatedRuntimeMs: nonNegativeIntegerSchema,
    finalEventIds: z.array(z.string()),
    keepWorkerWarm: z.boolean(),
} satisfies z.ZodRawShape;

const workerErrorSchema = z
    .object({
        code: z.string().min(1),
        message: z.string().min(1),
        retryable: z.boolean(),
    })
    .passthrough();

const contentRefSchema = z
    .object({
        path: z.string().min(1),
        byteLength: positiveIntegerSchema,
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .passthrough();

const publishEventSchema = z
    .object({
        id: z.string().regex(/^[0-9a-f]{64}$/),
        pubkey: hexPubkeySchema,
        kind: nonNegativeIntegerSchema,
        content: z.string(),
        tags: z.array(z.array(z.string())),
        created_at: nonNegativeIntegerSchema,
        sig: z.string().regex(/^[0-9a-f]{128}$/),
    })
    .passthrough();

// Let Zod infer this generic return type; spelling it out collapses the protocol
// discriminated union and breaks Extract<..., { type: ... }> call sites.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function frameSchema<const Type extends string, Shape extends z.ZodRawShape>(
    type: Type,
    shape: Shape
) {
    return z
        .object({
            ...commonFrameShape,
            type: z.literal(type),
            ...shape,
        })
        .passthrough();
}

const executeMessageSchema = frameSchema("execute", {
    projectId: z.string().min(1),
    projectBasePath: z.string().min(1),
    metadataPath: z.string().min(1),
    agentPubkey: hexPubkeySchema,
    conversationId: z.string().min(1),
    ralNumber: positiveIntegerSchema,
    ralClaimToken: z.string().min(1),
    triggeringEnvelope: InboundEnvelopeProtocolSchema,
    executionFlags: z
        .object({
            isDelegationCompletion: z.boolean(),
            hasPendingDelegations: z.boolean(),
            debug: z.boolean(),
        })
        .passthrough(),
});

const pingMessageSchema = frameSchema("ping", {
    timeoutMs: positiveIntegerSchema,
});

const injectMessageSchema = frameSchema("inject", {
    ...executionIdentityShape,
    injectionId: z.string().min(1),
    leaseToken: z.string().min(1),
    role: z.enum(["user", "system"]),
    content: z.string().min(1),
});

const abortMessageSchema = frameSchema("abort", {
    ...executionIdentityShape,
    reason: z.string().min(1),
    gracefulTimeoutMs: positiveIntegerSchema,
});

const shutdownMessageSchema = frameSchema("shutdown", {
    reason: z.string().min(1),
    forceKillTimeoutMs: positiveIntegerSchema,
});

const publishResultMessageSchema = frameSchema("publish_result", {
    requestId: z.string().min(1),
    requestSequence: nonNegativeIntegerSchema,
    status: z.enum(["accepted", "published", "failed", "timeout"]),
    eventIds: z.array(z.string()),
    error: workerErrorSchema.optional(),
}).superRefine((message, context) => {
    const hasError = message.error !== undefined;
    if ((message.status === "failed" || message.status === "timeout") && !hasError) {
        context.addIssue({
            code: "custom",
            path: ["error"],
            message: "publish_result failed or timeout status requires error",
        });
    }
    if ((message.status === "accepted" || message.status === "published") && hasError) {
        context.addIssue({
            code: "custom",
            path: ["error"],
            message: "publish_result accepted or published status must not include error",
        });
    }
});

const ackMessageSchema = frameSchema("ack", {
    acknowledgedSequence: nonNegativeIntegerSchema,
    durable: z.boolean(),
});

const readyMessageSchema = frameSchema("ready", {
    workerId: z.string().min(1),
    pid: positiveIntegerSchema,
    protocol: protocolConfigSchema,
});

const bootErrorMessageSchema = frameSchema("boot_error", {
    error: workerErrorSchema,
});

const pongMessageSchema = frameSchema("pong", {
    replyingToSequence: nonNegativeIntegerSchema,
});

const executionStartedMessageSchema = frameSchema("execution_started", {
    ...executionIdentityShape,
});

const streamDeltaMessageSchema = frameSchema("stream_delta", {
    ...executionIdentityShape,
    batchSequence: positiveIntegerSchema,
    delta: z.string().min(1).optional(),
    contentRef: contentRefSchema.optional(),
}).superRefine((message, context) => {
    const hasDelta = message.delta !== undefined;
    const hasContentRef = message.contentRef !== undefined;
    if (hasDelta === hasContentRef) {
        context.addIssue({
            code: "custom",
            path: ["delta", "contentRef"],
            message: "stream_delta requires exactly one of delta or contentRef",
        });
    }
    if (
        hasDelta &&
        utf8Encoder.encode(message.delta).byteLength > AGENT_WORKER_STREAM_BATCH_MAX_BYTES
    ) {
        context.addIssue({
            code: "custom",
            path: ["delta"],
            message: `stream_delta delta exceeds ${AGENT_WORKER_STREAM_BATCH_MAX_BYTES} bytes`,
        });
    }
});

const reasoningDeltaMessageSchema = frameSchema("reasoning_delta", {
    ...executionIdentityShape,
    batchSequence: positiveIntegerSchema,
    delta: z.string().min(1),
    visibility: z.enum(["debug", "operator", "client"]),
});

const toolCallStartedMessageSchema = frameSchema("tool_call_started", {
    ...executionIdentityShape,
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
});

const toolCallCompletedMessageSchema = frameSchema("tool_call_completed", {
    ...executionIdentityShape,
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    durationMs: nonNegativeIntegerSchema,
    resultSummary: z.string().optional(),
});

const toolCallFailedMessageSchema = frameSchema("tool_call_failed", {
    ...executionIdentityShape,
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    error: workerErrorSchema,
});

const delegationRegisteredMessageSchema = frameSchema("delegation_registered", {
    ...executionIdentityShape,
    delegationConversationId: z.string().min(1),
    recipientPubkey: hexPubkeySchema,
    delegationType: z.enum(["standard", "followup", "external", "ask"]),
});

const waitingForDelegationMessageSchema = frameSchema("waiting_for_delegation", {
    ...executionIdentityShape,
    pendingDelegations: z.array(z.string().min(1)),
    ...terminalShape,
    finalRalState: z.literal("waiting_for_delegation"),
});

export const RUNTIME_EVENT_CLASSES = [
    "complete",
    "conversation",
    "ask",
    "error",
    "tool_use",
    "delegation",
    "delegate_followup",
    "lesson",
    "stream_text_delta",
] as const;
export const CONVERSATION_VARIANTS = ["primary", "reasoning"] as const;
export type RuntimeEventClass = (typeof RUNTIME_EVENT_CLASSES)[number];
export type ConversationVariant = (typeof CONVERSATION_VARIANTS)[number];

const runtimeEventClassSchema = z.enum(RUNTIME_EVENT_CLASSES);
const conversationVariantSchema = z.enum(CONVERSATION_VARIANTS);

const publishRequestMessageSchema = frameSchema("publish_request", {
    ...executionIdentityShape,
    requestId: z.string().min(1),
    requiresEventId: z.boolean(),
    timeoutMs: positiveIntegerSchema,
    runtimeEventClass: runtimeEventClassSchema,
    conversationVariant: conversationVariantSchema.optional(),
    event: publishEventSchema,
}).superRefine((message, context) => {
    const isConversation = message.runtimeEventClass === "conversation";
    const hasVariant = message.conversationVariant !== undefined;
    if (isConversation && !hasVariant) {
        context.addIssue({
            code: "custom",
            path: ["conversationVariant"],
            message: "publish_request with runtimeEventClass=conversation requires conversationVariant",
        });
    }
    if (!isConversation && hasVariant) {
        context.addIssue({
            code: "custom",
            path: ["conversationVariant"],
            message: "publish_request only carries conversationVariant when runtimeEventClass=conversation",
        });
    }
});

const publishedMessageSchema = frameSchema("published", {
    ...executionIdentityShape,
    mode: z.enum(["direct_worker_publish", "rust_publish_request"]),
    eventIds: z.array(z.string().min(1)),
});

const completeMessageSchema = frameSchema("complete", {
    ...executionIdentityShape,
    ...terminalShape,
    finalRalState: z.literal("completed"),
});

const silentCompletionRequestedMessageSchema = frameSchema("silent_completion_requested", {
    ...executionIdentityShape,
    reason: z.string().min(1),
});

const noResponseMessageSchema = frameSchema("no_response", {
    ...executionIdentityShape,
    ...terminalShape,
    finalRalState: z.literal("no_response"),
});

const abortedMessageSchema = frameSchema("aborted", {
    ...executionIdentityShape,
    abortReason: z.string().min(1),
    ...terminalShape,
    finalRalState: z.literal("aborted"),
});

const errorMessageSchema = frameSchema("error", {
    ...executionIdentityShape,
    terminal: z.boolean(),
    error: workerErrorSchema,
    ...terminalShape,
    finalRalState: z.literal("error"),
});

const heartbeatMessageSchema = frameSchema("heartbeat", {
    ...executionIdentityShape,
    state: z.enum(["starting", "streaming", "acting", "waiting", "idle"]),
    activeToolCount: nonNegativeIntegerSchema,
    accumulatedRuntimeMs: nonNegativeIntegerSchema,
});

export const AgentWorkerProtocolMessageSchema = z.union([
    executeMessageSchema,
    pingMessageSchema,
    injectMessageSchema,
    abortMessageSchema,
    shutdownMessageSchema,
    publishResultMessageSchema,
    ackMessageSchema,
    readyMessageSchema,
    bootErrorMessageSchema,
    pongMessageSchema,
    executionStartedMessageSchema,
    streamDeltaMessageSchema,
    reasoningDeltaMessageSchema,
    toolCallStartedMessageSchema,
    toolCallCompletedMessageSchema,
    toolCallFailedMessageSchema,
    delegationRegisteredMessageSchema,
    waitingForDelegationMessageSchema,
    publishRequestMessageSchema,
    publishedMessageSchema,
    completeMessageSchema,
    silentCompletionRequestedMessageSchema,
    noResponseMessageSchema,
    abortedMessageSchema,
    errorMessageSchema,
    heartbeatMessageSchema,
]);

export const AgentWorkerProtocolFixtureSchema = z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    protocol: protocolConfigSchema.extend({
        heartbeatIntervalMs: positiveIntegerSchema,
        missedHeartbeatThreshold: positiveIntegerSchema,
        workerBootTimeoutMs: positiveIntegerSchema,
        gracefulAbortTimeoutMs: positiveIntegerSchema,
        forceKillTimeoutMs: positiveIntegerSchema,
        idleTtlMs: positiveIntegerSchema,
    }),
    execution: z.object({
        correlationId: z.string().min(1),
        projectId: z.string().min(1),
        projectBasePath: z.string().min(1),
        metadataPath: z.string().min(1),
        agentPubkey: hexPubkeySchema,
        conversationId: z.string().min(1),
        ralNumber: positiveIntegerSchema,
        ralClaimToken: z.string().min(1),
    }),
    triggeringEnvelope: InboundEnvelopeProtocolSchema,
    validMessages: z.array(
        z.object({
            name: z.string().min(1),
            direction: z.enum(["daemon_to_worker", "worker_to_daemon"]),
            message: AgentWorkerProtocolMessageSchema,
        })
    ),
    invalidMessages: z.array(
        z.object({
            name: z.string().min(1),
            message: z.unknown(),
        })
    ),
});

export type AgentWorkerProtocolMessage = z.infer<typeof AgentWorkerProtocolMessageSchema>;
export type AgentWorkerProtocolFixture = z.infer<typeof AgentWorkerProtocolFixtureSchema>;

const daemonToWorkerTypes = new Set<string>(DAEMON_TO_WORKER_MESSAGE_TYPES);
const workerToDaemonTypes = new Set<string>(WORKER_TO_DAEMON_MESSAGE_TYPES);

export function getAgentWorkerProtocolDirection(message: {
    type: string;
}): AgentWorkerProtocolDirection {
    if (daemonToWorkerTypes.has(message.type)) {
        return "daemon_to_worker";
    }
    if (workerToDaemonTypes.has(message.type)) {
        return "worker_to_daemon";
    }
    throw new Error(`Unknown agent worker protocol message type: ${message.type}`);
}

export function parseAgentWorkerProtocolMessage(value: unknown): AgentWorkerProtocolMessage {
    return AgentWorkerProtocolMessageSchema.parse(value);
}

export class AgentWorkerProtocolFrameError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AgentWorkerProtocolFrameError";
    }
}

export function canonicalAgentWorkerProtocolJson(value: unknown): string {
    return canonicalJsonStringify(value);
}

export function encodeAgentWorkerProtocolFrame(value: unknown): Uint8Array {
    const message = parseAgentWorkerProtocolMessage(value);
    const payload = new TextEncoder().encode(canonicalAgentWorkerProtocolJson(message));
    const maxPayloadBytes = AGENT_WORKER_MAX_FRAME_BYTES - AGENT_WORKER_FRAME_LENGTH_PREFIX_BYTES;

    if (payload.byteLength > maxPayloadBytes) {
        throw new AgentWorkerProtocolFrameError(
            `Agent worker protocol payload exceeds ${maxPayloadBytes} bytes`
        );
    }

    const frame = new Uint8Array(AGENT_WORKER_FRAME_LENGTH_PREFIX_BYTES + payload.byteLength);
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    view.setUint32(0, payload.byteLength, false);
    frame.set(payload, AGENT_WORKER_FRAME_LENGTH_PREFIX_BYTES);
    return frame;
}

export function decodeAgentWorkerProtocolFrame(frame: Uint8Array): AgentWorkerProtocolMessage {
    if (frame.byteLength < AGENT_WORKER_FRAME_LENGTH_PREFIX_BYTES) {
        throw new AgentWorkerProtocolFrameError("Agent worker protocol frame is missing length prefix");
    }

    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const payloadByteLength = view.getUint32(0, false);
    const maxPayloadBytes = AGENT_WORKER_MAX_FRAME_BYTES - AGENT_WORKER_FRAME_LENGTH_PREFIX_BYTES;

    if (payloadByteLength > maxPayloadBytes) {
        throw new AgentWorkerProtocolFrameError(
            `Agent worker protocol payload exceeds ${maxPayloadBytes} bytes`
        );
    }

    const expectedFrameLength = AGENT_WORKER_FRAME_LENGTH_PREFIX_BYTES + payloadByteLength;
    if (frame.byteLength !== expectedFrameLength) {
        throw new AgentWorkerProtocolFrameError(
            `Agent worker protocol frame length mismatch: expected ${expectedFrameLength}, got ${frame.byteLength}`
        );
    }

    const payload = frame.subarray(AGENT_WORKER_FRAME_LENGTH_PREFIX_BYTES);
    const json = new TextDecoder("utf-8", { fatal: true }).decode(payload);
    return parseAgentWorkerProtocolMessage(JSON.parse(json));
}

function canonicalJsonStringify(value: unknown): string {
    if (value === null) {
        return "null";
    }

    if (typeof value === "string") {
        return JSON.stringify(value);
    }

    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw new AgentWorkerProtocolFrameError("Cannot encode non-finite JSON number");
        }
        return JSON.stringify(value);
    }

    if (typeof value === "boolean") {
        return value ? "true" : "false";
    }

    if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJsonStringify(item)).join(",")}]`;
    }

    if (typeof value === "object") {
        const object = value as Record<string, unknown>;
        const keys = Object.keys(object).sort();
        return `{${keys
            .map((key) => {
                const fieldValue = object[key];
                if (fieldValue === undefined) {
                    throw new AgentWorkerProtocolFrameError("Cannot encode undefined JSON field");
                }
                return `${JSON.stringify(key)}:${canonicalJsonStringify(fieldValue)}`;
            })
            .join(",")}}`;
    }

    throw new AgentWorkerProtocolFrameError(`Cannot encode ${typeof value} as JSON`);
}
