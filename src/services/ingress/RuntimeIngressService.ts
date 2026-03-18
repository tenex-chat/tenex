import type { AgentExecutor } from "@/agents/execution/AgentExecutor";
import type { InboundEnvelope } from "@/events/runtime/InboundEnvelope";
import { AgentDispatchService } from "@/services/dispatch/AgentDispatchService";
import { getIdentityService } from "@/services/identity";
import { logger } from "@/utils/logger";
import { SpanStatusCode, trace } from "@opentelemetry/api";

interface RuntimeIngressParams {
    envelope: InboundEnvelope;
    agentExecutor: AgentExecutor;
    adapter: string;
}

export class RuntimeIngressService {
    private readonly dispatcher = AgentDispatchService.getInstance();

    async handleChatMessage(params: RuntimeIngressParams): Promise<void> {
        const { envelope, agentExecutor, adapter } = params;
        const activeSpan = trace.getActiveSpan();

        try {
            const identityService = getIdentityService();

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
                eventId: envelope.message.nativeId,
                eventKind: envelope.metadata.eventKind,
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
                "runtime.event_kind": envelope.metadata.eventKind ?? 0,
            });

            await this.dispatcher.dispatch(envelope, {
                agentExecutor,
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
                eventId: envelope.message.nativeId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
}
