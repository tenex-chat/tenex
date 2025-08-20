import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { completeTool } from "../complete";

describe("complete tool", () => {
  describe("metadata", () => {
    it("should have correct tool name", () => {
      expect(completeTool.name).toBe("complete");
    });

    it("should have descriptive documentation", () => {
      expect(completeTool.description).toContain("Signal task completion");
      expect(completeTool.description).toContain("delegating agent");
    });

    it("should have helpful prompt fragment", () => {
      expect(completeTool.promptFragment).toContain("CRITICAL USAGE INSTRUCTIONS");
      expect(completeTool.promptFragment).toContain("WHEN TO USE");
      expect(completeTool.promptFragment).toContain("REMEMBER");
    });
  });

  describe("schema validation", () => {
    it("should define correct parameter schema", () => {
      expect(completeTool.parameters).toBeDefined();
      expect(completeTool.parameters.shape).toBeDefined();
      expect(completeTool.parameters.shape.properties).toBeDefined();
      expect(completeTool.parameters.shape.properties.response).toBeDefined();
      expect(completeTool.parameters.shape.properties.summary).toBeDefined();
    });

    it("should require response field", () => {
      const result = completeTool.parameters.validate({});

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.field).toBe("response");
        expect(result.error.message).toContain("Required");
      }
    });

    it("should accept valid input with response only", () => {
      const result = completeTool.parameters.validate({
        response: "Task completed successfully",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value.response).toBe("Task completed successfully");
        expect(result.value.value.summary).toBeUndefined();
      }
    });

    it("should accept valid input with both response and summary", () => {
      const result = completeTool.parameters.validate({
        response: "Task completed with detailed results",
        summary: "Brief summary for orchestrator",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value.response).toBe("Task completed with detailed results");
        expect(result.value.value.summary).toBe("Brief summary for orchestrator");
      }
    });

    it("should reject invalid types", () => {
      const result = completeTool.parameters.validate({
        response: 123, // number instead of string
        summary: true, // boolean instead of string
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.field).toBe("response");
        expect(result.error.message).toContain("Expected string");
      }
    });

    it("should handle empty string response", () => {
      const result = completeTool.parameters.validate({
        response: "",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value.response).toBe("");
      }
    });
  });

  describe("parameter descriptions", () => {
    it("should have descriptive parameter fields", () => {
      // Access the schema shape to verify descriptions
      const shape = completeTool.parameters.shape;
      expect(shape.type).toBe("object");
      expect(shape.properties.response.description).toBeDefined();
      expect(shape.properties.response.type).toBe("string");
      expect(shape.properties.summary.description).toBeDefined();
      expect(shape.properties.summary.type).toBe("string");

      // Verify required fields
      expect(shape.required).toContain("response");
      expect(shape.required).not.toContain("summary");
    });
  });
});
