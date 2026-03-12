import { describe, expect, it } from "bun:test";
import { TodoUsageFragment } from "../17-todo-before-delegation";

describe("TodoUsageFragment", () => {
    it("should have correct id", () => {
        expect(TodoUsageFragment.id).toBe("todo-before-delegation");
    });

    it("should have priority 17 (after stay-in-your-lane)", () => {
        expect(TodoUsageFragment.priority).toBe(17);
    });

    it("should render header for complex/multi-step delegations", () => {
        const result = TodoUsageFragment.template();

        expect(result).toContain("## Todo List");
        expect(result).toContain("**Establish your todo list BEFORE delegating complex or multi-step tasks.**");
    });

    it("should use generic language for delegation tools", () => {
        const result = TodoUsageFragment.template();

        // Should NOT mention specific tool names - use generic "delegation tool" language
        expect(result).toContain("Before using any delegation tool");
        expect(result).not.toContain("`delegate()`");
        expect(result).not.toContain("`mcp__tenex__delegate()`");
    });

    it("should include the three key requirements", () => {
        const result = TodoUsageFragment.template();

        expect(result).toContain("1. **Create your todo list first**");
        expect(result).toContain("2. **Include anticipated delegations**");
        expect(result).toContain("3. **Mark your current task as in_progress**");
    });

    it("should describe how to form the initial workflow plan", () => {
        const result = TodoUsageFragment.template();

        expect(result).toContain("Use `todo_write()` to outline your workflow plan");
        expect(result).toContain("write in the todo list the decisions that will be needed to be made to establish the workflow");
    });

    it("should require planned delegations to be reflected in the todo list", () => {
        const result = TodoUsageFragment.template();

        expect(result).toContain("Your todo list should reflect the work you plan to delegate");
    });

    it("should require the current task to be marked in progress", () => {
        const result = TodoUsageFragment.template();

        expect(result).toContain("Show what you're working on when delegating");
    });

    it("should warn about skipping for complex delegations only", () => {
        const result = TodoUsageFragment.template();

        expect(result).toContain("**Skipping the todo list for complex delegations may result in system warnings.**");
    });
});
