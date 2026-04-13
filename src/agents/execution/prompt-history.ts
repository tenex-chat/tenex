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
