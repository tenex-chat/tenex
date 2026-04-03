import { createHash } from "node:crypto";
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

function stableSerialize(value: unknown): string {
    if (value === null || value === undefined) {
        return String(value);
    }

    if (typeof value === "string") {
        return JSON.stringify(value);
    }

    if (
        typeof value === "number"
        || typeof value === "boolean"
        || typeof value === "bigint"
    ) {
        return String(value);
    }

    if (Array.isArray(value)) {
        return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
    }

    if (typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableSerialize(entryValue)}`);
        return `{${entries.join(",")}}`;
    }

    return JSON.stringify(String(value));
}

function hashPromptMessage(message: ModelMessage): string {
    return createHash("sha256")
        .update(stableSerialize({
            role: message.role,
            content: message.content,
        }))
        .digest("hex");
}

function cloneMessageContent(message: ModelMessage): ModelMessage["content"] {
    return structuredClone(message.content);
}

function nextPromptHistoryId(history: AgentPromptHistoryState): string {
    history.nextSequence += 1;
    return `prompt:${history.nextSequence}`;
}

function getSourceMessageId(message: AddressablePromptMessage, fallbackIndex: number): string {
    if (typeof message.sourceRecordId === "string" && message.sourceRecordId.length > 0) {
        return message.sourceRecordId;
    }
    if (typeof message.id === "string" && message.id.length > 0) {
        return message.id;
    }
    if (typeof message.eventId === "string" && message.eventId.length > 0) {
        return `event:${message.eventId}`;
    }

    return `projection:${fallbackIndex}:${hashPromptMessage(message)}`;
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
    kind: "canonical" | "mutable-update",
    renderHash: string,
    fallbackIndex: number
): FrozenPromptMessage {
    const sourceMessageId = getSourceMessageId(message, fallbackIndex);

    return {
        id: nextPromptHistoryId(history),
        role: message.role,
        content: cloneMessageContent(message),
        source: {
            kind,
            sourceMessageId,
            ...(typeof message.sourceRecordId === "string"
                ? { sourceRecordId: message.sourceRecordId }
                : {}),
            ...(typeof message.eventId === "string"
                ? { sourceEventId: message.eventId }
                : {}),
        },
        renderHash,
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
        renderHash: hashPromptMessage(overlay.message),
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
    let didMutateHistory = false;
    let appendedCanonicalCount = 0;
    let appendedMutableUpdateCount = 0;

    for (let index = 0; index < canonicalMessages.length; index++) {
        const message = canonicalMessages[index];
        const sourceMessageId = getSourceMessageId(message, index);
        const renderHash = hashPromptMessage(message);
        const previousHash = history.sourceVersions[sourceMessageId];

        if (!previousHash) {
            appendFrozenPromptMessage(
                history,
                freezeCanonicalMessage(history, message, "canonical", renderHash, index)
            );
            history.sourceVersions[sourceMessageId] = renderHash;
            didMutateHistory = true;
            appendedCanonicalCount += 1;
            continue;
        }

        if (previousHash !== renderHash) {
            appendFrozenPromptMessage(
                history,
                freezeCanonicalMessage(history, message, "mutable-update", renderHash, index)
            );
            history.sourceVersions[sourceMessageId] = renderHash;
            didMutateHistory = true;
            appendedMutableUpdateCount += 1;
        }
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
        "prompt_history.appended_mutable_update_count": appendedMutableUpdateCount,
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
