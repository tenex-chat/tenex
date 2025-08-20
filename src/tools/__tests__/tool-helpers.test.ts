import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { createMockExecutionContext } from "@/test-utils";
import { createToolDefinition, defineToolParameters } from "../types";

describe("Tool Helper Functions", () => {
  describe("defineToolParameters", () => {
    it("should create parameter schema from zod schema", () => {
      const zodSchema = z.object({
        name: z.string(),
        age: z.number(),
      });

      const paramSchema = defineToolParameters(zodSchema);

      expect(paramSchema.shape).toBeDefined();
      expect(paramSchema.validate).toBeDefined();

      const validResult = paramSchema.validate({ name: "test", age: 25 });
      expect(validResult.ok).toBe(true);
      if (validResult.ok) {
        expect(validResult.value.value).toEqual({ name: "test", age: 25 });
      }

      const invalidResult = paramSchema.validate({ name: "test" });
      expect(invalidResult.ok).toBe(false);
    });

    it("should handle optional fields", () => {
      const schema = z.object({
        required: z.string(),
        optional: z.string().optional(),
      });

      const paramSchema = defineToolParameters(schema);

      const result1 = paramSchema.validate({ required: "value" });
      expect(result1.ok).toBe(true);

      const result2 = paramSchema.validate({ required: "value", optional: "extra" });
      expect(result2.ok).toBe(true);
    });
  });

  describe("createToolDefinition", () => {
    it("should create a complete tool definition", () => {
      const schema = z.object({
        input: z.string(),
      });

      const tool = createToolDefinition({
        name: "testTool",
        description: "A test tool",
        schema,
        promptFragment: "Use this for testing",
        execute: async (input) => {
          return {
            ok: true,
            value: { result: input.value.input },
          };
        },
      });

      expect(tool.name).toBe("testTool");
      expect(tool.description).toBe("A test tool");
      expect(tool.promptFragment).toBe("Use this for testing");
      expect(tool.parameters).toBeDefined();
      expect(tool.execute).toBeDefined();

      // Test parameter validation
      const parseResult = tool.parameters.validate({ input: "test" });
      expect(parseResult.ok).toBe(true);
    });

    it("should work without optional promptFragment", () => {
      const schema = z.object({
        value: z.number(),
      });

      const tool = createToolDefinition({
        name: "simpleTool",
        description: "Simple tool",
        schema,
        execute: async (input) => {
          return {
            ok: true,
            value: input.value.value * 2,
          };
        },
      });

      expect(tool.name).toBe("simpleTool");
      expect(tool.promptFragment).toBeUndefined();
    });

    it("should execute tool function correctly", async () => {
      const schema = z.object({
        multiplier: z.number(),
      });

      const tool = createToolDefinition({
        name: "multiplyTool",
        description: "Multiplies by 10",
        schema,
        execute: async (input) => {
          return {
            ok: true,
            value: input.value.multiplier * 10,
          };
        },
      });

      const mockContext = createMockExecutionContext();
      const validatedInput = { ok: true as const, value: { multiplier: 5 } };
      const result = await tool.execute(validatedInput, mockContext);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(50);
      }
    });

    it("should handle execution errors", async () => {
      const schema = z.object({
        shouldFail: z.boolean(),
      });

      const tool = createToolDefinition({
        name: "errorTool",
        description: "Tool that can fail",
        schema,
        execute: async (input) => {
          if (input.value.shouldFail) {
            return {
              ok: false,
              error: {
                kind: "execution" as const,
                tool: "errorTool",
                message: "Intentional failure",
              },
            };
          }
          return {
            ok: true,
            value: "success",
          };
        },
      });

      const mockContext = createMockExecutionContext();

      const failResult = await tool.execute(
        { ok: true as const, value: { shouldFail: true } },
        mockContext
      );
      expect(failResult.ok).toBe(false);
      if (!failResult.ok) {
        expect(failResult.error.message).toBe("Intentional failure");
      }

      const successResult = await tool.execute(
        { ok: true as const, value: { shouldFail: false } },
        mockContext
      );
      expect(successResult.ok).toBe(true);
    });
  });
});
