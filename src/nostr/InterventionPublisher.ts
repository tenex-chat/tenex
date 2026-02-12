import { config } from "@/services/ConfigService";
import { logger } from "@/utils/logger";
import { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { trace } from "@opentelemetry/api";
import { getNDK } from "./ndkClient";

/**
 * Publisher for intervention review request events.
 * Uses the backend private key (same as scheduled jobs) for signing.
 */
export class InterventionPublisher {
    private signer: NDKPrivateKeySigner | null = null;

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
     * Event structure:
     * - kind: 1 (text note)
     * - content: Review request message
     * - tags:
     *   - ["p", humanReplicaPubkey] - Target agent to notify
     *   - ["original-conversation", conversationId] - Reference to the conversation
     *   - ["context", "intervention-review"] - Context marker
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

        const ndk = getNDK();
        const event = new NDKEvent(ndk);

        const shortConversationId = conversationId.substring(0, 12);
        const shortUserPubkey = userPubkey.substring(0, 8);
        const shortAgentPubkey = agentPubkey.substring(0, 8);

        event.kind = 1;
        event.content = `Conversation ${shortConversationId} has completed and the user (${shortUserPubkey}) hasn't responded. Agent ${shortAgentPubkey} finished their work. Please review and decide if action is needed.`;

        event.tags = [
            ["p", humanReplicaPubkey],
            ["original-conversation", conversationId],
            ["context", "intervention-review"],
            ["user-pubkey", userPubkey],
            ["agent-pubkey", agentPubkey],
        ];

        await event.sign(this.signer);

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
