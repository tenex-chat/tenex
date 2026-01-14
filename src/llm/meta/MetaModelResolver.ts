/**
 * MetaModelResolver - Handles dynamic model selection based on keywords
 *
 * Meta models are virtual model configurations that select from underlying
 * real models based on keywords in the user's message. This enables
 * "think harder" type functionality without explicit tool calls.
 *
 * @example
 * User: "ultrathink how do we implement authentication?"
 * → Resolves to high-cost reasoning model, strips "ultrathink" from message
 *
 * User: "quick what's 2+2?"
 * → Resolves to fast model, strips "quick" from message
 */

import type { MetaModelConfiguration, MetaModelVariant } from "@/services/config/types";
import { logger } from "@/utils/logger";

/**
 * Result of resolving a meta model variant
 */
export interface MetaModelResolution {
    /** The resolved variant name */
    variantName: string;
    /** The variant configuration */
    variant: MetaModelVariant;
    /** The underlying LLM configuration name to use */
    configName: string;
    /** The message with keywords stripped (if stripKeywords was true) */
    strippedMessage?: string;
    /** Keywords that were matched */
    matchedKeywords: string[];
    /** Optional additional system prompt from the variant */
    systemPrompt?: string;
}

/**
 * Options for resolving a meta model
 */
export interface ResolveOptions {
    /** Whether to strip matched keywords from the message (default: true) */
    stripKeywords?: boolean;
}

/**
 * MetaModelResolver handles keyword detection and model resolution
 * for meta model configurations.
 */
export class MetaModelResolver {
    /**
     * Build a keyword-to-variant lookup map from a meta model configuration.
     * Keywords are normalized to lowercase for case-insensitive matching.
     */
    private static buildKeywordMap(
        config: MetaModelConfiguration
    ): Map<string, { variantName: string; variant: MetaModelVariant }> {
        const keywordMap = new Map<string, { variantName: string; variant: MetaModelVariant }>();

        for (const [variantName, variant] of Object.entries(config.variants)) {
            if (variant.keywords) {
                for (const keyword of variant.keywords) {
                    const normalizedKeyword = keyword.toLowerCase();
                    keywordMap.set(normalizedKeyword, { variantName, variant });
                }
            }
        }

        return keywordMap;
    }

    /**
     * Find all matching keywords at the start of a message.
     * Returns keywords in the order they appear, for proper stripping.
     */
    private static findMatchingKeywords(
        message: string,
        keywordMap: Map<string, { variantName: string; variant: MetaModelVariant }>
    ): Array<{ keyword: string; variantName: string; variant: MetaModelVariant; position: number }> {
        const matches: Array<{
            keyword: string;
            variantName: string;
            variant: MetaModelVariant;
            position: number;
        }> = [];

        // Get all keywords, sorted by length (longest first for proper matching)
        const keywords = Array.from(keywordMap.keys()).sort((a, b) => b.length - a.length);

        // Check the beginning of the message for keywords
        // Keywords must be at the start or preceded by whitespace
        const messageLower = message.toLowerCase();

        for (const keyword of keywords) {
            // Check if keyword is at the start
            if (messageLower.startsWith(keyword)) {
                const afterKeyword = message.charAt(keyword.length);
                // Keyword must be followed by whitespace or end of string
                if (!afterKeyword || /\s/.test(afterKeyword)) {
                    const data = keywordMap.get(keyword);
                    if (data) {
                        matches.push({
                            keyword,
                            variantName: data.variantName,
                            variant: data.variant,
                            position: 0,
                        });
                    }
                }
            }

            // Also check for keywords after initial whitespace (e.g., "  ultrathink ...")
            const leadingWhitespaceMatch = messageLower.match(/^\s+/);
            if (leadingWhitespaceMatch) {
                const offset = leadingWhitespaceMatch[0].length;
                const restLower = messageLower.substring(offset);
                if (restLower.startsWith(keyword)) {
                    const afterKeyword = message.charAt(offset + keyword.length);
                    if (!afterKeyword || /\s/.test(afterKeyword)) {
                        const data = keywordMap.get(keyword);
                        if (data && !matches.some((m) => m.keyword === keyword)) {
                            matches.push({
                                keyword,
                                variantName: data.variantName,
                                variant: data.variant,
                                position: offset,
                            });
                        }
                    }
                }
            }
        }

        return matches;
    }

    /**
     * Select the winning variant from a set of matches using tier-based resolution.
     * Highest tier wins. If tiers are equal, first match wins.
     */
    private static selectWinningVariant(
        matches: Array<{ keyword: string; variantName: string; variant: MetaModelVariant; position: number }>
    ): { keyword: string; variantName: string; variant: MetaModelVariant; position: number } | null {
        if (matches.length === 0) {
            return null;
        }

        // Sort by tier (descending), then by position (ascending for first match)
        const sorted = [...matches].sort((a, b) => {
            const tierA = a.variant.tier ?? 0;
            const tierB = b.variant.tier ?? 0;
            if (tierB !== tierA) {
                return tierB - tierA; // Higher tier wins
            }
            return a.position - b.position; // Earlier position wins if tiers equal
        });

        return sorted[0];
    }

    /**
     * Strip matched keywords from the beginning of a message.
     * Preserves the rest of the message content.
     */
    private static stripKeywordsFromMessage(
        message: string,
        matchedKeywords: string[]
    ): string {
        let result = message;

        for (const keyword of matchedKeywords) {
            // Match the keyword at the start (case-insensitive) followed by optional whitespace
            const regex = new RegExp(`^\\s*${escapeRegExp(keyword)}\\s*`, "i");
            result = result.replace(regex, "");
        }

        return result.trim();
    }

    /**
     * Resolve which variant to use based on the message content.
     *
     * @param config The meta model configuration
     * @param message The user's message to analyze for keywords
     * @param options Resolution options
     * @returns The resolved variant information, or null if using default
     */
    static resolve(
        config: MetaModelConfiguration,
        message?: string,
        options: ResolveOptions = {}
    ): MetaModelResolution {
        const { stripKeywords = true } = options;

        // Build keyword map
        const keywordMap = this.buildKeywordMap(config);

        // If no message provided, use default
        if (!message) {
            const defaultVariant = config.variants[config.default];
            if (!defaultVariant) {
                throw new Error(
                    `Meta model default variant "${config.default}" not found in variants`
                );
            }
            return {
                variantName: config.default,
                variant: defaultVariant,
                configName: defaultVariant.model,
                matchedKeywords: [],
                systemPrompt: defaultVariant.systemPrompt,
            };
        }

        // Find matching keywords
        const matches = this.findMatchingKeywords(message, keywordMap);

        // If no keywords matched, use default
        if (matches.length === 0) {
            const defaultVariant = config.variants[config.default];
            if (!defaultVariant) {
                throw new Error(
                    `Meta model default variant "${config.default}" not found in variants`
                );
            }
            return {
                variantName: config.default,
                variant: defaultVariant,
                configName: defaultVariant.model,
                matchedKeywords: [],
                systemPrompt: defaultVariant.systemPrompt,
            };
        }

        // Select winning variant based on tier
        const winner = this.selectWinningVariant(matches);
        if (!winner) {
            // Shouldn't happen if matches.length > 0, but handle gracefully
            const defaultVariant = config.variants[config.default];
            return {
                variantName: config.default,
                variant: defaultVariant,
                configName: defaultVariant.model,
                matchedKeywords: [],
                systemPrompt: defaultVariant.systemPrompt,
            };
        }

        // Collect all matched keywords (for logging/debugging)
        const matchedKeywords = matches.map((m) => m.keyword);

        // Strip keywords if requested
        const strippedMessage = stripKeywords
            ? this.stripKeywordsFromMessage(message, matchedKeywords)
            : message;

        logger.debug("[MetaModelResolver] Resolved variant", {
            variantName: winner.variantName,
            matchedKeywords,
            tier: winner.variant.tier ?? 0,
            configName: winner.variant.model,
        });

        return {
            variantName: winner.variantName,
            variant: winner.variant,
            configName: winner.variant.model,
            strippedMessage,
            matchedKeywords,
            systemPrompt: winner.variant.systemPrompt,
        };
    }

    /**
     * Resolve directly to a specific variant by name.
     * Used when there's a variant override set (e.g., via change_model tool).
     *
     * @param config The meta model configuration
     * @param variantName The name of the variant to resolve to
     * @returns The resolved variant information
     * @throws Error if the variant doesn't exist
     */
    static resolveToVariant(
        config: MetaModelConfiguration,
        variantName: string
    ): MetaModelResolution {
        const variant = config.variants[variantName];
        if (!variant) {
            throw new Error(
                `Meta model variant "${variantName}" not found. Available variants: ${Object.keys(config.variants).join(", ")}`
            );
        }

        logger.debug("[MetaModelResolver] Resolved to override variant", {
            variantName,
            configName: variant.model,
        });

        return {
            variantName,
            variant,
            configName: variant.model,
            matchedKeywords: [],
            systemPrompt: variant.systemPrompt,
        };
    }

    /**
     * Generate a system prompt fragment describing available variants.
     * This helps the model understand what models are available and when to use them.
     *
     * @param config The meta model configuration
     * @returns A system prompt fragment describing the variants
     */
    static generateSystemPromptFragment(config: MetaModelConfiguration): string {
        const lines: string[] = [];

        if (config.description) {
            lines.push(config.description);
            lines.push("");
        }

        lines.push("You have access to the following models via change_model() tool:");

        for (const [variantName, variant] of Object.entries(config.variants)) {
            const description = variant.description || `Model variant "${variantName}"`;
            const keywords = variant.keywords?.length
                ? ` (trigger: ${variant.keywords.join(", ")})`
                : "";
            lines.push(`* ${variantName}${keywords} → ${description}`);
        }

        return lines.join("\n");
    }

    /**
     * Check if a configuration is a meta model configuration.
     */
    static isMetaModel(config: unknown): config is MetaModelConfiguration {
        if (!config || typeof config !== "object") {
            return false;
        }
        const c = config as Record<string, unknown>;
        return c.provider === "meta" && typeof c.variants === "object" && typeof c.default === "string";
    }
}

/**
 * Escape special regex characters in a string
 */
function escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
