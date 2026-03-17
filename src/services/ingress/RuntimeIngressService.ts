import type { AgentExecutor } from "@/agents/execution/AgentExecutor";
import type { InboundEnvelope } from "@/events/runtime/InboundEnvelope";
import { InboundEnvelopeEventBridge } from "@/nostr/InboundEnvelopeEventBridge";
import { AgentDispatchService } from "@/services/dispatch/AgentDispatchService";
import { getIdentityService } from "@/services/identity";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { SpanStatusCode, trace } from "@opentelemetry/api";

interface RuntimeIngressParams {
    envelope: InboundEnvelope;
    legacyEvent?: NDKEvent;
    agentExecutor: AgentExecutor;
    adapter: string;
}

export class RuntimeIngressService {
    private readonly dispatcher = AgentDispatchService.getInstance();
    private readonly legacyEventBridge = new InboundEnvelopeEventBridge();

    async handleChatMessage(params: RuntimeIngressParams): Promise<NDKEvent> {
        const { envelope, agentExecutor, adapter } = params;
        const legacyEvent = params.legacyEvent ?? this.legacyEventBridge.toEvent(envelope);
        const activeSpan = trace.getActiveSpan();

        try {
            const identityService = getIdentityService();
            const legacyEventSource = params.legacyEvent ? "provided" : "bridged";

            identityService.rememberIdentity({
                principalId: envelope.principal.id,
                linkedPubkey: envelope.principal.linkedPubkey,
                displayName: envelope.principal.displayName,
                username: envelope.principal.username,
                kind: envelope.principal.kind,
            });
            for (const recipient of envelope.recipients) {
                identityService.rememberIdentity({
                    principalId: recipient.id,
                    linkedPubkey: recipient.linkedPubkey,
                    displayName: recipient.displayName,
                    username: recipient.username,
                    kind: recipient.kind,
                });
            }

            logger.info("[RuntimeIngressService] Normalized inbound message", {
                transport: envelope.transport,
                adapter,
                principalId: envelope.principal.id,
                channelId: envelope.channel.id,
                messageId: envelope.message.id,
                replyToId: envelope.message.replyToId,
                recipientCount: envelope.recipients.length,
                legacyEventSource,
                eventId: legacyEvent.id,
                eventKind: legacyEvent.kind,
            });

            activeSpan?.addEvent("runtime.ingress.received", {
                "runtime.transport": envelope.transport,
                "runtime.adapter": adapter,
                "runtime.principal_id": envelope.principal.id,
                "runtime.principal_has_linked_pubkey": Boolean(envelope.principal.linkedPubkey),
                "runtime.channel_id": envelope.channel.id,
                "runtime.message_id": envelope.message.id,
                "runtime.reply_to_id": envelope.message.replyToId ?? "",
                "runtime.recipient_count": envelope.recipients.length,
                "runtime.legacy_event_source": legacyEventSource,
                "runtime.event_kind": envelope.metadata.eventKind ?? 0,
            });

            await this.dispatcher.dispatch(legacyEvent, {
                agentExecutor,
                envelope,
            });

            activeSpan?.addEvent("runtime.ingress.dispatched", {
                "runtime.transport": envelope.transport,
                "runtime.message_id": envelope.message.id,
                "runtime.channel_id": envelope.channel.id,
            });
        } catch (error) {
            activeSpan?.recordException(error as Error);
            activeSpan?.setStatus({
                code: SpanStatusCode.ERROR,
                message: error instanceof Error ? error.message : String(error),
            });
            logger.error("[RuntimeIngressService] Failed to dispatch inbound message", {
                transport: envelope.transport,
                adapter,
                principalId: envelope.principal.id,
                channelId: envelope.channel.id,
                messageId: envelope.message.id,
                eventId: legacyEvent.id,
                error: error instanceof Error ? error.message : String(error),
            });
        }

        return legacyEvent;
    }
}
