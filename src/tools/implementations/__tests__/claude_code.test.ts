import { describe, expect, it } from "bun:test";
import { claudeCode } from "../claude_code";

describe("claude_code tool - simple test", () => {
  it("should have correct metadata", () => {
    expect(claudeCode.name).toBe("claude_code");
    expect(claudeCode.description).toContain("Execute Claude Code");
    expect(claudeCode.description).toContain("complex analysis tasks");
  });

  it("should have parameters schema", () => {
    expect(claudeCode.parameters).toBeDefined();
    expect(claudeCode.parameters.validate).toBeDefined();
  });

  it("should validate correct input with all parameters", () => {
    const result = claudeCode.parameters.validate({
      prompt: "Write a function to calculate fibonacci",
      systemPrompt: "You are a helpful coding assistant",
      title: "Fibonacci Calculator",
      branch: "feature/fibonacci",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.value.prompt).toBe("Write a function to calculate fibonacci");
      expect(result.value.value.systemPrompt).toBe("You are a helpful coding assistant");
      expect(result.value.value.title).toBe("Fibonacci Calculator");
      expect(result.value.value.branch).toBe("feature/fibonacci");
    }
  });

  it("should validate input with only required parameters", () => {
    const result = claudeCode.parameters.validate({
      prompt: "Create a hello world function",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.value.prompt).toBe("Create a hello world function");
      expect(result.value.value.systemPrompt).toBeUndefined();
      expect(result.value.value.title).toBeUndefined();
      expect(result.value.value.branch).toBeUndefined();
    }
  });

  it("should reject input without prompt", () => {
    const result = claudeCode.parameters.validate({
      systemPrompt: "You are helpful",
      title: "Some title",
    });

    expect(result.ok).toBe(false);
  });

  it("should reject empty prompt", () => {
    const result = claudeCode.parameters.validate({
      prompt: "",
    });

    expect(result.ok).toBe(false);
  });

  it("should have execute function", () => {
    expect(claudeCode.execute).toBeDefined();
    expect(typeof claudeCode.execute).toBe("function");
  });
});
