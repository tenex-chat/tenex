import { describe, expect, it } from "bun:test";
import { createMockExecutionContext } from "@/test-utils";
import { shellTool } from "../shell";

describe("shellTool - simple test", () => {
  it("should have correct metadata", () => {
    expect(shellTool.name).toBe("shell");
    expect(shellTool.description).toBe("Execute shell commands in the project directory");
  });

  it("should have parameters schema", () => {
    expect(shellTool.parameters).toBeDefined();
    expect(shellTool.parameters.validate).toBeDefined();
  });

  it("should validate correct input", () => {
    const result = shellTool.parameters.validate({
      command: "echo test",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.value.command).toBe("echo test");
    }
  });

  it("should reject invalid input", () => {
    const result = shellTool.parameters.validate({
      // Missing required command
    });

    expect(result.ok).toBe(false);
  });

  it("should accept optional parameters", () => {
    const result = shellTool.parameters.validate({
      command: "npm test",
      cwd: "./src",
      timeout: 60000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.value.cwd).toBe("./src");
      expect(result.value.value.timeout).toBe(60000);
    }
  });
});
