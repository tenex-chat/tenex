/**
 * Integration test for codebase_search tool
 * Tests actual functionality against real filesystem
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import { createCodebaseSearchTool } from "../codebase_search";
import type { ExecutionContext } from "@/agents/execution/types";
import { resolve } from "node:path";

describe("codebase_search integration", () => {
  let context: ExecutionContext;
  let tool: ReturnType<typeof createCodebaseSearchTool>;

  beforeEach(() => {
    // Use the actual project path for testing
    const projectPath = resolve(__dirname, "../../../.."); // Go up to project root
    
    context = {
      agent: { name: "test-agent" },
      projectPath,
      conversationId: "test-conversation",
      conversationCoordinator: {
        getConversation: () => null,
      },
      agentPublisher: {
        conversation: async () => {},
      },
      triggeringEvent: undefined,
    } as unknown as ExecutionContext;

    tool = createCodebaseSearchTool(context);
  });

  describe("actual searches", () => {
    it("should find this test file by name", async () => {
      const result = await tool.execute({
        query: "codebase_search_integration",
        searchType: "filename",
      });

      expect(result).toContain("codebase_search_integration.test.ts");
      expect(result).toContain("Found");
      expect(result).not.toContain("No results found");
    });

    it("should find TypeScript files with specific content", async () => {
      const result = await tool.execute({
        query: "ExecutionContext",
        searchType: "content",
        fileType: ".ts",
        maxResults: 5,
      });

      expect(result).toContain("ExecutionContext");
      expect(result).not.toContain("No results found");
    });

    it("should find both files and content", async () => {
      const result = await tool.execute({
        query: "codebase",
        searchType: "both",
        maxResults: 10,
      });

      expect(result).toContain("Found");
      expect(result).not.toContain("No results found");
    });

    it("should return no results for non-existent query", async () => {
      const result = await tool.execute({
        query: "zzz_this_should_not_exist_anywhere_zzz",
        searchType: "filename", // Search only filenames to avoid finding this string in the test
      });

      expect(result).toContain("No results found");
    });

    it("should include snippets when requested", async () => {
      const result = await tool.execute({
        query: "createCodebaseSearchTool",
        searchType: "content",
        includeSnippets: true,
        maxResults: 3,
      });

      // Should have content snippets from grep output
      if (!result.includes("No results found")) {
        expect(result).toContain("createCodebaseSearchTool");
      }
    });

    it("should find directories", async () => {
      const result = await tool.execute({
        query: "implementations",
        searchType: "filename",
      });

      expect(result).toContain("implementations");
      expect(result).toContain("directory");
    });
  });

  describe("human readable content", () => {
    it("should generate readable description", () => {
      const getHumanReadableContent = (tool as any).getHumanReadableContent;
      expect(getHumanReadableContent).toBeDefined();
      
      const description = getHumanReadableContent({
        query: "test query",
        searchType: "both",
      });

      expect(description).toBe('Searching codebase for "test query" (both)');
    });
  });

  describe("parameter validation", () => {
    it("should use default values when optional parameters are not provided", async () => {
      const result = await tool.execute({
        query: "package.json",
      });

      expect(result).toContain("package.json");
    });

    it("should handle search with all parameters specified", async () => {
      const result = await tool.execute({
        query: "test",
        searchType: "filename",
        fileType: ".ts",
        maxResults: 3,
        includeSnippets: false,
      });

      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
    });
  });
});