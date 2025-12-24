/**
 * EventProcessor - Converts NDKEvents to LLM ModelMessages
 *
 * This module handles:
 * - Tool message reconstruction
 * - Event-to-message transformation
 * - Nostr entity resolution and injection
 * - Debug mode prefixing
 */

import { toolMessageStorage } from "@/conversations/persistence/ToolMessageStorage";
import { EventToModelMessage } from "@/conversations/processors/EventToModelMessage";
import { hasReasoningTag } from "@/conversations/utils/content-utils";
import { getNDK } from "@/nostr";
import { getPubkeyService } from "@/services/PubkeyService";
import { logger } from "@/utils/logger";
import {
    extractNostrEntities,
    resolveNostrEntitiesToSystemMessages,
} from "@/utils/nostr-entity-parser";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { ModelMessage } from "ai";

/**
 * Reconstruct tool messages from a published tool event when storage is unavailable.
 * Tool events are published with JSON content containing tool name, input, and output.
 * @internal Exported for testing
 */
export function reconstructToolMessagesFromEvent(event: NDKEvent): ModelMessage[] | null {
    try {
        const parsed = JSON.parse(event.content);

        // Validate required fields
        if (!parsed.tool || parsed.input === undefined) {
            logger.warn("[EventProcessor] Tool event missing required fields", {
                eventId: event.id.substring(0, 8),
                hasTool: !!parsed.tool,
                hasInput: parsed.input !== undefined,
            });
            return null;
        }

        // Use first 16 chars of event ID as toolCallId
        const toolCallId = `call_${event.id.substring(0, 16)}`;

        // Build the tool-call message (assistant role)
        const toolCallMessage: ModelMessage = {
            role: "assistant",
            content: [
                {
                    type: "tool-call" as const,
                    toolCallId,
                    toolName: parsed.tool,
                    input: parsed.input,
                },
            ],
        };

        // Build the tool-result message (tool role)
        const outputValue = parsed.output !== undefined
            ? (typeof parsed.output === "string" ? parsed.output : JSON.stringify(parsed.output))
            : "";

        const toolResultMessage: ModelMessage = {
            role: "tool",
            content: [
                {
                    type: "tool-result" as const,
                    toolCallId,
                    toolName: parsed.tool,
                    output: {
                        type: "text" as const,
                        value: outputValue,
                    },
                },
            ],
        };

        logger.debug("[EventProcessor] Reconstructed tool messages from event", {
            eventId: event.id.substring(0, 8),
            toolName: parsed.tool,
        });

        return [toolCallMessage, toolResultMessage];
    } catch (error) {
        logger.warn("[EventProcessor] Failed to parse tool event content", {
            eventId: event.id.substring(0, 8),
            error: error instanceof Error ? error.message : String(error),
        });
        return null;
    }
}

/**
 * Add debug prefix to message content
 */
function addDebugPrefix(messages: ModelMessage[], eventId: string): void {
    const eventIdPrefix = `[Event ${eventId.substring(0, 8)}] `;
    messages.forEach((msg) => {
        if (typeof msg.content === "string") {
            msg.content = eventIdPrefix + msg.content;
        }
    });
}

/**
 * Process a single event into messages
 */
export async function processEvent(
    event: NDKEvent,
    agentPubkey: string,
    conversationId: string,
    debug = false
): Promise<ModelMessage[]> {
    const messages: ModelMessage[] = [];

    // Skip reasoning events
    if (hasReasoningTag(event)) {
        return [];
    }

    // Check if this is a tool event from this agent
    const isToolEvent = event.tags.some((t) => t[0] === "tool");
    const isThisAgent = event.pubkey === agentPubkey;

    if (isToolEvent) {
        if (isThisAgent) {
            // Try to load tool messages from storage first
            let toolMessages = await toolMessageStorage.load(event.id);

            // Fallback: reconstruct from event content if storage missed it
            if (!toolMessages) {
                toolMessages = reconstructToolMessagesFromEvent(event);
            }

            if (toolMessages) {
                // Add event ID prefix in debug mode
                if (debug) {
                    addDebugPrefix(toolMessages, event.id);
                }
                messages.push(...toolMessages);
                return messages;
            }

            // If we still can't reconstruct, log and skip
            logger.warn("[EventProcessor] Could not load or reconstruct tool event", {
                eventId: event.id.substring(0, 8),
            });
            return [];
        } else {
            // Skip tool events from other agents
            return [];
        }
    }

    // Process regular message
    const content = event.content || "";

    // Use EventToModelMessage for proper attribution
    const result = await EventToModelMessage.transform(
        event,
        content,
        agentPubkey,
        conversationId
    );

    // Handle both single message and array of messages
    const messagesToAdd = Array.isArray(result) ? result : [result];

    // Add event ID prefix in debug mode
    if (debug) {
        addDebugPrefix(messagesToAdd, event.id);
    }

    messages.push(...messagesToAdd);

    // If not from this agent and contains nostr entities, append system messages
    if (event.pubkey !== agentPubkey) {
        const entities = extractNostrEntities(event.content || "");
        if (entities.length > 0) {
            try {
                const nameRepo = getPubkeyService();
                const ndk = getNDK();
                const entitySystemMessages = await resolveNostrEntitiesToSystemMessages(
                    event.content || "",
                    ndk,
                    (pubkey) => nameRepo.getName(pubkey)
                );

                for (const systemContent of entitySystemMessages) {
                    messages.push({
                        role: "system",
                        content: systemContent,
                    });
                }
            } catch (error) {
                logger.warn(
                    "[EventProcessor] Failed to resolve nostr entities",
                    {
                        error,
                        eventId: event.id.substring(0, 8),
                    }
                );
            }
        }
    }

    return messages;
}
