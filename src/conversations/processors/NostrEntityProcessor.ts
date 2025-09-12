import { getNDK } from "@/nostr";
import { logger } from "@/utils/logger";

/**
 * Handles processing of nostr entities in message content
 * Single Responsibility: Fetch and inline nostr event content
 * Note: Thinking block stripping is handled by content-utils.ts
 */
export class NostrEntityProcessor {
    private static readonly NOSTR_ENTITY_REGEX = /nostr:(nevent1|naddr1|note1|npub1|nprofile1)\w+/g;

    /**
     * Process nostr entities in content, replacing them with inline content
     */
    static async processEntities(content: string): Promise<string> {
        const entities = content.match(NostrEntityProcessor.NOSTR_ENTITY_REGEX);
        if (!entities || entities.length === 0) {
            return content;
        }

        let processedContent = content;
        const ndk = getNDK();

        for (const entity of entities) {
            try {
                const bech32Id = entity.replace("nostr:", "");
                const event = await ndk.fetchEvent(bech32Id);

                if (event) {
                    const inlinedContent = `<nostr-event entity="${entity}">${event.content}</nostr-event>`;
                    processedContent = processedContent.replace(entity, inlinedContent);

                    logger.debug("[NostrEntityProcessor] Inlined nostr entity", {
                        entity,
                        kind: event.kind,
                        contentLength: event.content?.length || 0,
                    });
                }
            } catch (error) {
                logger.warn("[NostrEntityProcessor] Failed to fetch nostr entity", {
                    entity,
                    error,
                });
                // Keep original entity if fetch fails
            }
        }

        return processedContent;
    }

    /**
     * Check if content contains nostr entities
     */
    static hasEntities(content: string): boolean {
        return NostrEntityProcessor.NOSTR_ENTITY_REGEX.test(content);
    }

    /**
     * Extract nostr entities from content
     */
    static extractEntities(content: string): string[] {
        const matches = content.match(NostrEntityProcessor.NOSTR_ENTITY_REGEX);
        return matches || [];
    }
}