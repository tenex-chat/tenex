import { beforeEach, describe, expect, it, mock } from "bun:test";
import { createMockExecutionContext } from "@/test-utils";
import type { Tool } from "../core";
import { ToolExecutor, createToolExecutor } from "../executor";
import type { ExecutionContext } from "../types";

describe("ToolExecutor", () => {
  let context: ExecutionContext;
  let executor: ToolExecutor;

  beforeEach(() => {
    context = createMockExecutionContext();
    executor = new ToolExecutor(context);
  });

  describe("execute", () => {
    it("should execute a tool successfully with valid input", async () => {
      const mockTool: Tool<{ message: string }, string> = {
        name: "test_tool",
        description: "Test tool",
        parameters: {
          validate: (input: unknown) => ({
            ok: true,
            value: {
              _brand: "validated" as const,
              value: input as { message: string },
            },
          }),
        },
        execute: async (input) => ({
          ok: true,
          value: `Executed: ${input.value.message}`,
        }),
      };

      const result = await executor.execute(mockTool, { message: "test" });

      expect(result.success).toBe(true);
      expect(result.output).toBe("Executed: test");
      expect(result.error).toBeUndefined();
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it("should handle validation failure", async () => {
      const mockTool: Tool<{ message: string }, string> = {
        name: "test_tool",
        description: "Test tool",
        parameters: {
          validate: () => ({
            ok: false,
            error: {
              kind: "validation" as const,
              message: "Invalid input",
              field: "message",
            },
          }),
        },
        execute: async () => ({
          ok: true,
          value: "Should not reach here",
        }),
      };

      const result = await executor.execute(mockTool, {});

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.kind).toBe("validation");
      expect(result.error?.message).toBe("Invalid input");
      expect(result.output).toBeUndefined();
    });

    it("should handle tool execution failure", async () => {
      const mockTool: Tool<{ message: string }, string> = {
        name: "test_tool",
        description: "Test tool",
        parameters: {
          validate: (input: unknown) => ({
            ok: true,
            value: {
              _brand: "validated" as const,
              value: input as { message: string },
            },
          }),
        },
        execute: async () => ({
          ok: false,
          error: {
            kind: "execution" as const,
            message: "Execution failed",
            tool: "test_tool",
          },
        }),
      };

      const result = await executor.execute(mockTool, { message: "test" });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.kind).toBe("execution");
      expect(result.error?.message).toBe("Execution failed");
    });

    it("should handle unexpected errors during execution", async () => {
      const mockTool: Tool<{ message: string }, string> = {
        name: "test_tool",
        description: "Test tool",
        parameters: {
          validate: (input: unknown) => ({
            ok: true,
            value: {
              _brand: "validated" as const,
              value: input as { message: string },
            },
          }),
        },
        execute: async () => {
          throw new Error("Unexpected error");
        },
      };

      const result = await executor.execute(mockTool, { message: "test" });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.kind).toBe("system");
      expect(result.error?.message).toBe("Unexpected error");
    });

    it("should skip validation for generate_inventory tool", async () => {
      const mockTool: Tool<any, string> = {
        name: "generate_inventory",
        description: "Generate inventory tool",
        parameters: {
          validate: () => ({
            ok: false,
            error: {
              kind: "validation" as const,
              message: "Should not validate",
            },
          }),
        },
        execute: async () => ({
          ok: true,
          value: "Inventory generated",
        }),
      };

      const result = await executor.execute(mockTool, { any: "input" });

      expect(result.success).toBe(true);
      expect(result.output).toBe("Inventory generated");
    });

    it("should pass through metadata from tool execution", async () => {
      const mockTool: Tool<{ message: string }, string> = {
        name: "test_tool",
        description: "Test tool",
        parameters: {
          validate: (input: unknown) => ({
            ok: true,
            value: {
              _brand: "validated" as const,
              value: input as { message: string },
            },
          }),
        },
        execute: async () => ({
          ok: true,
          value: "Success",
          metadata: {
            displayMessage: "Tool executed successfully",
            executedArgs: { message: "test" },
          },
        }),
      };

      const result = await executor.execute(mockTool, { message: "test" });

      expect(result.success).toBe(true);
      expect(result.metadata).toBeDefined();
      expect(result.metadata?.displayMessage).toBe("Tool executed successfully");
      expect(result.metadata?.executedArgs).toEqual({ message: "test" });
    });
  });

  describe("createToolExecutor", () => {
    it("should create a ToolExecutor instance", () => {
      const executor = createToolExecutor(context);
      expect(executor).toBeInstanceOf(ToolExecutor);
    });
  });
});
