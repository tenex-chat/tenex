import type { NDKEvent } from "@nostr-dev-kit/ndk";

export interface TelegramChatBinding {
    /** Telegram chat ID (string to avoid 64-bit integer issues) */
    chatId: string;
    /** Optional forum topic thread ID for supergroups */
    topicId?: string;
    /** Optional label for operator-facing diagnostics */
    title?: string;
}

export interface TelegramAgentConfig {
    /** Bot API token for this agent's Telegram bot */
    botToken: string;
    /** Allow direct messages to this bot from authorized identities */
    allowDMs?: boolean;
    /** Additional principal IDs allowed to DM this agent */
    authorizedIdentityIds?: string[];
    /** Group or topic bindings that should trigger this agent */
    chatBindings?: TelegramChatBinding[];
    /** Optional API base URL override for tests or self-hosted gateways */
    apiBaseUrl?: string;
}

export interface RuntimeAgentRef {
    name: string;
    slug: string;
    pubkey: string;
    eventId?: string;
    telegram?: TelegramAgentConfig;
}

export interface RuntimePublishAgent extends RuntimeAgentRef {
    sign(event: NDKEvent): Promise<void>;
}
