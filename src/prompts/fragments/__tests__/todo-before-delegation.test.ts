import { describe, expect, it } from "bun:test";
import { TodoUsageFragment } from "../17-todo-before-delegation";

describe("TodoUsageFragment", () => {
    it("should have correct id", () => {
        expect(TodoUsageFragment.id).toBe("todo-before-delegation");
    });

    it("should have priority 17 (after delegation-tips)", () => {
        expect(TodoUsageFragment.priority).toBe(17);
    });

    it("should render header for complex/multi-step delegations", () => {
        const result = TodoUsageFragment.template();

        expect(result).toContain("## Todo List");
        expect(result).toContain(
            "When delegating tasks, a todo list helps you track progress and stay organized."
        );
    });

    it("should reference todo_write without naming delegation tools directly", () => {
        const result = TodoUsageFragment.template();

        expect(result).toContain("Use `todo_write()` to outline your workflow plan");
        expect(result).not.toContain("`delegate()`");
        expect(result).not.toContain("`mcp__tenex__delegate()`");
    });

    it("should include the current delegation guidance bullets", () => {
        const result = TodoUsageFragment.template();

        expect(result).toContain(
            "- Use `todo_write()` to outline your workflow plan before or after delegating"
        );
        expect(result).toContain("- Include anticipated delegations so progress is visible");
        expect(result).toContain("- Mark your current task as in_progress when delegating");
    });

    it("should describe workflow planning through todo_write", () => {
        const result = TodoUsageFragment.template();

        expect(result).toContain("Use `todo_write()` to outline your workflow plan");
    });

    it("should require planned delegations to be reflected in the todo list", () => {
        const result = TodoUsageFragment.template();

        expect(result).toContain("Include anticipated delegations so progress is visible");
    });

    it("should require the current task to be marked in progress", () => {
        const result = TodoUsageFragment.template();

        expect(result).toContain("Mark your current task as in_progress when delegating");
    });
});
