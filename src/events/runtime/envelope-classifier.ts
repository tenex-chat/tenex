import type { AgentInstance } from "@/agents/types";
import type { InboundEnvelope } from "@/events/runtime/InboundEnvelope";
import { getProjectContext } from "@/services/projects";

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
    systemAgents: Map<string, AgentInstance>
): boolean {
    if (envelope.recipients.length === 0) return false;

    const recipientPubkeys = envelope.recipients
        .map((r) => r.linkedPubkey)
        .filter((pk): pk is string => !!pk);

    const systemPubkeys = new Set(Array.from(systemAgents.values()).map((a) => a.pubkey));

    const projectCtx = getProjectContext();
    if (projectCtx.projectManager?.pubkey) {
        systemPubkeys.add(projectCtx.projectManager.pubkey);
    }

    return recipientPubkeys.some((pk) => systemPubkeys.has(pk));
}

export function isFromAgent(
    envelope: InboundEnvelope,
    systemAgents: Map<string, AgentInstance>
): boolean {
    const pubkey = envelope.principal.linkedPubkey;
    if (!pubkey) return false;
    const agentPubkeys = new Set(Array.from(systemAgents.values()).map((a) => a.pubkey));
    return agentPubkeys.has(pubkey);
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
