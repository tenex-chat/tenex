import { describe, expect, it } from "bun:test";
import { buildDistillationPrompt, buildUserContextPrompt } from "../openclaw-distiller";

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

describe("buildUserContextPrompt", () => {
    it("includes the raw user content in the prompt", () => {
        const raw = "- **Name:** Pablo\n- **Timezone:** GMT+2";
        const prompt = buildUserContextPrompt(raw);
        expect(prompt).toContain("Pablo");
        expect(prompt).toContain("GMT+2");
        expect(prompt).toContain("<USER.md>");
    });

    it("instructs the model to drop noise and keep useful info", () => {
        const prompt = buildUserContextPrompt("anything");
        expect(prompt).toContain("Drop anything that is noise");
        expect(prompt).toContain("useful for an AI assistant");
    });
});
