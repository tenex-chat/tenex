import { describe, expect, it } from "bun:test";
import { buildDistillationPrompt } from "../openclaw-distiller";

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
