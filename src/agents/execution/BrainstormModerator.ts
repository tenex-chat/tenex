import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { ModelMessage } from "ai";
import { logger } from "@/utils/logger";
import { buildBrainstormModerationPrompt } from "@/prompts/fragments/brainstorm-moderation";
import type { ExecutionContext } from "./types";
import type { MessageGenerationStrategy } from "./strategies/types";

export interface BrainstormResponse {
    agent: {
        pubkey: string;
        name: string;
    };
    content: string;
    event: NDKEvent;
}

export interface ModerationResult {
    selectedAgents: string[];
    reasoning?: string;
}

/**
 * Handles brainstorm moderation to select the best response(s) from multiple agents
 */
export class BrainstormModerator {
    constructor(private messageStrategy: MessageGenerationStrategy) {}

    /**
     * Execute brainstorm moderation to select the best response(s)
     * @param context - Execution context with moderator agent
     * @param responses - Array of brainstorm responses to choose from
     * @returns The selected agents' pubkeys and optional reasoning
     */
    async moderate(
        context: ExecutionContext,
        responses: BrainstormResponse[]
    ): Promise<ModerationResult | null> {
        try {
            // Build messages using the strategy to get the moderator's full identity
            const messages = await this.messageStrategy.buildMessages(context, context.triggeringEvent);

            // Keep only system messages (agent identity, instructions, etc)
            const moderationMessages: ModelMessage[] = messages.filter(msg => msg.role === "system");

            // Add the moderation prompt messages
            const promptMessages = buildBrainstormModerationPrompt(
                context.triggeringEvent.content,
                responses.map(r => ({
                    name: r.agent.name,
                    pubkey: r.agent.pubkey,
                    content: r.content
                }))
            );
            moderationMessages.push(...promptMessages);

            logger.debug("[BrainstormModerator] Executing moderation", {
                moderator: context.agent.name,
                responseCount: responses.length,
                agents: responses.map(r => ({ name: r.agent.name, pubkey: r.agent.pubkey })),
                messageCount: moderationMessages.length
            });

            // Use regular text generation instead of generateObject
            // since Claude via OpenRouter doesn't support it well
            const response = await this.generateTextResponse(moderationMessages, context);

            if (!response) {
                logger.error("[BrainstormModerator] No response from moderator");
                return null;
            }

            // Parse JSON from response
            let parsed: { selectedAgents: string[]; reasoning?: string };
            try {
                // Clean the response - remove markdown code blocks if present
                const cleaned = response
                    .replace(/```json\n?/g, "")
                    .replace(/```\n?/g, "")
                    .trim();

                parsed = JSON.parse(cleaned);
            } catch (parseError) {
                logger.error("[BrainstormModerator] Failed to parse moderation response as JSON", {
                    response: response.substring(0, 200),
                    error: parseError instanceof Error ? parseError.message : String(parseError)
                });
                return null;
            }

            // Handle both single and multiple selections
            const selectedPubkeys = Array.isArray(parsed.selectedAgents)
                ? parsed.selectedAgents
                : [parsed.selectedAgents];

            if (selectedPubkeys.length === 0) {
                logger.info("[BrainstormModerator] No agents selected by moderator - defaulting to all responses");
                return {
                    selectedAgents: responses.map(r => r.agent.pubkey),
                    reasoning: parsed.reasoning || "Moderator did not select specific responses - including all"
                };
            }

            // Validate all selected agents exist and map to their pubkeys
            const validatedPubkeys: string[] = [];
            for (const selection of selectedPubkeys) {
                const matchingResponse = responses.find(r =>
                    r.agent.pubkey === selection ||
                    r.agent.name === selection
                );

                if (matchingResponse) {
                    validatedPubkeys.push(matchingResponse.agent.pubkey);
                } else {
                    logger.warn("[BrainstormModerator] Selected agent not found", {
                        selected: selection,
                        available: responses.map(r => ({ name: r.agent.name, pubkey: r.agent.pubkey }))
                    });
                }
            }

            if (validatedPubkeys.length === 0) {
                logger.error("[BrainstormModerator] No valid agents in selection");
                return null;
            }

            logger.info("[BrainstormModerator] Moderation complete", {
                moderator: context.agent.name,
                selectedCount: validatedPubkeys.length,
                selectedAgents: validatedPubkeys,
                reasoning: parsed.reasoning?.substring(0, 100)
            });

            return {
                selectedAgents: validatedPubkeys,
                reasoning: parsed.reasoning
            };

        } catch (error) {
            logger.error("[BrainstormModerator] Moderation failed", {
                error: error instanceof Error ? error.message : String(error),
                moderator: context.agent.name
            });
            return null;
        }
    }

    /**
     * Generate a text response using the LLM service
     */
    private async generateTextResponse(
        messages: ModelMessage[],
        context: ExecutionContext
    ): Promise<string | null> {
        try {
            const llmService = context.agent.createLLMService();

            // Use complete() since we don't need streaming
            const result = await llmService.complete(
                messages,
                {}  // no tools needed for moderation
            );

            return result.text?.trim() || null;
        } catch (error) {
            logger.error("[BrainstormModerator] Failed to generate text response", {
                error: error instanceof Error ? error.message : String(error)
            });
            return null;
        }
    }
}
