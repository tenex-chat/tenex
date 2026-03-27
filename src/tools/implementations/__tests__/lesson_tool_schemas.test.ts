import { describe, expect, it } from "bun:test";
import { createMockExecutionEnvironment } from "@/test-utils";
import { createLessonDeleteTool } from "../lesson_delete";
import { createLessonGetTool } from "../lesson_get";

describe("lesson tool schemas", () => {
    const mockContext = createMockExecutionEnvironment();

    it("has concise event ID descriptions for lesson_get", () => {
        const tool = createLessonGetTool(mockContext);
        expect(tool.inputSchema.shape.eventId.description).toBe(
            "The event ID of the lesson to retrieve."
        );
    });

    it("has concise event ID descriptions for lesson_delete", () => {
        const tool = createLessonDeleteTool(mockContext);
        expect(tool.inputSchema.shape.eventId.description).toBe(
            "The event ID of the lesson to delete."
        );
    });
});
