import { describe, it, expect } from "bun:test";
import { OpenRouterProvider } from "../standard/OpenRouterProvider";
import { AnthropicProvider } from "../standard/AnthropicProvider";
import { OpenAIProvider } from "../standard/OpenAIProvider";
import { OllamaProvider } from "../standard/OllamaProvider";
import { GeminiCliProvider } from "../standard/GeminiCliProvider";
import { ClaudeCodeProvider } from "../agent/ClaudeCodeProvider";
import { CodexCliProvider } from "../agent/CodexCliProvider";

describe("Provider Metadata", () => {
    describe("standard providers", () => {
        it("OpenRouterProvider has correct static METADATA", () => {
            expect(OpenRouterProvider.METADATA.id).toBe("openrouter");
            expect(OpenRouterProvider.METADATA.category).toBe("standard");
            expect(OpenRouterProvider.METADATA.capabilities.requiresApiKey).toBe(true);
        });

        it("AnthropicProvider has correct static METADATA", () => {
            expect(AnthropicProvider.METADATA.id).toBe("anthropic");
            expect(AnthropicProvider.METADATA.category).toBe("standard");
            expect(AnthropicProvider.METADATA.capabilities.requiresApiKey).toBe(true);
        });

        it("OpenAIProvider has correct static METADATA", () => {
            expect(OpenAIProvider.METADATA.id).toBe("openai");
            expect(OpenAIProvider.METADATA.category).toBe("standard");
            expect(OpenAIProvider.METADATA.capabilities.requiresApiKey).toBe(true);
        });

        it("OllamaProvider has correct static METADATA", () => {
            expect(OllamaProvider.METADATA.id).toBe("ollama");
            expect(OllamaProvider.METADATA.category).toBe("standard");
            expect(OllamaProvider.METADATA.capabilities.requiresApiKey).toBe(false);
        });

        it("GeminiCliProvider has correct static METADATA", () => {
            expect(GeminiCliProvider.METADATA.id).toBe("gemini-cli");
            expect(GeminiCliProvider.METADATA.category).toBe("standard");
            expect(GeminiCliProvider.METADATA.capabilities.requiresApiKey).toBe(false);
        });
    });

    describe("agent providers", () => {
        it("ClaudeCodeProvider has correct static METADATA with kebab-case id", () => {
            expect(ClaudeCodeProvider.METADATA.id).toBe("claude-code");
            expect(ClaudeCodeProvider.METADATA.category).toBe("agent");
            expect(ClaudeCodeProvider.METADATA.capabilities.builtInTools).toBe(true);
            expect(ClaudeCodeProvider.METADATA.capabilities.sessionResumption).toBe(true);
            expect(ClaudeCodeProvider.METADATA.capabilities.mcpSupport).toBe(true);
            expect(ClaudeCodeProvider.METADATA.capabilities.requiresApiKey).toBe(false);
        });

        it("CodexCliProvider has correct static METADATA with kebab-case id", () => {
            expect(CodexCliProvider.METADATA.id).toBe("codex-cli");
            expect(CodexCliProvider.METADATA.category).toBe("agent");
            expect(CodexCliProvider.METADATA.capabilities.builtInTools).toBe(true);
            expect(CodexCliProvider.METADATA.capabilities.sessionResumption).toBe(true);
            expect(CodexCliProvider.METADATA.capabilities.mcpSupport).toBe(true);
            expect(CodexCliProvider.METADATA.capabilities.requiresApiKey).toBe(false);
        });
    });

    describe("instance metadata matches static", () => {
        it("provider instance metadata matches static METADATA", () => {
            const openRouter = new OpenRouterProvider();
            expect(openRouter.metadata).toBe(OpenRouterProvider.METADATA);

            const anthropic = new AnthropicProvider();
            expect(anthropic.metadata).toBe(AnthropicProvider.METADATA);

            const claudeCode = new ClaudeCodeProvider();
            expect(claudeCode.metadata).toBe(ClaudeCodeProvider.METADATA);

            const codexCli = new CodexCliProvider();
            expect(codexCli.metadata).toBe(CodexCliProvider.METADATA);
        });
    });
});

describe("Provider ID conventions", () => {
    it("all provider IDs use kebab-case", () => {
        const allMetadata = [
            OpenRouterProvider.METADATA,
            AnthropicProvider.METADATA,
            OpenAIProvider.METADATA,
            OllamaProvider.METADATA,
            GeminiCliProvider.METADATA,
            ClaudeCodeProvider.METADATA,
            CodexCliProvider.METADATA,
        ];

        for (const metadata of allMetadata) {
            // Check that ID is lowercase and uses hyphens, not camelCase
            expect(metadata.id).toBe(metadata.id.toLowerCase());
            expect(metadata.id).not.toMatch(/[A-Z]/);
        }
    });
});

describe("Provider Registration Array", () => {
    it("ALL_PROVIDER_REGISTRATIONS uses static METADATA (not instances)", async () => {
        const { ALL_PROVIDER_REGISTRATIONS } = await import("../index");

        for (const registration of ALL_PROVIDER_REGISTRATIONS) {
            // The metadata should be the same object as the static METADATA
            const instance = new registration.Provider();
            expect(registration.metadata).toBe(instance.metadata);
        }
    });

    it("contains all expected providers", async () => {
        const { ALL_PROVIDER_REGISTRATIONS } = await import("../index");

        const ids = ALL_PROVIDER_REGISTRATIONS.map(r => r.metadata.id);

        expect(ids).toContain("openrouter");
        expect(ids).toContain("anthropic");
        expect(ids).toContain("openai");
        expect(ids).toContain("ollama");
        expect(ids).toContain("gemini-cli");
        expect(ids).toContain("claude-code");
        expect(ids).toContain("codex-cli");
    });
});
