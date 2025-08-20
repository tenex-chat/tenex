import { describe, expect, it } from "bun:test";
import type { Result, Tool } from "../core";

describe("Core Tool Types", () => {
  describe("Result Type", () => {
    it("should handle success results", () => {
      const successResult: Result<string, number> = {
        ok: true,
        value: 42,
      };

      expect(successResult.ok).toBe(true);
      if (successResult.ok) {
        expect(successResult.value).toBe(42);
      }
    });

    it("should handle error results", () => {
      const errorResult: Result<string, number> = {
        ok: false,
        error: "Something went wrong",
      };

      expect(errorResult.ok).toBe(false);
      if (!errorResult.ok) {
        expect(errorResult.error).toBe("Something went wrong");
      }
    });

    it("should handle results with metadata", () => {
      const resultWithMetadata: Result<string, number> = {
        ok: true,
        value: 42,
        metadata: {
          startTime: Date.now(),
          endTime: Date.now() + 1000,
          toolName: "test-tool",
          success: true,
        },
      };

      expect(resultWithMetadata.ok).toBe(true);
      if (resultWithMetadata.ok) {
        expect(resultWithMetadata.metadata).toBeDefined();
        expect(resultWithMetadata.metadata?.toolName).toBe("test-tool");
      }
    });
  });

  describe("Tool Interface", () => {
    it("should define a tool structure correctly", () => {
      const mockTool: Partial<Tool<{ input: string }, { output: string }>> = {
        name: "test-tool",
        description: "A test tool",
        promptFragment: "Use this tool for testing",
      };

      expect(mockTool.name).toBe("test-tool");
      expect(mockTool.description).toBe("A test tool");
      expect(mockTool.promptFragment).toBe("Use this tool for testing");
    });
  });
});
