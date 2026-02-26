import { describe, expect, it } from "bun:test";
import { buildDistillationPrompt, parseModelString } from "../openclaw-distiller";

describe("parseModelString", () => {
    it("parses provider:model format", () => {
        expect(parseModelString("anthropic:claude-sonnet-4-6")).toEqual({
            provider: "anthropic",
            model: "claude-sonnet-4-6",
        });
    });

    it("handles model with colons in name", () => {
        expect(parseModelString("openai:gpt-4:turbo")).toEqual({
            provider: "openai",
            model: "gpt-4:turbo",
        });
    });

    it("throws on string with no colon", () => {
        expect(() => parseModelString("anthropicclaudesonnet")).toThrow(
            'Invalid model format (expected "provider:model")'
        );
    });
});

describe("buildDistillationPrompt", () => {
    it("includes all provided files in prompt", () => {
        const prompt = buildDistillationPrompt({
            soul: "# Soul\nBe helpful.",
            identity: "# Identity\n- **Name:** Clippy",
            agents: "# Agents\nBe safe.",
            user: null,
        });
        expect(prompt).toContain("Be helpful.");
        expect(prompt).toContain("Clippy");
        expect(prompt).toContain("Be safe.");
    });

    it("omits sections for null files", () => {
        const prompt = buildDistillationPrompt({
            soul: "Soul content",
            identity: null,
            agents: null,
            user: null,
        });
        expect(prompt).toContain("Soul content");
        expect(prompt).not.toContain("IDENTITY.md");
        expect(prompt).not.toContain("AGENTS.md");
    });
});
