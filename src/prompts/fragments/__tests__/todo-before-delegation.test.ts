import { describe, expect, it } from "bun:test";
import { todoBeforeDelegationFragment } from "../17-todo-before-delegation";

describe("todoBeforeDelegationFragment", () => {
    it("should have correct id", () => {
        expect(todoBeforeDelegationFragment.id).toBe("todo-before-delegation");
    });

    it("should have priority 17 (after stay-in-your-lane)", () => {
        expect(todoBeforeDelegationFragment.priority).toBe(17);
    });

    it("should render header for complex/multi-step delegations", () => {
        const result = todoBeforeDelegationFragment.template();

        expect(result).toContain("## Todo List Before Delegation");
        expect(result).toContain("**Establish your todo list BEFORE delegating complex or multi-step tasks.**");
    });

    it("should use generic language for delegation tools", () => {
        const result = todoBeforeDelegationFragment.template();

        // Should NOT mention specific tool names - use generic "delegation tool" language
        expect(result).toContain("Before using any delegation tool");
        expect(result).not.toContain("`delegate()`");
        expect(result).not.toContain("`mcp__tenex__delegate()`");
    });

    it("should include the three key requirements", () => {
        const result = todoBeforeDelegationFragment.template();

        expect(result).toContain("1. **Create your todo list first**");
        expect(result).toContain("2. **Include anticipated delegations**");
        expect(result).toContain("3. **Mark your current task as in_progress**");
    });

    it("should clarify when the requirement applies", () => {
        const result = todoBeforeDelegationFragment.template();

        expect(result).toContain("**When this applies:**");
        expect(result).toContain("Multi-step tasks involving multiple delegations");
        expect(result).toContain("Complex work requiring coordination across agents");
    });

    it("should allow exceptions for simple delegations", () => {
        const result = todoBeforeDelegationFragment.template();

        expect(result).toContain("**When you can skip this:**");
        expect(result).toContain("Simple, single-step delegations");
        expect(result).toContain("Follow-up messages to existing delegations");
    });

    it("should explain why this matters", () => {
        const result = todoBeforeDelegationFragment.template();

        expect(result).toContain("**Why this matters:**");
        expect(result).toContain("Your workflow plan becomes visible to observers and the system");
        expect(result).toContain("It prevents orphaned delegations without context");
        expect(result).toContain("It enables better coordination and status tracking across agents");
    });

    it("should warn about skipping for complex delegations only", () => {
        const result = todoBeforeDelegationFragment.template();

        expect(result).toContain("**Skipping the todo list for complex delegations may result in system warnings.**");
    });
});
