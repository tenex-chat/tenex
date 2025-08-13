import { Message } from "multi-llm-ts";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { getNDK } from "@/nostr";
import { isEventFromUser, getAgentSlugFromEvent } from "@/nostr/utils";
import { getProjectContext } from "@/services";
import { Phase } from "./phases";
import { logger } from "@/utils/logger";

/**
 * Handles message formatting and processing.
 * Single Responsibility: Transform events and content into properly formatted messages.
 */
export class MessageBuilder {
    private static readonly NOSTR_ENTITY_REGEX = /nostr:(nevent1|naddr1|note1|npub1|nprofile1)\w+/g;

    /**
     * Process nostr entities in content, replacing them with inline content
     */
    async processNostrEntities(content: string): Promise<string> {
        const entities = content.match(MessageBuilder.NOSTR_ENTITY_REGEX);
        if (!entities || entities.length === 0) {
            return content;
        }

        let processedContent = content;
        const ndk = getNDK();
        
        for (const entity of entities) {
            try {
                const bech32Id = entity.replace('nostr:', '');
                const event = await ndk.fetchEvent(bech32Id);
                
                if (event) {
                    const inlinedContent = `<nostr-event entity="${entity}">${event.content}</nostr-event>`;
                    processedContent = processedContent.replace(entity, inlinedContent);
                    
                    logger.debug(`[MESSAGE_BUILDER] Inlined nostr entity`, {
                        entity,
                        kind: event.kind,
                        contentLength: event.content?.length || 0
                    });
                }
            } catch (error) {
                logger.warn(`[MESSAGE_BUILDER] Failed to fetch nostr entity`, { 
                    entity, 
                    error 
                });
                // Keep original entity if fetch fails
            }
        }
        
        return processedContent;
    }

    /**
     * Format an NDKEvent as a Message for a specific agent
     */
    formatEventAsMessage(
        event: NDKEvent,
        processedContent: string,
        targetAgentSlug: string
    ): Message {
        const eventAgentSlug = getAgentSlugFromEvent(event);
        
        // Agent's own message
        if (eventAgentSlug === targetAgentSlug) {
            return new Message("assistant", processedContent);
        }
        
        // User message
        if (isEventFromUser(event)) {
            return new Message("user", processedContent);
        }
        
        // Another agent's message
        const projectCtx = getProjectContext();
        const sendingAgent = eventAgentSlug ? 
            projectCtx.agents.get(eventAgentSlug) : null;
        const agentName = sendingAgent?.name || "Unknown";
        
        return new Message("system", `[${agentName}]: ${processedContent}`);
    }

    /**
     * Build phase transition message
     */
    buildPhaseTransitionMessage(fromPhase: Phase | undefined, toPhase: Phase): string {
        if (fromPhase) {
            return `=== PHASE TRANSITION: ${fromPhase.toUpperCase()} → ${toPhase.toUpperCase()} ===`;
        } else {
            return `=== CURRENT PHASE: ${toPhase.toUpperCase()} ===`;
        }
    }

    /**
     * Format a system message with proper attribution
     */
    formatSystemMessage(content: string, attribution?: string): Message {
        if (attribution) {
            return new Message("system", `[${attribution}]: ${content}`);
        }
        return new Message("system", content);
    }

    /**
     * Create a user message
     */
    formatUserMessage(content: string): Message {
        return new Message("user", content);
    }

    /**
     * Create an assistant message
     */
    formatAssistantMessage(content: string): Message {
        return new Message("assistant", content);
    }

    /**
     * Check if content contains nostr entities
     */
    hasNostrEntities(content: string): boolean {
        return MessageBuilder.NOSTR_ENTITY_REGEX.test(content);
    }

    /**
     * Extract nostr entities from content
     */
    extractNostrEntities(content: string): string[] {
        const matches = content.match(MessageBuilder.NOSTR_ENTITY_REGEX);
        return matches || [];
    }
}