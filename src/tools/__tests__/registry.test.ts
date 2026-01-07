import { describe, expect, it } from "bun:test";
import { createMockExecutionEnvironment } from "@/test-utils";
import type { ToolName } from "../types";
import { getAllTools, getTool, getTools } from "../registry";

describe("Tool Registry", () => {
    const mockContext = createMockExecutionEnvironment();

    describe("getTool", () => {
        it("should return tool when exists", () => {
            const tool = getTool("fs_read", mockContext);
            expect(tool).toBeDefined();
            expect(tool?.description).toContain("Read a file or directory");
        });

        it("should return undefined for non-existent tool", () => {
            // @ts-expect-error Testing invalid tool name
            const tool = getTool("non_existent_tool" as ToolName, mockContext);
            expect(tool).toBeUndefined();
        });

        it("should handle empty string", () => {
            // @ts-expect-error Testing invalid tool name
            const tool = getTool("" as ToolName, mockContext);
            expect(tool).toBeUndefined();
        });
    });

    describe("getTools", () => {
        it("should return array of existing tools", () => {
            const tools = getTools(["fs_read", "shell"], mockContext);
            expect(tools).toHaveLength(2);
        });

        it("should filter out non-existent tools", () => {
            // @ts-expect-error Testing with invalid tool name
            const tools = getTools(["fs_read", "non_existent" as ToolName, "shell"], mockContext);
            expect(tools).toHaveLength(2);
        });

        it("should return empty array for all non-existent tools", () => {
            // @ts-expect-error Testing with invalid tool names
            const tools = getTools(["non_existent1" as ToolName, "non_existent2" as ToolName], mockContext);
            expect(tools).toHaveLength(0);
        });

        it("should handle empty array input", () => {
            const tools = getTools([], mockContext);
            expect(tools).toHaveLength(0);
        });
    });

    describe("getAllTools", () => {
        it("should return array of all tools", () => {
            const tools = getAllTools(mockContext);
            expect(tools).toBeDefined();
            expect(Array.isArray(tools)).toBe(true);
            expect(tools.length).toBeGreaterThan(0);
        });

        it("should include known tools", () => {
            const tools = getAllTools(mockContext);
            const toolDescriptions = tools.map((t) => t.description);

            expect(toolDescriptions.some(d => d.includes("Read a file or directory"))).toBe(true);
            expect(toolDescriptions.some(d => d.includes("shell") || d.includes("command"))).toBe(true);
            expect(toolDescriptions.some(d => d.includes("delegate"))).toBe(true);
        });

        it("should return tools with required AI SDK properties", () => {
            const tools = getAllTools(mockContext);

            for (const tool of tools) {
                expect(tool).toHaveProperty("description");
                expect(tool).toHaveProperty("execute");
                expect(typeof tool.description).toBe("string");
                expect(typeof tool.execute).toBe("function");
                // AI SDK tools have parameters in their schema
                expect(tool.parameters || tool.inputSchema).toBeDefined();
            }
        });
    });
});
