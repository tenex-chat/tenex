/**
 * Kill-signal event handler (kind: TenexKillSignal / 24136).
 *
 * Why this file exists separately from reply.ts:
 * Kill signals are control-plane-only events published by agents after a local
 * abort state is committed.  They carry the killed delegation's conversation ID
 * so the immediate parent can be woken up via the normal dispatch path.
 *
 * Unlike kind:1 completion events, kill signals:
 * - Must NOT be appended to any conversation store or prompt-history.
 * - Do NOT require sender validation (the delegation is already marked aborted
 *   in RALRegistry before the signal is published).
 * - Are idempotent: a replayed signal simply returns no wake target and is
 *   dropped silently.
 *
 * This handler accepts the Nostr event, converts it to a canonical envelope
 * that carries the kill-signal flag, and routes it through RuntimeIngressService
 * so the full dispatch stack (DelegationCompletionHandler implicit-kill branch →
 * AgentDispatchService.handleDelegationResponse) handles the wake-up.
 */

import type { AgentExecutor } from "@/agents/execution/AgentExecutor";
import { RuntimeIngressService } from "@/services/ingress/RuntimeIngressService";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { InboundEnvelope } from "@/events/runtime/InboundEnvelope";
import { NDKKind } from "@/nostr/kinds";

function getTagValue(event: NDKEvent, tagName: string): string | undefined {
    return event.tagValue(tagName) ?? event.getMatchingTags(tagName)[0]?.[1];
}

/**
 * Build a canonical kill-signal InboundEnvelope from an external Nostr event.
 * The envelope carries the control-plane metadata needed by
 * DelegationCompletionHandler's implicit-kill branch.
 */
function toKillSignalEnvelope(event: NDKEvent): InboundEnvelope | null {
    const delegationConversationId = getTagValue(event, "delegation");
    if (!delegationConversationId) {
        logger.debug("[kill-signal] Ignoring kill-signal event missing delegation tag", {
            eventId: event.id?.substring(0, 8),
        });
        return null;
    }

    const nativeId = event.id ?? `synthetic:kill-signal:${delegationConversationId}`;

    return {
        transport: "nostr",
        principal: {
            id: `nostr:${event.pubkey}`,
            transport: "nostr",
            linkedPubkey: event.pubkey,
            kind: "agent",
        },
        channel: {
            id: `nostr:conversation:${delegationConversationId}`,
            transport: "nostr",
            kind: "conversation",
        },
        message: {
            id: `nostr:${nativeId}`,
            transport: "nostr",
            nativeId,
        },
        recipients: [],
        content: event.content,
        occurredAt: event.created_at ?? Math.floor(Date.now() / 1000),
        capabilities: ["fanout-recipient-tags", "threaded-replies"],
        metadata: {
            eventKind: NDKKind.TenexKillSignal,
            isKillSignal: true,
            killSignalDelegationConversationId: delegationConversationId,
        },
    };
}

/**
 * Handle an incoming Nostr kill-signal event.
 *
 * Routes the event through RuntimeIngressService so the standard dispatch
 * stack is used for the parent wake-up.  Non-kill-signal events are ignored.
 */
export async function handleKillSignalEvent(
    event: NDKEvent,
    agentExecutor: AgentExecutor
): Promise<void> {
    if (event.kind !== NDKKind.TenexKillSignal) {
        logger.debug("[kill-signal] Ignoring non-kill-signal event kind", {
            kind: event.kind,
            eventId: event.id?.substring(0, 8),
        });
        return;
    }

    logger.info("[kill-signal] Received external kill-signal event", {
        eventId: event.id?.substring(0, 8),
        pubkey: event.pubkey.substring(0, 8),
    });

    const envelope = toKillSignalEnvelope(event);
    if (!envelope) {
        logger.debug("[kill-signal] Kill-signal event produced no envelope, skipping");
        return;
    }

    logger.info("[kill-signal] Forwarding kill-signal envelope to runtime ingress", {
        delegationConversationId: envelope.metadata.killSignalDelegationConversationId?.substring(0, 8),
    });

    const ingressService = new RuntimeIngressService();
    await ingressService.handleChatMessage({
        envelope,
        agentExecutor,
        adapter: "kill-signal",
    });
}
