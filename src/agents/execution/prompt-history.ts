import type {
    ModelMessage,
} from "ai";
import type { Span } from "@opentelemetry/api";
import type { ConversationStore } from "@/conversations/ConversationStore";
import type {
    AgentPromptHistoryState,
    FrozenPromptMessage,
} from "@/conversations/types";
import type { CompiledMessages } from "./MessageCompiler";

type AddressablePromptMessage = ModelMessage & {
    id?: string;
    sourceRecordId?: string;
    eventId?: string;
};

export interface RuntimePromptOverlay {
    message: ModelMessage;
    overlayType: string;
    persistInHistory?: boolean;
}

export interface PromptHistoryAssemblyResult {
    messages: ModelMessage[];
    didMutateHistory: boolean;
    reminderStateChanged: boolean;
}

function isSystemReminderOverlay(
    message: FrozenPromptMessage | RuntimePromptOverlay
): boolean {
    if ("source" in message) {
        return message.source.kind === "runtime-overlay"
            && message.source.overlayType === "system-reminders";
    }

    return message.overlayType === "system-reminders";
}

function toPromptHistorySafeValue(
    value: unknown,
    seen: WeakSet<object> = new WeakSet()
): unknown {
    if (
        value === null
        || typeof value === "string"
        || typeof value === "number"
        || typeof value === "boolean"
    ) {
        return value;
    }

    if (typeof value === "bigint") {
        return value.toString();
    }

    if (
        value === undefined
        || typeof value === "function"
        || typeof value === "symbol"
    ) {
        return undefined;
    }

    if (value instanceof Date) {
        return value.toISOString();
    }

    if (value instanceof URL) {
        return value.toString();
    }

    if (value instanceof Error) {
        const normalizedCause = toPromptHistorySafeValue(value.cause, seen);
        const enumerableEntries = Object.entries(value).flatMap(([key, entryValue]) => {
            const normalizedEntry = toPromptHistorySafeValue(entryValue, seen);
            return normalizedEntry === undefined ? [] : [[key, normalizedEntry] as const];
        });

        return {
            name: value.name,
            message: value.message,
            ...(value.stack ? { stack: value.stack } : {}),
            ...(normalizedCause !== undefined ? { cause: normalizedCause } : {}),
            ...Object.fromEntries(enumerableEntries),
        };
    }

    if (Array.isArray(value)) {
        return value.map((entry) => {
            const normalizedEntry = toPromptHistorySafeValue(entry, seen);
            return normalizedEntry === undefined ? null : normalizedEntry;
        });
    }

    if (ArrayBuffer.isView(value)) {
        return Array.from(
            new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        );
    }

    if (value instanceof ArrayBuffer) {
        return Array.from(new Uint8Array(value));
    }

    if (typeof value === "object") {
        if (seen.has(value)) {
            return "[Circular]";
        }
        seen.add(value);

        return Object.fromEntries(
            Object.entries(value).flatMap(([key, entryValue]) => {
                const normalizedEntry = toPromptHistorySafeValue(entryValue, seen);
                return normalizedEntry === undefined ? [] : [[key, normalizedEntry] as const];
            })
        );
    }

    return String(value);
}

function clonePromptHistoryValue<T>(value: T): T {
    try {
        return structuredClone(value);
    } catch {
        return toPromptHistorySafeValue(value) as T;
    }
}

function cloneMessageContent(message: ModelMessage): ModelMessage["content"] {
    return clonePromptHistoryValue(message.content);
}

function serializeMessageContent(content: ModelMessage["content"]): string {
    return JSON.stringify(toPromptHistorySafeValue(content));
}

function syncFrozenCanonicalMessage(params: {
    history: AgentPromptHistoryState;
    message: AddressablePromptMessage;
    fallbackIndex: number;
}): boolean {
    const { history, message, fallbackIndex } = params;
    const sourceMessageId = getSourceMessageId(message, fallbackIndex);
    const frozenIndex = history.messages.findIndex(
        (candidate) =>
            candidate.source.kind === "canonical"
            && candidate.source.sourceMessageId === sourceMessageId
    );

    if (frozenIndex < 0) {
        return false;
    }

    const frozenMessage = history.messages[frozenIndex];
    const nextContent = cloneMessageContent(message);
    if (
        frozenMessage.role === message.role
        && serializeMessageContent(nextContent) === serializeMessageContent(frozenMessage.content)
    ) {
        return false;
    }

    history.messages[frozenIndex] = {
        ...frozenMessage,
        role: message.role,
        content: nextContent,
    };
    return true;
}

function nextPromptHistoryId(history: AgentPromptHistoryState): string {
    history.nextSequence += 1;
    return `prompt:${history.nextSequence}`;
}

function getSourceMessageId(
    message: AddressablePromptMessage,
    fallbackIndex: number
): string {
    if (typeof message.id === "string" && message.id.length > 0) {
        return message.id;
    }
    if (typeof message.sourceRecordId === "string" && message.sourceRecordId.length > 0) {
        return message.sourceRecordId;
    }
    if (typeof message.eventId === "string" && message.eventId.length > 0) {
        return `event:${message.eventId}`;
    }

    return `projection:${fallbackIndex}`;
}

function appendFrozenPromptMessage(
    history: AgentPromptHistoryState,
    frozenMessage: FrozenPromptMessage
): void {
    history.messages.push(frozenMessage);
}

function freezeCanonicalMessage(
    history: AgentPromptHistoryState,
    message: AddressablePromptMessage,
    fallbackIndex: number
): FrozenPromptMessage {
    const sourceMessageId = getSourceMessageId(message, fallbackIndex);

    return {
        id: nextPromptHistoryId(history),
        role: message.role,
        content: cloneMessageContent(message),
        source: {
            kind: "canonical",
            sourceMessageId,
            ...(typeof message.sourceRecordId === "string"
                ? { sourceRecordId: message.sourceRecordId }
                : {}),
            ...(typeof message.eventId === "string"
                ? { sourceEventId: message.eventId }
                : {}),
        },
    };
}

function freezeRuntimeOverlay(
    history: AgentPromptHistoryState,
    overlay: RuntimePromptOverlay
): FrozenPromptMessage {
    return {
        id: nextPromptHistoryId(history),
        role: overlay.message.role,
        content: cloneMessageContent(overlay.message),
        source: {
            kind: "runtime-overlay",
            overlayType: overlay.overlayType,
        },
    };
}

function thawFrozenPromptMessage(message: FrozenPromptMessage): ModelMessage {
    return {
        role: message.role,
        content: clonePromptHistoryValue(message.content),
        id: message.id,
        ...(message.source.sourceRecordId
            ? { sourceRecordId: message.source.sourceRecordId }
            : {}),
        ...(message.source.sourceEventId
            ? { eventId: message.source.sourceEventId }
            : {}),
    } as ModelMessage;
}

function materializePromptHistoryMessages(
    frozenMessages: FrozenPromptMessage[]
): ModelMessage[] {
    return frozenMessages.map((frozenMessage) => thawFrozenPromptMessage(frozenMessage));
}

function splitCompiledMessages(compiled: CompiledMessages): {
    systemMessages: ModelMessage[];
    canonicalMessages: AddressablePromptMessage[];
} {
    return {
        systemMessages: compiled.messages.slice(0, compiled.counts.systemPrompt),
        canonicalMessages: compiled.messages.slice(
            compiled.counts.systemPrompt
        ) as AddressablePromptMessage[],
    };
}

export function buildPromptHistoryMessages(params: {
    compiled: CompiledMessages;
    conversationStore: ConversationStore;
    agentPubkey: string;
    runtimeOverlay?: RuntimePromptOverlay;
    runtimeOverlays?: RuntimePromptOverlay[];
    reminderStateChanged?: boolean;
    span?: Span;
}): PromptHistoryAssemblyResult {
    const {
        compiled,
        conversationStore,
        agentPubkey,
        runtimeOverlay,
        runtimeOverlays = [],
        reminderStateChanged = false,
        span,
    } = params;
    const overlaysToAppend = runtimeOverlay
        ? [...runtimeOverlays, runtimeOverlay]
        : runtimeOverlays;
    const { systemMessages, canonicalMessages } = splitCompiledMessages(compiled);
    const history = conversationStore.getAgentPromptHistory(agentPubkey);
    const seenMessageIds = new Set(history.seenMessageIds);
    let didMutateHistory = false;
    let appendedCanonicalCount = 0;

    if (!history.cacheAnchored) {
        const retainedMessages = history.messages.filter(
            (message) => !isSystemReminderOverlay(message)
        );
        if (retainedMessages.length !== history.messages.length) {
            history.messages = retainedMessages;
            didMutateHistory = true;
        }
    }

    for (let index = 0; index < canonicalMessages.length; index++) {
        const message = canonicalMessages[index];
        const sourceMessageId = getSourceMessageId(message, index);

        if (seenMessageIds.has(sourceMessageId)) {
            if (!history.cacheAnchored) {
                didMutateHistory =
                    syncFrozenCanonicalMessage({
                        history,
                        message,
                        fallbackIndex: index,
                    })
                    || didMutateHistory;
            }
            continue;
        }

        appendFrozenPromptMessage(history, freezeCanonicalMessage(history, message, index));
        history.seenMessageIds.push(sourceMessageId);
        seenMessageIds.add(sourceMessageId);
        didMutateHistory = true;
        appendedCanonicalCount += 1;
    }

    for (const overlay of overlaysToAppend) {
        if (overlay.persistInHistory === false) {
            continue;
        }
        if (overlay.overlayType === "system-reminders" && !history.cacheAnchored) {
            continue;
        }
        appendFrozenPromptMessage(history, freezeRuntimeOverlay(history, overlay));
        didMutateHistory = true;
    }

    span?.addEvent("prompt-history.sync", {
        "prompt_history.system_message_count": systemMessages.length,
        "prompt_history.canonical_projection_count": canonicalMessages.length,
        "prompt_history.frozen_message_count": history.messages.length,
        "prompt_history.appended_canonical_count": appendedCanonicalCount,
        "prompt_history.appended_runtime_overlay_count": overlaysToAppend.length,
        "prompt_history.reminder_state_changed": reminderStateChanged,
    });

    return {
        messages: [
            ...systemMessages,
            ...materializePromptHistoryMessages(history.messages),
        ],
        didMutateHistory,
        reminderStateChanged,
    };
}

export function syncPreparedPromptHistoryMessages(params: {
    conversationStore: ConversationStore;
    agentPubkey: string;
    preparedMessages: ModelMessage[];
    span?: Span;
}): boolean {
    const { conversationStore, agentPubkey, preparedMessages, span } = params;
    const history = conversationStore.getAgentPromptHistory(agentPubkey);

    if (!history.cacheAnchored) {
        return false;
    }

    const preparedMessagesById = new Map<string, AddressablePromptMessage>();

    for (const message of preparedMessages as AddressablePromptMessage[]) {
        if (typeof message.id === "string" && message.id.length > 0) {
            preparedMessagesById.set(message.id, message);
        }
    }

    for (let index = history.messages.length - 1; index >= 0; index--) {
        const frozenMessage = history.messages[index];
        if (frozenMessage.role !== "user") {
            continue;
        }

        const preparedMessage = preparedMessagesById.get(frozenMessage.id);
        if (!preparedMessage) {
            continue;
        }

        const nextContent = cloneMessageContent(preparedMessage);
        if (serializeMessageContent(nextContent) === serializeMessageContent(frozenMessage.content)) {
            break;
        }

        history.messages[index] = {
            ...frozenMessage,
            content: nextContent,
        };

        span?.addEvent("prompt-history.mutable-sync", {
            "prompt_history.updated_message_id": frozenMessage.id,
            "prompt_history.updated_message_role": frozenMessage.role,
            "prompt_history.updated_message_source": frozenMessage.source.kind,
        });

        return true;
    }

    return false;
}
