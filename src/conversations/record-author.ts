import type { ConversationRecordInput } from "@/conversations/types";

type ConversationRecordAuthorLike = Pick<
    ConversationRecordInput,
    "pubkey" | "senderPubkey" | "senderPrincipal"
>;

function normalizeIdentifier(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function getConversationRecordAuthorPubkey(
    entry: ConversationRecordAuthorLike
): string | undefined {
    return normalizeIdentifier(entry.senderPrincipal?.linkedPubkey)
        ?? normalizeIdentifier(entry.senderPubkey)
        ?? normalizeIdentifier(entry.pubkey);
}

export function getConversationRecordAuthorPrincipalId(
    entry: ConversationRecordAuthorLike
): string | undefined {
    return normalizeIdentifier(entry.senderPrincipal?.id);
}
