import type { ChannelRef, InboundEnvelope, PrincipalRef } from "@/events/runtime/InboundEnvelope";
import { NDKKind } from "@/nostr/kinds";

interface LocalInboundActorInput {
    id: string;
    linkedPubkey?: string;
    displayName?: string;
    username?: string;
    kind?: PrincipalRef["kind"];
}

interface LocalInboundChannelInput {
    id: string;
    kind: ChannelRef["kind"];
    projectBinding?: string;
}

interface LocalInboundMessageInput {
    id: string;
    replyToId?: string;
}

export interface LocalInboundPayload {
    principal: LocalInboundActorInput;
    channel: LocalInboundChannelInput;
    message: LocalInboundMessageInput;
    recipients: LocalInboundActorInput[];
    content: string;
    occurredAt?: number;
    capabilities?: string[];
}

function toPrincipalRef(actor: LocalInboundActorInput): PrincipalRef {
    return {
        id: actor.id,
        transport: "local",
        linkedPubkey: actor.linkedPubkey,
        displayName: actor.displayName,
        username: actor.username,
        kind: actor.kind,
    };
}

export class LocalInboundAdapter {
    toEnvelope(payload: LocalInboundPayload): InboundEnvelope {
        const equivalentTagCount = payload.recipients.length +
            (payload.channel.projectBinding ? 1 : 0) +
            (payload.message.replyToId ? 1 : 0);

        return {
            transport: "local",
            principal: toPrincipalRef(payload.principal),
            channel: {
                id: payload.channel.id,
                transport: "local",
                kind: payload.channel.kind,
                projectBinding: payload.channel.projectBinding,
            },
            message: {
                id: `local:${payload.message.id}`,
                transport: "local",
                nativeId: payload.message.id,
                replyToId: payload.message.replyToId ? `local:${payload.message.replyToId}` : undefined,
            },
            recipients: payload.recipients.map(toPrincipalRef),
            content: payload.content,
            occurredAt: payload.occurredAt ?? Math.floor(Date.now() / 1000),
            capabilities: payload.capabilities ?? [
                "local-test-gateway",
                "project-routing",
                "linked-nostr-identity",
            ],
            metadata: {
                eventKind: NDKKind.Text,
                eventTagCount: equivalentTagCount,
            },
        };
    }
}
