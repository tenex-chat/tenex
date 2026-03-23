import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { TelegramAgentConfig } from "@/agents/types/storage";

export interface RuntimeAgentRef {
    name: string;
    slug: string;
    pubkey: string;
    eventId?: string;
    telegram?: TelegramAgentConfig;
}

export interface RuntimePublishAgent extends RuntimeAgentRef {
    /**
     * Runtime publishers still hand Nostr event publication to AgentPublisher,
     * so signing remains NDK-specific at this seam.
     */
    sign(event: NDKEvent): Promise<void>;
}
