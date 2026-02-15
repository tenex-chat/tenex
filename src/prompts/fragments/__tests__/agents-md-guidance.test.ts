import { describe, expect, it } from "bun:test";
import { agentsMdGuidanceFragment } from "../31-agents-md-guidance";

describe("agentsMdGuidanceFragment", () => {
    it("should have correct id", () => {
        expect(agentsMdGuidanceFragment.id).toBe("agents-md-guidance");
    });

    it("should have priority 31 (after worktree context)", () => {
        expect(agentsMdGuidanceFragment.priority).toBe(31);
    });

    describe("when project has no AGENTS.md", () => {
        it("should return non-empty content", () => {
            const result = agentsMdGuidanceFragment.template({
                hasRootAgentsMd: false,
            });

            expect(result).not.toBe("");
            expect(result.length).toBeGreaterThan(0);
        });

        it("should include the header", () => {
            const result = agentsMdGuidanceFragment.template({
                hasRootAgentsMd: false,
            });

            expect(result).toContain("## AGENTS.md Guidelines");
        });

        it("should explicitly state no root AGENTS.md exists", () => {
            const result = agentsMdGuidanceFragment.template({
                hasRootAgentsMd: false,
            });

            expect(result).toContain("No root AGENTS.md file exists");
        });

        it("should explain what AGENTS.md files are for", () => {
            const result = agentsMdGuidanceFragment.template({
                hasRootAgentsMd: false,
            });

            expect(result).toContain("contextual guidelines for AI agents");
        });

        it("should suggest creating an AGENTS.md file", () => {
            const result = agentsMdGuidanceFragment.template({
                hasRootAgentsMd: false,
            });

            expect(result).toContain("consider creating an AGENTS.md file");
        });

        it("should NOT include detailed instructions (those are for projects with AGENTS.md)", () => {
            const result = agentsMdGuidanceFragment.template({
                hasRootAgentsMd: false,
            });

            expect(result).not.toContain("### How AGENTS.md Works");
            expect(result).not.toContain("### Writing AGENTS.md Files");
        });
    });

    describe("when project has AGENTS.md", () => {
        it("should include the header", () => {
            const result = agentsMdGuidanceFragment.template({
                hasRootAgentsMd: true,
            });

            expect(result).toContain("## AGENTS.md Guidelines");
        });

        it("should include how AGENTS.md works section", () => {
            const result = agentsMdGuidanceFragment.template({
                hasRootAgentsMd: true,
            });

            expect(result).toContain("### How AGENTS.md Works");
            expect(result).toContain("README for Agents");
            expect(result).toContain("Automatic Injection");
        });

        it("should include writing guidelines", () => {
            const result = agentsMdGuidanceFragment.template({
                hasRootAgentsMd: true,
            });

            expect(result).toContain("### Writing AGENTS.md Files");
            expect(result).toContain("executable commands");
        });

        it("should include format example", () => {
            const result = agentsMdGuidanceFragment.template({
                hasRootAgentsMd: true,
            });

            expect(result).toContain("### AGENTS.md Format");
            expect(result).toContain("```markdown");
        });

        it("should explain hierarchy", () => {
            const result = agentsMdGuidanceFragment.template({
                hasRootAgentsMd: true,
            });

            expect(result).toContain("Deeper, more specific AGENTS.md files override general root instructions");
        });
    });

    describe("root AGENTS.md content inclusion", () => {
        it("should include short root content when provided", () => {
            const shortContent = "# Project Guidelines\n\nUse TypeScript.";
            const result = agentsMdGuidanceFragment.template({
                hasRootAgentsMd: true,
                rootAgentsMdContent: shortContent,
            });

            expect(result).toContain("### Root AGENTS.md");
            expect(result).toContain("Use TypeScript");
        });

        it("should NOT include root content when too long (>2000 chars)", () => {
            const longContent = "x".repeat(2500);
            const result = agentsMdGuidanceFragment.template({
                hasRootAgentsMd: true,
                rootAgentsMdContent: longContent,
            });

            expect(result).not.toContain("### Root AGENTS.md");
            expect(result).not.toContain(longContent);
        });

        it("should include content that is exactly at the threshold", () => {
            const exactContent = "x".repeat(1999);
            const result = agentsMdGuidanceFragment.template({
                hasRootAgentsMd: true,
                rootAgentsMdContent: exactContent,
            });

            expect(result).toContain("### Root AGENTS.md");
        });

        it("should trim whitespace from root content", () => {
            const contentWithWhitespace = "  \n\nContent here\n\n  ";
            const result = agentsMdGuidanceFragment.template({
                hasRootAgentsMd: true,
                rootAgentsMdContent: contentWithWhitespace,
            });

            expect(result).toContain("Content here");
            expect(result).not.toContain("  \n\nContent");
        });
    });
});
