import { describe, expect, it } from "bun:test";
import type { SkillData } from "@/services/skill";
import { renderSkill, renderLoadedSkillsBlock, renderToolPermissionsHeader } from "@/agents/execution/skill-reminder-renderers";

function createSkill(overrides: Partial<SkillData> = {}): SkillData {
    return {
        identifier: "poster-kit",
        content: "This is the skill content",
        installedFiles: [],
        ...overrides,
    };
}

describe("renderSkill", () => {
    it("should render skill tag with id", () => {
        const result = renderSkill(createSkill());

        expect(result).toContain("<skill");
        expect(result).toContain('id="poster-kit"');
        expect(result).toContain("This is the skill content");
        expect(result).toContain("</skill>");
    });

    it("should include path for non-built-in skills", () => {
        const result = renderSkill(
            createSkill({ localDir: "/home/user/.agents/skills/poster-kit", scope: "agent" }),
            { "$AGENT_HOME": "/home/user/.agents" }
        );

        expect(result).toContain('path="$AGENT_HOME/skills/poster-kit"');
    });

    it("should omit path for built-in skills", () => {
        const result = renderSkill(
            createSkill({ localDir: "/app/src/skills/built-in/shell", scope: "built-in" })
        );

        expect(result).not.toContain("path=");
    });

    it("should show failed file downloads", () => {
        const result = renderSkill(
            createSkill({
                installedFiles: [
                    {
                        eventId: "event2",
                        relativePath: "data/missing.json",
                        absolutePath: "/home/.tenex/skills/poster-kit/data/missing.json",
                        success: false,
                        error: "Download timed out",
                    },
                ],
            })
        );

        expect(result).toContain("## Failed File Downloads");
        expect(result).toContain("data/missing.json: Download timed out");
    });

    it("should not show failed files section when all succeeded", () => {
        const result = renderSkill(createSkill({ content: "Skill without files" }));

        expect(result).not.toContain("## Failed File Downloads");
    });

    it("should escape special characters in attributes", () => {
        const result = renderSkill(createSkill({ content: "Test content", identifier: 'name-with-"quotes"' }));

        expect(result).toContain('id="name-with-&quot;quotes&quot;"');
    });
});

describe("renderLoadedSkillsBlock", () => {
    it("should return null when no skills", () => {
        const result = renderLoadedSkillsBlock([]);
        expect(result).toBeNull();
    });

    it("should render header and skills", () => {
        const result = renderLoadedSkillsBlock([createSkill({ content: "Skill content" })]);

        expect(result).toContain("## Loaded Skills");
        expect(result).toContain("Skill content");
    });

    it("should include tool permissions header when provided", () => {
        const result = renderLoadedSkillsBlock(
            [createSkill()],
            { denyTools: ["dangerous_tool"] }
        );

        expect(result).toContain("<skill-tool-permissions>");
        expect(result).toContain("Tools disabled: dangerous_tool");
    });
});

describe("renderToolPermissionsHeader", () => {
    it("should return empty string with no permissions", () => {
        expect(renderToolPermissionsHeader({})).toBe("");
    });

    it("should render only-tool mode", () => {
        const result = renderToolPermissionsHeader({ onlyTools: ["tool_a", "tool_b"] });

        expect(result).toContain("restricted to: tool_a, tool_b");
    });

    it("should render allow and deny tools", () => {
        const result = renderToolPermissionsHeader({
            allowTools: ["tool_a"],
            denyTools: ["tool_b"],
        });

        expect(result).toContain("Additional tools enabled: tool_a");
        expect(result).toContain("Tools disabled: tool_b");
    });
});
