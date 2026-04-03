import type { ModelMessage } from "ai";
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
}

export interface PromptHistoryAssemblyResult {
    messages: ModelMessage[];
    didMutateHistory: boolean;
    reminderStateChanged: boolean;
}

function cloneMessageContent(message: ModelMessage): ModelMessage["content"] {
    return structuredClone(message.content);
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
        content: structuredClone(message.content),
        id: message.id,
        ...(message.source.sourceRecordId
            ? { sourceRecordId: message.source.sourceRecordId }
            : {}),
        ...(message.source.sourceEventId
            ? { eventId: message.source.sourceEventId }
            : {}),
    } as ModelMessage;
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
    reminderStateChanged?: boolean;
    span?: Span;
}): PromptHistoryAssemblyResult {
    const {
        compiled,
        conversationStore,
        agentPubkey,
        runtimeOverlay,
        reminderStateChanged = false,
        span,
    } = params;
    const { systemMessages, canonicalMessages } = splitCompiledMessages(compiled);
    const history = conversationStore.getAgentPromptHistory(agentPubkey);
    const seenMessageIds = new Set(history.seenMessageIds);
    let didMutateHistory = false;
    let appendedCanonicalCount = 0;

    for (let index = 0; index < canonicalMessages.length; index++) {
        const message = canonicalMessages[index];
        const sourceMessageId = getSourceMessageId(message, index);

        if (seenMessageIds.has(sourceMessageId)) {
            continue;
        }

        appendFrozenPromptMessage(history, freezeCanonicalMessage(history, message, index));
        history.seenMessageIds.push(sourceMessageId);
        seenMessageIds.add(sourceMessageId);
        didMutateHistory = true;
        appendedCanonicalCount += 1;
    }

    if (runtimeOverlay) {
        appendFrozenPromptMessage(history, freezeRuntimeOverlay(history, runtimeOverlay));
        didMutateHistory = true;
    }

    span?.addEvent("prompt-history.sync", {
        "prompt_history.system_message_count": systemMessages.length,
        "prompt_history.canonical_projection_count": canonicalMessages.length,
        "prompt_history.frozen_message_count": history.messages.length,
        "prompt_history.appended_canonical_count": appendedCanonicalCount,
        "prompt_history.appended_runtime_overlay_count": runtimeOverlay ? 1 : 0,
        "prompt_history.reminder_state_changed": reminderStateChanged,
    });

    return {
        messages: [
            ...systemMessages,
            ...history.messages.map((message) => thawFrozenPromptMessage(message)),
        ],
        didMutateHistory,
        reminderStateChanged,
    };
}
