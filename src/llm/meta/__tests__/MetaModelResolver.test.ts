import { describe, it, expect } from "bun:test";
import { MetaModelResolver } from "../MetaModelResolver";
import type { MetaModelConfiguration } from "@/services/config/types";

// Sample meta model configuration for testing
const createTestConfig = (): MetaModelConfiguration => ({
    provider: "meta",
    variants: {
        fast: {
            model: "claude-haiku",
            keywords: ["fast", "quick"],
            description: "Low-budget model for fast responses",
        },
        standard: {
            model: "claude-sonnet",
            keywords: ["think", "ponder"],
            description: "Standard model for most tasks",
        },
        deep: {
            model: "claude-opus",
            keywords: ["ultrathink", "deep"],
            description: "High-cost model for complex reasoning",
            systemPrompt: "Take your time and reason step by step.",
        },
    },
    default: "standard",
});

describe("MetaModelResolver", () => {
    describe("resolve", () => {
        it("should return default variant when no message is provided", () => {
            const config = createTestConfig();
            const result = MetaModelResolver.resolve(config);

            expect(result.variantName).toBe("standard");
            expect(result.configName).toBe("claude-sonnet");
            expect(result.matchedKeywords).toEqual([]);
        });

        it("should return default variant when message has no keywords", () => {
            const config = createTestConfig();
            const result = MetaModelResolver.resolve(config, "How do we implement authentication?");

            expect(result.variantName).toBe("standard");
            expect(result.configName).toBe("claude-sonnet");
            expect(result.matchedKeywords).toEqual([]);
        });

        it("should resolve variant based on keyword at start of message", () => {
            const config = createTestConfig();
            const result = MetaModelResolver.resolve(config, "ultrathink how do we implement authentication?");

            expect(result.variantName).toBe("deep");
            expect(result.configName).toBe("claude-opus");
            expect(result.matchedKeywords).toContain("ultrathink");
        });

        it("should strip keywords from message when stripKeywords is true", () => {
            const config = createTestConfig();
            const result = MetaModelResolver.resolve(config, "ultrathink how do we implement authentication?", {
                stripKeywords: true,
            });

            expect(result.strippedMessage).toBe("how do we implement authentication?");
        });

        it("should preserve original message when stripKeywords is false", () => {
            const config = createTestConfig();
            const originalMessage = "ultrathink how do we implement authentication?";
            const result = MetaModelResolver.resolve(config, originalMessage, {
                stripKeywords: false,
            });

            // When stripKeywords is false, the strippedMessage is the original message
            expect(result.strippedMessage).toBe(originalMessage);
        });

        it("should select first matching keyword when keyword is at start", () => {
            const config = createTestConfig();
            // When "think" is at the start, it matches the standard tier (tier 2)
            // "ultrathink" is not at the start, so it doesn't match
            const result = MetaModelResolver.resolve(config, "think ultrathink what's going on?");

            // "think" matches and resolves to standard variant
            expect(result.variantName).toBe("standard");
            expect(result.configName).toBe("claude-sonnet");
        });

        it("should select ultrathink when it is the first keyword", () => {
            const config = createTestConfig();
            // When "ultrathink" is at the start, it matches tier 3
            const result = MetaModelResolver.resolve(config, "ultrathink think what's going on?");

            expect(result.variantName).toBe("deep");
            expect(result.configName).toBe("claude-opus");
        });

        it("should be case-insensitive for keyword matching", () => {
            const config = createTestConfig();
            const result = MetaModelResolver.resolve(config, "ULTRATHINK what should we do?");

            expect(result.variantName).toBe("deep");
            expect(result.configName).toBe("claude-opus");
        });

        it("should include systemPrompt from variant", () => {
            const config = createTestConfig();
            const result = MetaModelResolver.resolve(config, "ultrathink analyze this");

            expect(result.systemPrompt).toBe("Take your time and reason step by step.");
        });

        it("should handle keywords with leading whitespace", () => {
            const config = createTestConfig();
            const result = MetaModelResolver.resolve(config, "   fast what's 2+2?");

            expect(result.variantName).toBe("fast");
            expect(result.configName).toBe("claude-haiku");
        });

        it("should not match keyword in middle of message", () => {
            const config = createTestConfig();
            const result = MetaModelResolver.resolve(config, "please think about this carefully");

            // "think" is in the middle, should not match
            expect(result.variantName).toBe("standard");
            expect(result.matchedKeywords).toEqual([]);
        });

        it("should handle empty message", () => {
            const config = createTestConfig();
            const result = MetaModelResolver.resolve(config, "");

            expect(result.variantName).toBe("standard");
            expect(result.configName).toBe("claude-sonnet");
        });
    });

    describe("generateSystemPromptFragment", () => {
        it("should generate system prompt with all variants", () => {
            const config = createTestConfig();
            const fragment = MetaModelResolver.generateSystemPromptFragment(config);

            expect(fragment).toContain("You have access to the following models");
            expect(fragment).toContain("fast");
            expect(fragment).toContain("standard");
            expect(fragment).toContain("deep");
            expect(fragment).toContain("Low-budget model for fast responses");
            expect(fragment).toContain("High-cost model for complex reasoning");
        });

        it("should not include preamble description", () => {
            const config = createTestConfig();
            const fragment = MetaModelResolver.generateSystemPromptFragment(config);

            expect(fragment).toStartWith("You have access to the following models");
        });

        it("should include keywords in variant descriptions", () => {
            const config = createTestConfig();
            const fragment = MetaModelResolver.generateSystemPromptFragment(config);

            expect(fragment).toContain("trigger: fast, quick");
            expect(fragment).toContain("trigger: ultrathink, deep");
        });
    });

    describe("isMetaModel", () => {
        it("should return true for valid meta model config", () => {
            const config = createTestConfig();
            expect(MetaModelResolver.isMetaModel(config)).toBe(true);
        });

        it("should return false for standard LLM config", () => {
            const config = {
                provider: "anthropic",
                model: "claude-sonnet-4",
            };
            expect(MetaModelResolver.isMetaModel(config)).toBe(false);
        });

        it("should return false for null/undefined", () => {
            expect(MetaModelResolver.isMetaModel(null)).toBe(false);
            expect(MetaModelResolver.isMetaModel(undefined)).toBe(false);
        });

        it("should return false for non-object", () => {
            expect(MetaModelResolver.isMetaModel("string")).toBe(false);
            expect(MetaModelResolver.isMetaModel(123)).toBe(false);
        });
    });
});
