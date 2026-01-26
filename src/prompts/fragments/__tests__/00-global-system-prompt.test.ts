import { describe, expect, test, beforeEach, spyOn } from "bun:test";
import { globalSystemPromptFragment } from "../00-global-system-prompt";
import { config } from "@/services/ConfigService";
import type { TenexConfig } from "@/services/config/types";

describe("global-system-prompt fragment", () => {
    let getConfigSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        // Reset spy before each test
        getConfigSpy?.mockRestore();
    });

    test("has correct id and priority", () => {
        expect(globalSystemPromptFragment.id).toBe("global-system-prompt");
        expect(globalSystemPromptFragment.priority).toBe(0.5);
    });

    test("priority is lower than agent-identity (1)", () => {
        // Global system prompt should appear before agent identity
        expect(globalSystemPromptFragment.priority).toBeLessThan(1);
    });

    test("returns empty string when config throws (not loaded)", () => {
        getConfigSpy = spyOn(config, "getConfig").mockImplementation(() => {
            throw new Error("Config not loaded");
        });

        const result = globalSystemPromptFragment.template({});
        expect(result).toBe("");
    });

    test("returns empty string when globalSystemPrompt is undefined", () => {
        getConfigSpy = spyOn(config, "getConfig").mockReturnValue({} as TenexConfig);

        const result = globalSystemPromptFragment.template({});
        expect(result).toBe("");
    });

    test("returns empty string when content is empty", () => {
        getConfigSpy = spyOn(config, "getConfig").mockReturnValue({
            globalSystemPrompt: {
                enabled: true,
                content: "",
            },
        } as TenexConfig);

        const result = globalSystemPromptFragment.template({});
        expect(result).toBe("");
    });

    test("returns empty string when content is only whitespace", () => {
        getConfigSpy = spyOn(config, "getConfig").mockReturnValue({
            globalSystemPrompt: {
                enabled: true,
                content: "   \n\t  ",
            },
        } as TenexConfig);

        const result = globalSystemPromptFragment.template({});
        expect(result).toBe("");
    });

    test("returns empty string when explicitly disabled", () => {
        getConfigSpy = spyOn(config, "getConfig").mockReturnValue({
            globalSystemPrompt: {
                enabled: false,
                content: "This should not appear",
            },
        } as TenexConfig);

        const result = globalSystemPromptFragment.template({});
        expect(result).toBe("");
    });

    test("returns content when enabled with valid content", () => {
        const expectedContent = "Always use TypeScript strict mode";
        getConfigSpy = spyOn(config, "getConfig").mockReturnValue({
            globalSystemPrompt: {
                enabled: true,
                content: expectedContent,
            },
        } as TenexConfig);

        const result = globalSystemPromptFragment.template({});
        expect(result).toBe(expectedContent);
    });

    test("returns trimmed content", () => {
        getConfigSpy = spyOn(config, "getConfig").mockReturnValue({
            globalSystemPrompt: {
                enabled: true,
                content: "  Some content with whitespace  \n",
            },
        } as TenexConfig);

        const result = globalSystemPromptFragment.template({});
        expect(result).toBe("Some content with whitespace");
    });

    test("returns content when enabled is undefined (defaults to enabled)", () => {
        const expectedContent = "Content with no explicit enabled flag";
        getConfigSpy = spyOn(config, "getConfig").mockReturnValue({
            globalSystemPrompt: {
                content: expectedContent,
            },
        } as TenexConfig);

        const result = globalSystemPromptFragment.template({});
        expect(result).toBe(expectedContent);
    });

    test("preserves markdown headings in content", () => {
        const contentWithHeadings = `# Main Heading
## Subheading
Some content here`;
        getConfigSpy = spyOn(config, "getConfig").mockReturnValue({
            globalSystemPrompt: {
                enabled: true,
                content: contentWithHeadings,
            },
        } as TenexConfig);

        const result = globalSystemPromptFragment.template({});
        expect(result).toBe(contentWithHeadings);
        expect(result).toContain("# Main Heading");
        expect(result).toContain("## Subheading");
    });
});
