import { config } from "@/services/ConfigService";
import { getLLMSpanId } from "@/telemetry/LLMSpanRegistry";
import { logger } from "@/utils/logger";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { context as otelContext, propagation, trace } from "@opentelemetry/api";
import { AgentEventEncoder } from "./AgentEventEncoder";
import type { InterventionReviewIntent } from "./types";

/**
 * Inject W3C trace context into an event's tags.
 * This allows the daemon to link incoming events back to their parent span.
 * Also adds trace_context_llm which links to the LLM execution span for better debugging.
 *
 * Note: This is duplicated from AgentPublisher since intervention events
 * are published outside the normal agent execution context but still need
 * trace context for observability.
 */
function injectTraceContext(event: { tags: string[][] }): void {
    const carrier: Record<string, string> = {};
    propagation.inject(otelContext.active(), carrier);
    if (carrier.traceparent) {
        event.tags.push(["trace_context", carrier.traceparent]);
    }

    // Add trace context that links to LLM execution span (more useful for debugging)
    const activeSpan = trace.getActiveSpan();
    if (activeSpan) {
        const spanContext = activeSpan.spanContext();
        const traceId = spanContext.traceId;

        // Use LLM span ID if available (links to actual LLM execution)
        // Otherwise fall back to current span ID
        const llmSpanId = getLLMSpanId(traceId);
        const spanIdToUse = llmSpanId || spanContext.spanId;

        event.tags.push(["trace_context_llm", `00-${traceId}-${spanIdToUse}-01`]);
    }
}

/**
 * Publisher for intervention review request events.
 * Uses the backend private key (same as scheduled jobs) for signing.
 *
 * This publisher follows the established Nostr event encoding patterns:
 * - Uses AgentEventEncoder for event creation and tagging
 * - Injects trace context for observability
 * - Includes project `a` tag for proper event association
 */
export class InterventionPublisher {
    private signer: NDKPrivateKeySigner | null = null;
    private encoder: AgentEventEncoder;

    constructor() {
        this.encoder = new AgentEventEncoder();
    }

    /**
     * Initialize the publisher by loading the backend signer.
     * Must be called before publishing events.
     */
    async initialize(): Promise<void> {
        this.signer = await config.getBackendSigner();
        logger.debug("InterventionPublisher initialized", {
            pubkey: this.signer.pubkey.substring(0, 8),
        });
    }

    /**
     * Get the publisher's pubkey (backend key).
     * Throws if not initialized.
     */
    getPubkey(): string {
        if (!this.signer) {
            throw new Error("InterventionPublisher not initialized");
        }
        return this.signer.pubkey;
    }

    /**
     * Publish an intervention review request event.
     *
     * Uses AgentEventEncoder to ensure consistent event structure including:
     * - Project `a` tag for proper event association
     * - Trace context injection for observability
     * - Standard intervention-specific tags
     *
     * @param humanReplicaPubkey - Pubkey of the intervention agent to notify
     * @param conversationId - ID of the original conversation
     * @param userPubkey - Pubkey of the user who hasn't responded
     * @param agentPubkey - Pubkey of the agent that completed work
     * @returns The published event ID
     */
    async publishReviewRequest(
        humanReplicaPubkey: string,
        conversationId: string,
        userPubkey: string,
        agentPubkey: string
    ): Promise<string> {
        if (!this.signer) {
            throw new Error("InterventionPublisher not initialized");
        }

        const intent: InterventionReviewIntent = {
            targetPubkey: humanReplicaPubkey,
            conversationId,
            userPubkey,
            agentPubkey,
        };

        // Use encoder to create properly tagged event
        const event = this.encoder.encodeInterventionReview(intent);

        // Inject trace context for observability
        injectTraceContext(event);

        // Sign with backend signer
        await event.sign(this.signer);

        const shortConversationId = conversationId.substring(0, 12);

        try {
            const relaySet = await event.publish();
            const successRelays: string[] = [];
            for (const relay of relaySet) {
                successRelays.push(relay.url);
            }

            if (successRelays.length === 0) {
                logger.warn("Intervention review request published to 0 relays", {
                    eventId: event.id?.substring(0, 8),
                    conversationId: shortConversationId,
                });
            } else {
                logger.info("Published intervention review request", {
                    eventId: event.id?.substring(0, 8),
                    conversationId: shortConversationId,
                    targetAgent: humanReplicaPubkey.substring(0, 8),
                    relayCount: successRelays.length,
                });
            }

            trace.getActiveSpan()?.addEvent("intervention.review_request_published", {
                "event.id": event.id || "unknown",
                "conversation.id": conversationId,
                "target.pubkey": humanReplicaPubkey.substring(0, 8),
                "relay.count": successRelays.length,
            });

            return event.id || "";
        } catch (error) {
            logger.error("Failed to publish intervention review request", {
                error,
                conversationId: shortConversationId,
            });
            throw error;
        }
    }
}
