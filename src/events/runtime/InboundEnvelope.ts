export type RuntimeTransport = "local" | "nostr" | "telegram" | (string & {});

export interface PrincipalRef {
    id: string;
    transport: RuntimeTransport;
    linkedPubkey?: string;
    displayName?: string;
    username?: string;
    kind?: "agent" | "human" | "system";
}

export interface ChannelRef {
    id: string;
    transport: RuntimeTransport;
    kind: "conversation" | "dm" | "group" | "project" | "topic";
    projectBinding?: string;
}

export interface ExternalMessageRef {
    id: string;
    transport: RuntimeTransport;
    nativeId: string;
    replyToId?: string;
}

export interface InboundEnvelope {
    transport: RuntimeTransport;
    principal: PrincipalRef;
    channel: ChannelRef;
    message: ExternalMessageRef;
    recipients: PrincipalRef[];
    content: string;
    occurredAt: number;
    capabilities: string[];
    metadata: {
        eventKind?: number;
        eventTagCount?: number;
        toolName?: string;
        statusValue?: string;
        branchName?: string;
        articleReferences?: string[];
        replyTargets?: string[];
        delegationParentConversationId?: string;
        nudgeEventIds?: string[];
        skillEventIds?: string[];
    };
}
