import { config } from "@/services/ConfigService";
import { shortenConversationId, shortenOptionalEventId } from "@/utils/conversation-id";
import { logger } from "@/utils/logger";
import type { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { trace } from "@opentelemetry/api";
import { AgentEventEncoder } from "./AgentEventEncoder";
import { enqueueSignedEventForRustPublish } from "./RustPublishOutbox";
import { injectTraceContext } from "./trace-context";
import type { InterventionReviewIntent } from "./types";

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
     * Names are pre-resolved by the caller (InterventionService) before being
     * passed to this method. This avoids circular dependencies since
     * InterventionPublisher (nostr layer) cannot import PubkeyService (services layer).
     *
     * @param humanReplicaPubkey - Pubkey of the intervention agent to notify
     * @param conversationId - ID of the original conversation
     * @param userName - Human-readable name of the user who hasn't responded (pre-resolved)
     * @param agentName - Human-readable name of the agent that completed work (pre-resolved)
     * @returns The published event ID
     */
    async publishReviewRequest(
        humanReplicaPubkey: string,
        conversationId: string,
        userName: string,
        agentName: string
    ): Promise<string> {
        if (!this.signer) {
            throw new Error("InterventionPublisher not initialized");
        }

        const intent: InterventionReviewIntent = {
            targetPubkey: humanReplicaPubkey,
            conversationId,
            userName,
            agentName,
        };

        // Use encoder to create properly tagged event
        const event = this.encoder.encodeInterventionReview(intent);

        // Inject trace context for observability
        injectTraceContext(event);

        // Sign with backend signer
        await event.sign(this.signer);

        const shortConversationId = shortenConversationId(conversationId);

        try {
            const signedEvent = await enqueueSignedEventForRustPublish(event, {
                correlationId: "intervention_review_request",
                projectId: "intervention",
                conversationId,
                requestId: `intervention-review:${conversationId}:${event.id}`,
            });

            trace.getActiveSpan()?.addEvent("intervention.review_request_published", {
                "event.id": signedEvent.id,
                "conversation.id": conversationId,
                "target.pubkey": humanReplicaPubkey.substring(0, 8),
            });

            logger.info("Enqueued intervention review request for Rust publish", {
                eventId: shortenOptionalEventId(signedEvent.id),
                conversationId: shortConversationId,
                targetAgent: humanReplicaPubkey.substring(0, 8),
            });

            return signedEvent.id;
        } catch (error) {
            logger.error("Failed to enqueue intervention review request", {
                error,
                conversationId: shortConversationId,
            });
            throw error;
        }
    }
}
