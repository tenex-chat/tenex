import type {
    ScratchpadConversationEntry as RuntimeScratchpadConversationEntry,
    ScratchpadState as RuntimeScratchpadState,
} from "ai-sdk-context-management";
import type {
    ContextManagementScratchpadEntry as StoredScratchpadEntry,
    ContextManagementScratchpadState as StoredScratchpadState,
} from "@/conversations/types";
import { normalizeScratchpadEntries } from "@/conversations/utils/normalize-scratchpad-entries";

export function toRuntimeScratchpadState(
    state: StoredScratchpadState | undefined
): RuntimeScratchpadState | undefined {
    if (!state) {
        return undefined;
    }

    const entries = normalizeScratchpadEntries(state.entries as Record<string, unknown> | undefined);

    return {
        ...(entries ? { entries } : {}),
        ...(state.preserveTurns !== undefined
            ? { preserveTurns: state.preserveTurns }
            : typeof (state as StoredScratchpadState & { keepLastMessages?: number | null }).keepLastMessages
                === "number"
                ? {
                    preserveTurns: (
                        state as StoredScratchpadState & { keepLastMessages?: number | null }
                    ).keepLastMessages,
                }
                : {}),
        ...(state.activeNotice ? { activeNotice: state.activeNotice } : {}),
        omitToolCallIds: state.omitToolCallIds ?? [],
        ...(typeof state.updatedAt === "number" ? { updatedAt: state.updatedAt } : {}),
        ...(state.agentLabel ? { agentLabel: state.agentLabel } : {}),
    };
}

export function fromRuntimeScratchpadState(
    state: RuntimeScratchpadState,
    previousState: StoredScratchpadState | undefined
): StoredScratchpadState {
    const entries = normalizeScratchpadEntries(state.entries as Record<string, unknown> | undefined);

    return {
        ...(entries ? { entries } : {}),
        ...(state.preserveTurns !== undefined ? { preserveTurns: state.preserveTurns } : {}),
        ...(state.activeNotice ? { activeNotice: state.activeNotice } : {}),
        omitToolCallIds: state.omitToolCallIds,
        ...(typeof state.updatedAt === "number" ? { updatedAt: state.updatedAt } : {}),
        ...(state.agentLabel ?? previousState?.agentLabel
            ? { agentLabel: state.agentLabel ?? previousState?.agentLabel }
            : {}),
    };
}

export function toRuntimeScratchpadConversationEntries(
    entries: StoredScratchpadEntry[] | undefined
): RuntimeScratchpadConversationEntry[] {
    return (entries ?? []).map((entry) => ({
        agentId: entry.agentId,
        agentLabel: entry.agentLabel,
        state: toRuntimeScratchpadState(entry.state) ?? {
            omitToolCallIds: [],
        },
    }));
}
