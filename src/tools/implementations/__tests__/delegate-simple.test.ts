import { describe, expect, it, mock } from "bun:test";
import type { ToolContext } from "../../types";
import { delegateTool } from "../delegate";

describe("delegateTool", () => {
    it("should have correct metadata", () => {
        expect(delegateTool.name).toBe("delegate");
        expect(delegateTool.description).toBe(
            "Delegate a task or question to one or more agents and wait for their responses"
        );
        expect(delegateTool.promptFragment).toContain("DELEGATE TOOL");
        expect(delegateTool.promptFragment).toContain("will wait for all responses");
    });

    it("should accept single recipient in array", () => {
        const schema = delegateTool.parameters;
        expect(schema).toBeDefined();
        expect(schema.shape).toBeDefined();

        // Validate single recipient in array
        const validated = schema.validate({
            recipients: ["architect"],
            fullRequest: "Design a database schema",
        });

        expect(validated.ok).toBe(true);
        if (validated.ok) {
            expect(validated.value.value).toEqual({
                recipients: ["architect"],
                fullRequest: "Design a database schema",
            });
        }
    });

    it("should accept multiple recipients", () => {
        const schema = delegateTool.parameters;

        // Validate array of recipients
        const validated = schema.validate({
            recipients: ["architect", "planner", "npub1abc"],
            fullRequest: "Collaborate on this feature",
        });

        expect(validated.ok).toBe(true);
        if (validated.ok) {
            expect(validated.value.value).toEqual({
                recipients: ["architect", "planner", "npub1abc"],
                fullRequest: "Collaborate on this feature",
            });
        }
    });

    it("should validate required parameters", () => {
        const schema = delegateTool.parameters;

        // Missing recipients
        const result1 = schema.validate({
            fullRequest: "Do something",
        });
        expect(result1.ok).toBe(false);

        // Missing fullRequest
        const result2 = schema.validate({
            recipients: ["architect"],
        });
        expect(result2.ok).toBe(false);

        // Empty object
        const result3 = schema.validate({});
        expect(result3.ok).toBe(false);
    });

    it("should handle empty arrays", () => {
        const schema = delegateTool.parameters;

        // Empty array should be valid structurally (will fail in execution)
        const validated = schema.validate({
            recipients: [],
            fullRequest: "Test message",
        });

        expect(validated.ok).toBe(true);
        if (validated.ok) {
            expect(validated.value.value.recipients).toEqual([]);
        }
    });

    // Note: Self-delegation prevention is tested in integration tests
    // as it requires mocking the agent resolution which is not easily testable in unit tests
});
