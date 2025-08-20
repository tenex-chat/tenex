import { describe, expect, it } from "bun:test";
import { completeTool } from "../implementations/complete";
import { readPathTool } from "../implementations/readPath";
import { shellTool } from "../implementations/shell";
import { getAllTools, getTool, getTools, type ToolName } from "../registry";

describe("Tool Registry", () => {
  describe("getTool", () => {
    it("should return tool when exists", () => {
      const tool = getTool("read_path");
      expect(tool).toBeDefined();
      expect(tool).toBe(readPathTool);
    });

    it("should return undefined for non-existent tool", () => {
      // @ts-expect-error Testing invalid tool name
      const tool = getTool("non_existent_tool" as ToolName);
      expect(tool).toBeUndefined();
    });

    it("should handle empty string", () => {
      // @ts-expect-error Testing invalid tool name
      const tool = getTool("" as ToolName);
      expect(tool).toBeUndefined();
    });
  });

  describe("getTools", () => {
    it("should return array of existing tools", () => {
      const tools = getTools(["read_path", "complete", "shell"]);
      expect(tools).toHaveLength(3);
      expect(tools[0]).toBe(readPathTool);
      expect(tools[1]).toBe(completeTool);
      expect(tools[2]).toBe(shellTool);
    });

    it("should filter out non-existent tools", () => {
      // @ts-expect-error Testing with invalid tool name
      const tools = getTools(["read_path", "non_existent" as ToolName, "complete"]);
      expect(tools).toHaveLength(2);
      expect(tools[0]).toBe(readPathTool);
      expect(tools[1]).toBe(completeTool);
    });

    it("should return empty array for all non-existent tools", () => {
      // @ts-expect-error Testing with invalid tool names
      const tools = getTools(["non_existent1" as ToolName, "non_existent2" as ToolName]);
      expect(tools).toHaveLength(0);
    });

    it("should handle empty array input", () => {
      const tools = getTools([]);
      expect(tools).toHaveLength(0);
    });
  });

  describe("getAllTools", () => {
    it("should return array of all tools", () => {
      const tools = getAllTools();
      expect(tools).toBeDefined();
      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBeGreaterThan(0);
    });

    it("should include known tools", () => {
      const tools = getAllTools();
      const toolNames = tools.map((t) => t.name);

      expect(toolNames).toContain("read_path");
      expect(toolNames).toContain("complete");
      expect(toolNames).toContain("shell");
      expect(toolNames).toContain("analyze");
      expect(toolNames).toContain("generate_inventory");
    });

    it("should return tools with required properties", () => {
      const tools = getAllTools();

      for (const tool of tools) {
        expect(tool).toHaveProperty("name");
        expect(tool).toHaveProperty("description");
        expect(tool).toHaveProperty("parameters");
        expect(tool).toHaveProperty("execute");
        expect(typeof tool.name).toBe("string");
        expect(typeof tool.description).toBe("string");
        expect(typeof tool.execute).toBe("function");
      }
    });
  });
});
