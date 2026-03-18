import type { InboundEnvelope } from "@/events/runtime/InboundEnvelope";
import { AgentEventDecoder } from "@/nostr/AgentEventDecoder";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

function toPrincipalId(pubkey: string): string {
    return `nostr:${pubkey}`;
}

function toMessageId(eventId: string): string {
    return `nostr:${eventId}`;
}

function buildFallbackMessageId(event: NDKEvent): string {
    const createdAt = event.created_at ?? 0;
    return `nostr:synthetic:${event.pubkey}:${createdAt}`;
}

function getTagValue(event: NDKEvent, tagName: string): string | undefined {
    return event.tagValue(tagName) ?? event.getMatchingTags(tagName)[0]?.[1];
}

function getTagValues(event: NDKEvent, tagName: string): string[] {
    const directValues = event.getMatchingTags(tagName)
        .map((tag: string[]) => tag[1])
        .filter((value: string | undefined): value is string => !!value);

    if (directValues.length > 0) {
        return directValues;
    }

    return event.tags
        .filter((tag: string[]) => tag[0] === tagName)
        .map((tag: string[]) => tag[1])
        .filter((value: string | undefined): value is string => !!value);
}

export class NostrInboundAdapter {
    toEnvelope(event: NDKEvent): InboundEnvelope {
        const replyTarget = AgentEventDecoder.getReplyTarget(event) ?? getTagValue(event, "e");
        const mentionedPubkeys = AgentEventDecoder.getMentionedPubkeys(event);
        const recipients = mentionedPubkeys.length > 0 ? mentionedPubkeys : getTagValues(event, "p");
        const projectBinding = getTagValue(event, "a");
        const nativeMessageId = event.id ?? buildFallbackMessageId(event);
        const messageId = toMessageId(nativeMessageId);
        const conversationAnchor = replyTarget ?? nativeMessageId;

        const channel = projectBinding
            ? {
                  id: `nostr:project:${projectBinding}`,
                  transport: "nostr" as const,
                  kind: "project" as const,
                  projectBinding,
              }
            : {
                  id: `nostr:conversation:${conversationAnchor}`,
                  transport: "nostr" as const,
                  kind: "conversation" as const,
                  projectBinding: undefined,
              };

        return {
            transport: "nostr",
            principal: {
                id: toPrincipalId(event.pubkey),
                transport: "nostr",
                linkedPubkey: event.pubkey,
            },
            channel,
            message: {
                id: messageId,
                transport: "nostr",
                nativeId: nativeMessageId,
                replyToId: replyTarget ? toMessageId(replyTarget) : undefined,
            },
            recipients: recipients.map((pubkey) => ({
                id: toPrincipalId(pubkey),
                transport: "nostr",
                linkedPubkey: pubkey,
            })),
            content: event.content,
            occurredAt: event.created_at ?? Math.floor(Date.now() / 1000),
            capabilities: [
                "fanout-recipient-tags",
                "project-routing-a-tag",
                "threaded-replies",
            ],
            metadata: {
                eventKind: event.kind,
                eventTagCount: event.tags.length,
            },
        };
    }
}
