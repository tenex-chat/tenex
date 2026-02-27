import { describe, expect, it } from "bun:test";
import {
    CATEGORY_DENIED_TOOLS,
    DEFAULT_CATEGORY,
    filterDeniedTools,
    isValidCategory,
    resolveCategory,
    type AgentCategory,
} from "../role-categories";

describe("role-categories", () => {
    describe("resolveCategory", () => {
        it("should return the category when it is valid", () => {
            expect(resolveCategory("principal")).toBe("principal");
            expect(resolveCategory("orchestrator")).toBe("orchestrator");
            expect(resolveCategory("worker")).toBe("worker");
            expect(resolveCategory("advisor")).toBe("advisor");
            expect(resolveCategory("auditor")).toBe("auditor");
        });

        it("should return default (advisor) for undefined", () => {
            expect(resolveCategory(undefined)).toBe("advisor");
        });

        it("should return default (advisor) for unrecognized strings", () => {
            expect(resolveCategory("unknown")).toBe("advisor");
            expect(resolveCategory("developer")).toBe("advisor");
            expect(resolveCategory("")).toBe("advisor");
        });

        it("should be case-sensitive", () => {
            expect(resolveCategory("Principal")).toBe("advisor");
            expect(resolveCategory("WORKER")).toBe("advisor");
        });
    });

    describe("isValidCategory", () => {
        it("should return true for all valid categories", () => {
            expect(isValidCategory("principal")).toBe(true);
            expect(isValidCategory("orchestrator")).toBe(true);
            expect(isValidCategory("worker")).toBe(true);
            expect(isValidCategory("advisor")).toBe(true);
            expect(isValidCategory("auditor")).toBe(true);
        });

        it("should return false for invalid categories", () => {
            expect(isValidCategory("unknown")).toBe(false);
            expect(isValidCategory("")).toBe(false);
            expect(isValidCategory("manager")).toBe(false);
        });
    });

    describe("DEFAULT_CATEGORY", () => {
        it("should be advisor (most restrictive general category)", () => {
            expect(DEFAULT_CATEGORY).toBe("advisor");
        });
    });

    describe("CATEGORY_DENIED_TOOLS", () => {
        it("principal should have no denied tools", () => {
            expect(CATEGORY_DENIED_TOOLS.principal).toEqual([]);
        });

        it("orchestrator should deny fs_write, fs_edit, home_fs_write, shell", () => {
            const denied = CATEGORY_DENIED_TOOLS.orchestrator;
            expect(denied).toContain("fs_write");
            expect(denied).toContain("fs_edit");
            expect(denied).toContain("home_fs_write");
            expect(denied).toContain("shell");
            expect(denied).not.toContain("delegate");
        });

        it("worker should deny delegation tools", () => {
            const denied = CATEGORY_DENIED_TOOLS.worker;
            expect(denied).toContain("delegate");
            expect(denied).toContain("delegate_crossproject");
            expect(denied).toContain("delegate_followup");
            expect(denied).not.toContain("fs_write");
            expect(denied).not.toContain("shell");
        });

        it("advisor should deny mutation and delegation tools", () => {
            const denied = CATEGORY_DENIED_TOOLS.advisor;
            expect(denied).toContain("fs_write");
            expect(denied).toContain("fs_edit");
            expect(denied).toContain("home_fs_write");
            expect(denied).toContain("shell");
            expect(denied).toContain("delegate");
            expect(denied).toContain("delegate_crossproject");
        });

        it("auditor should deny writes and delegation but not shell", () => {
            const denied = CATEGORY_DENIED_TOOLS.auditor;
            expect(denied).toContain("fs_write");
            expect(denied).toContain("fs_edit");
            expect(denied).toContain("home_fs_write");
            expect(denied).toContain("delegate");
            expect(denied).toContain("delegate_crossproject");
            expect(denied).not.toContain("shell");
        });
    });

    describe("filterDeniedTools", () => {
        const allTools = [
            "fs_read",
            "fs_write",
            "fs_edit",
            "fs_glob",
            "fs_grep",
            "home_fs_write",
            "shell",
            "delegate",
            "delegate_crossproject",
            "delegate_followup",
            "ask",
            "search",
            "report_read",
            "report_write",
            "lesson_learn",
        ];

        it("principal: should keep all tools", () => {
            const result = filterDeniedTools(allTools, "principal");
            expect(result).toEqual(allTools);
        });

        it("orchestrator: should remove fs_write, fs_edit, home_fs_write, shell", () => {
            const result = filterDeniedTools(allTools, "orchestrator");
            expect(result).not.toContain("fs_write");
            expect(result).not.toContain("fs_edit");
            expect(result).not.toContain("home_fs_write");
            expect(result).not.toContain("shell");
            // Should keep delegation and read tools
            expect(result).toContain("delegate");
            expect(result).toContain("delegate_crossproject");
            expect(result).toContain("fs_read");
            expect(result).toContain("fs_glob");
        });

        it("worker: should remove delegation tools", () => {
            const result = filterDeniedTools(allTools, "worker");
            expect(result).not.toContain("delegate");
            expect(result).not.toContain("delegate_crossproject");
            expect(result).not.toContain("delegate_followup");
            // Should keep write and shell tools
            expect(result).toContain("fs_write");
            expect(result).toContain("fs_edit");
            expect(result).toContain("shell");
            // Should keep ask (not in denied list)
            expect(result).toContain("ask");
        });

        it("advisor: should remove mutation and delegation tools", () => {
            const result = filterDeniedTools(allTools, "advisor");
            expect(result).not.toContain("fs_write");
            expect(result).not.toContain("fs_edit");
            expect(result).not.toContain("home_fs_write");
            expect(result).not.toContain("shell");
            expect(result).not.toContain("delegate");
            expect(result).not.toContain("delegate_crossproject");
            // Should keep read tools
            expect(result).toContain("fs_read");
            expect(result).toContain("fs_glob");
            expect(result).toContain("fs_grep");
            expect(result).toContain("search");
            // Should keep delegate_followup (not in advisor denied list)
            expect(result).toContain("delegate_followup");
        });

        it("auditor: should remove writes and delegation but keep shell", () => {
            const result = filterDeniedTools(allTools, "auditor");
            expect(result).not.toContain("fs_write");
            expect(result).not.toContain("fs_edit");
            expect(result).not.toContain("home_fs_write");
            expect(result).not.toContain("delegate");
            expect(result).not.toContain("delegate_crossproject");
            // Should keep shell for test execution
            expect(result).toContain("shell");
            // Should keep read tools
            expect(result).toContain("fs_read");
        });

        it("should never filter MCP tools regardless of category", () => {
            const toolsWithMcp = [...allTools, "mcp__tenex__fs_write", "mcp__custom__shell"];
            for (const category of ["orchestrator", "advisor", "auditor", "worker"] as AgentCategory[]) {
                const result = filterDeniedTools(toolsWithMcp, category);
                expect(result).toContain("mcp__tenex__fs_write");
                expect(result).toContain("mcp__custom__shell");
            }
        });

        it("should preserve non-denied tools", () => {
            const result = filterDeniedTools(allTools, "advisor");
            expect(result).toContain("ask");
            expect(result).toContain("search");
            expect(result).toContain("report_read");
            expect(result).toContain("report_write");
            expect(result).toContain("lesson_learn");
        });

        it("should handle empty tool list", () => {
            const result = filterDeniedTools([], "advisor");
            expect(result).toEqual([]);
        });

        it("should not mutate the input array", () => {
            const input = ["fs_read", "fs_write", "shell"];
            const copy = [...input];
            filterDeniedTools(input, "advisor");
            expect(input).toEqual(copy);
        });
    });
});
