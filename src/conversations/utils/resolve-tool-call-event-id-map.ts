import type { ConversationEntry } from "@/conversations/types";

export function resolveToolCallEventIdMap(entries: ConversationEntry[]): Map<string, string> {
    const result = new Map<string, string>();

    for (const entry of entries) {
        if (entry.messageType !== "tool-result" || !entry.eventId || !entry.toolData) {
            continue;
        }

        for (const part of entry.toolData) {
            const raw = part as unknown as Record<string, unknown>;
            if (typeof raw.toolCallId !== "string" || raw.toolCallId.length === 0) {
                continue;
            }

            if (!result.has(raw.toolCallId)) {
                result.set(raw.toolCallId, entry.eventId);
            }
        }
    }

    return result;
}
