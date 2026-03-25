import { describe, expect, it } from "bun:test";
import { createMockExecutionEnvironment } from "@/test-utils";
import { createLessonDeleteTool } from "../lesson_delete";
import { createLessonGetTool } from "../lesson_get";

describe("lesson tool schemas", () => {
    const mockContext = createMockExecutionEnvironment();

    it("documents supported lesson ID formats for lesson_get", () => {
        const tool = createLessonGetTool(mockContext);
        expect(tool.inputSchema.shape.eventId.description).toContain("12-char hex prefix");
        expect(tool.inputSchema.shape.eventId.description).toContain("note1.../nevent1...");
    });

    it("documents supported lesson ID formats for lesson_delete", () => {
        const tool = createLessonDeleteTool(mockContext);
        expect(tool.inputSchema.shape.eventId.description).toContain("12-char hex prefix");
        expect(tool.inputSchema.shape.eventId.description).toContain("note1.../nevent1...");
    });
});
