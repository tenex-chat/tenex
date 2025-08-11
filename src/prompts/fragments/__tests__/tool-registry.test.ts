import { describe, test, expect } from "bun:test";
import { getTool } from "@/tools/registry";

describe("Tool Registry", () => {
    test("should have tools with structured parameters", () => {
        // Test that the tool registry has proper structure
        const readPathTool = getTool("read_path");
        expect(readPathTool).toBeDefined();
        expect(readPathTool?.description).toContain("Read a file or directory from the filesystem");
        expect(readPathTool?.parameters).toBeDefined();
        expect(readPathTool?.parameters.shape).toBeDefined();
        expect(readPathTool?.parameters.validate).toBeInstanceOf(Function);
        expect(readPathTool?.execute).toBeInstanceOf(Function);

        const analyzeTool = getTool("analyze");
        expect(analyzeTool).toBeDefined();
        expect(analyzeTool?.description).toBeDefined();
        expect(analyzeTool?.parameters).toBeDefined();
        expect(analyzeTool?.parameters.shape).toBeDefined();

        const writeContextFileTool = getTool("write_context_file");
        expect(writeContextFileTool).toBeDefined();
        expect(writeContextFileTool?.description).toBeDefined();
        expect(writeContextFileTool?.parameters).toBeDefined();
        expect(writeContextFileTool?.parameters.shape).toBeDefined();

        const completeTool = getTool("complete");
        expect(completeTool).toBeDefined();
        expect(completeTool?.description).toBeDefined();
        expect(completeTool?.parameters).toBeDefined();
    });

    test("tool registry should have all expected tools with proper structure", () => {
        const expectedTools = [
            "read_path",
            "write_context_file",
            "complete",
            "analyze",
            "generate_inventory",
            "learn",
        ];

        for (const toolName of expectedTools) {
            const tool = getTool(toolName);
            expect(tool).toBeDefined();
            expect(tool?.name).toBe(toolName);
            expect(tool?.description).toBeDefined();
            expect(tool?.description.length).toBeGreaterThan(0);
            expect(tool?.parameters).toBeDefined();
            expect(tool?.parameters.shape).toBeDefined();
            expect(tool?.parameters.validate).toBeInstanceOf(Function);
            expect(tool?.execute).toBeInstanceOf(Function);
        }
    });

    test("tool parameters should have proper validation", () => {
        const completeTool = getTool("complete");
        expect(completeTool?.parameters).toBeDefined();
        expect(completeTool?.parameters.shape).toBeDefined();

        // The shape for a ZodObject has type "object" and properties
        expect(completeTool?.parameters.shape.type).toBe("object");
        expect(completeTool?.parameters.shape.properties).toBeDefined();
        expect(completeTool?.parameters.shape.properties?.response).toBeDefined();

        // Test validation
        const result = completeTool?.parameters.validate({
            response: "Test response",
        });
        expect(result?.ok).toBe(true);

        const invalidResult = completeTool?.parameters.validate({
            invalidField: "test",
        });
        expect(invalidResult?.ok).toBe(false);
    });
});
