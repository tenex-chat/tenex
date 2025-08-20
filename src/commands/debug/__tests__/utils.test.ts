import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import chalk from "chalk";
import { debugError, debugInfo, debugLog, debugPrompt, debugSection } from "../utils";

describe("Debug Utils", () => {
  let originalConsoleLog: typeof console.log;
  let originalConsoleError: typeof console.error;
  let originalStdoutWrite: typeof process.stdout.write;
  let consoleLogs: unknown[][];
  let consoleErrors: unknown[][];
  let stdoutWrites: unknown[];

  beforeEach(() => {
    // Save original console methods
    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    originalStdoutWrite = process.stdout.write;

    // Reset tracking arrays
    consoleLogs = [];
    consoleErrors = [];
    stdoutWrites = [];

    // Mock console methods
    console.log = mock((...args: unknown[]) => {
      consoleLogs.push(args);
    });
    console.error = mock((...args: unknown[]) => {
      consoleErrors.push(args);
    });
    process.stdout.write = mock((data: unknown) => {
      stdoutWrites.push(data);
      return true;
    }) as any;

    // Clear environment variables
    process.env.DEBUG = undefined;
    process.env.TENEX_DEBUG = undefined;
  });

  afterEach(() => {
    // Restore original methods
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    process.stdout.write = originalStdoutWrite;
  });

  describe("debugLog", () => {
    it("should log to console in normal mode", () => {
      debugLog("Test message", "arg1", "arg2");
      expect(consoleLogs).toHaveLength(1);
      expect(consoleLogs[0]).toEqual(["Test message", "arg1", "arg2"]);
    });

    it("should use logDebug when DEBUG env is set", () => {
      process.env.DEBUG = "true";
      debugLog("Test message");
      // In debug mode, it would use logDebug which has specific formatting
      expect(consoleLogs).toHaveLength(0); // No direct console.log in debug mode
    });
  });

  describe("debugError", () => {
    it("should format error message correctly", () => {
      const error = new Error("Test error");
      debugError("Error occurred:", error);
      expect(consoleErrors).toHaveLength(1);
      expect(consoleErrors[0][0]).toContain("Error occurred:");
      expect(consoleErrors[0][1]).toBe("Test error");
    });

    it("should handle non-Error objects", () => {
      debugError("Error occurred:", "string error");
      expect(consoleErrors).toHaveLength(1);
      expect(consoleErrors[0][1]).toBe("string error");
    });

    it("should handle undefined error", () => {
      debugError("Error occurred:");
      expect(consoleErrors).toHaveLength(1);
      expect(consoleErrors[0][1]).toBe("undefined");
    });
  });

  describe("debugInfo", () => {
    it("should log with cyan color", () => {
      debugInfo("Info message");
      expect(consoleLogs).toHaveLength(1);
      expect(consoleLogs[0][0]).toBe(chalk.cyan("Info message"));
    });
  });

  describe("debugSection", () => {
    it("should format section header without content", () => {
      debugSection("Test Section");
      expect(consoleLogs).toHaveLength(2);
      expect(consoleLogs[0][0]).toBe(chalk.cyan("\n=== Test Section ==="));
      expect(consoleLogs[1][0]).toBe(chalk.cyan(`${"=".repeat(20)}\n`));
    });

    it("should format section header with content", () => {
      debugSection("Test Section", "Section content");
      expect(consoleLogs).toHaveLength(3);
      expect(consoleLogs[0][0]).toBe(chalk.cyan("\n=== Test Section ==="));
      expect(consoleLogs[1][0]).toBe("Section content");
      expect(consoleLogs[2][0]).toBe(chalk.cyan(`${"=".repeat(20)}\n`));
    });
  });

  describe("debugPrompt", () => {
    it("should write to stdout in normal mode", () => {
      debugPrompt("Enter value: ");
      expect(stdoutWrites).toHaveLength(1);
      expect(stdoutWrites[0]).toBe(chalk.blue("Enter value: "));
    });
  });
});
