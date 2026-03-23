import type { InboundEnvelope } from "@/events/runtime/InboundEnvelope";

interface AgentPubkeyCarrier {
    pubkey: string;
}

function toSystemPubkeys(
    systemAgents: ReadonlyMap<string, AgentPubkeyCarrier>,
    projectManagerPubkey?: string
): Set<string> {
    const systemPubkeys = new Set(Array.from(systemAgents.values()).map((agent) => agent.pubkey));
    if (projectManagerPubkey) {
        systemPubkeys.add(projectManagerPubkey);
    }
    return systemPubkeys;
}

/**
 * Strip transport prefix from a qualified ID.
 * "nostr:abc123" → "abc123", "local:xyz" → "xyz", "abc123" → "abc123"
 */
export function toNativeId(qualifiedId: string): string {
    const colonIndex = qualifiedId.indexOf(":");
    return colonIndex >= 0 ? qualifiedId.substring(colonIndex + 1) : qualifiedId;
}

export function isDirectedToSystem(
    envelope: InboundEnvelope,
    systemAgents: ReadonlyMap<string, AgentPubkeyCarrier>,
    projectManagerPubkey?: string
): boolean {
    if (envelope.recipients.length === 0) return false;

    const recipientPubkeys = envelope.recipients
        .map((r) => r.linkedPubkey)
        .filter((pk): pk is string => !!pk);

    const systemPubkeys = toSystemPubkeys(systemAgents, projectManagerPubkey);

    return recipientPubkeys.some((pk) => systemPubkeys.has(pk));
}

export function isFromAgent(
    envelope: InboundEnvelope,
    systemAgents: ReadonlyMap<string, AgentPubkeyCarrier>
): boolean {
    const pubkey = envelope.principal.linkedPubkey;
    if (!pubkey) return false;
    return toSystemPubkeys(systemAgents).has(pubkey);
}

export function getReplyTarget(envelope: InboundEnvelope): string | undefined {
    return envelope.message.replyToId;
}

export function getMentionedPubkeys(envelope: InboundEnvelope): string[] {
    return envelope.recipients
        .map((r) => r.linkedPubkey)
        .filter((pk): pk is string => !!pk);
}

export function isAgentInternalMessage(envelope: InboundEnvelope): boolean {
    return !!(envelope.metadata.toolName || envelope.metadata.statusValue);
}

export function isDelegationCompletion(envelope: InboundEnvelope): boolean {
    return envelope.metadata.eventKind === 1 && envelope.metadata.statusValue === "completed";
}

export function getDelegationRequestId(envelope: InboundEnvelope): string | undefined {
    if (!isDelegationCompletion(envelope)) return undefined;
    const targets = envelope.metadata.replyTargets;
    return targets && targets.length > 0 ? targets[0] : undefined;
}
