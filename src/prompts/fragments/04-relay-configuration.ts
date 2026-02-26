import { getRelayUrls } from "@/nostr/relays";
import type { PromptFragment } from "../core/types";

/**
 * Default relay URL used when no relays are configured.
 * This mirrors the default in src/nostr/relays.ts
 */
const DEFAULT_RELAY_URL = "wss://tenex.chat";

/**
 * Relay configuration fragment.
 * Provides agents with information about the configured Nostr relays.
 * This helps agents understand where Nostr events are being published and received.
 */
export const relayConfigurationFragment: PromptFragment<Record<string, never>> = {
    id: "relay-configuration",
    priority: 4, // After global-system-prompt (3), before delegation-chain (5)
    template: () => {
        const relays = getRelayUrls();
        const isDefault = relays.length === 1 && relays[0] === DEFAULT_RELAY_URL;

        const parts: string[] = [];

        parts.push("## Nostr Relay Configuration\n");

        if (isDefault) {
            parts.push("Using default relay:");
        } else {
            parts.push(`Connected to ${relays.length} relay${relays.length > 1 ? "s" : ""}:`);
        }

        for (const relay of relays) {
            parts.push(`- ${relay}`);
        }

        return parts.join("\n");
    },
};
