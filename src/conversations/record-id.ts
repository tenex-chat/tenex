import type { ConversationRecord, ConversationRecordInput } from "@/conversations/types";

function hashString(value: string): string {
    let hash = 5381;

    for (let i = 0; i < value.length; i++) {
        hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
    }

    return (hash >>> 0).toString(36);
}

export function buildConversationRecordId(
    entry: ConversationRecordInput,
    absoluteIndex: number
): string {
    if (entry.id) {
        return entry.id;
    }

    if (entry.eventId) {
        return `record:${entry.eventId}`;
    }

    if (entry.messageType === "tool-call" || entry.messageType === "tool-result") {
        const toolCallIds = (entry.toolData ?? [])
            .flatMap((part) =>
                "toolCallId" in part && typeof part.toolCallId === "string"
                    ? [part.toolCallId]
                    : []
            );

        if (toolCallIds.length > 0) {
            return `record:${entry.messageType}:${toolCallIds.join(",")}:${absoluteIndex}`;
        }
    }

    if (entry.messageType === "delegation-marker" && entry.delegationMarker) {
        return [
            "record:delegation",
            entry.delegationMarker.delegationConversationId,
            entry.delegationMarker.status,
            String(absoluteIndex),
        ].join(":");
    }

    const stablePayload = JSON.stringify({
        pubkey: entry.pubkey,
        ral: entry.ral,
        messageType: entry.messageType,
        content: entry.content,
        toolData: entry.toolData,
        targetedPubkeys: entry.targetedPubkeys,
        senderPubkey: entry.senderPubkey,
        role: entry.role,
        humanReadable: entry.humanReadable,
        transcriptToolAttributes: entry.transcriptToolAttributes,
    });

    return `record:${entry.messageType}:${absoluteIndex}:${hashString(stablePayload)}`;
}

export function ensureConversationRecord(
    entry: ConversationRecordInput,
    absoluteIndex: number
): ConversationRecord {
    return {
        ...entry,
        id: buildConversationRecordId(entry, absoluteIndex),
    };
}
