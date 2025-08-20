import { beforeEach, describe, expect, it } from "bun:test";
import type { TracingContext } from "../TracingContext";
import { TracingLogger } from "../TracingLogger";

describe("TracingLogger", () => {
  let mockContext: TracingContext;
  let tracingLogger: TracingLogger;

  beforeEach(() => {
    mockContext = {
      conversationId: "conv-123",
      executionId: "exec-456",
      currentAgent: "TestAgent",
      currentPhase: "CHAT",
      currentTool: "testTool",
    };
  });

  describe("initialization", () => {
    it("should create logger with context", () => {
      tracingLogger = new TracingLogger(mockContext);
      expect(tracingLogger).toBeDefined();
    });

    it("should create logger with module", () => {
      tracingLogger = new TracingLogger(mockContext, "agent");
      expect(tracingLogger).toBeDefined();
    });
  });

  describe("forModule", () => {
    it("should create scoped logger for module", () => {
      tracingLogger = new TracingLogger(mockContext);
      const moduleLogger = tracingLogger.forModule("agent");
      expect(moduleLogger).toBeDefined();
      expect(moduleLogger).toBeInstanceOf(TracingLogger);
    });
  });

  describe("withContext", () => {
    it("should create new logger with updated context", () => {
      tracingLogger = new TracingLogger(mockContext);
      const newContext: TracingContext = {
        conversationId: "new-conv",
        executionId: "new-exec",
      };

      const newLogger = tracingLogger.withContext(newContext);
      expect(newLogger).toBeDefined();
      expect(newLogger).toBeInstanceOf(TracingLogger);
      expect(newLogger).not.toBe(tracingLogger);
    });
  });

  describe("logging methods", () => {
    beforeEach(() => {
      tracingLogger = new TracingLogger(mockContext);
    });

    it("should have info method", () => {
      expect(() => tracingLogger.info("Test message")).not.toThrow();
    });

    it("should have success method", () => {
      expect(() => tracingLogger.success("Success message")).not.toThrow();
    });

    it("should have warning method", () => {
      expect(() => tracingLogger.warning("Warning message")).not.toThrow();
    });

    it("should have error method", () => {
      expect(() => tracingLogger.error("Error message")).not.toThrow();
      expect(() => tracingLogger.error("Error with object", new Error("test"))).not.toThrow();
      expect(() =>
        tracingLogger.error("Error with context", new Error("test"), { code: "ERR_001" })
      ).not.toThrow();
    });

    it("should have debug method", () => {
      expect(() => tracingLogger.debug("Debug message")).not.toThrow();
    });

    it("should have startOperation method", () => {
      expect(() => tracingLogger.startOperation("test operation")).not.toThrow();
      expect(() => tracingLogger.startOperation("test operation", { extra: "data" })).not.toThrow();
    });
  });

  describe("method signatures", () => {
    beforeEach(() => {
      tracingLogger = new TracingLogger(mockContext);
    });

    it("should accept additional context in info", () => {
      expect(() => tracingLogger.info("Test", { extra: "data" })).not.toThrow();
    });

    it("should accept additional context in success", () => {
      expect(() => tracingLogger.success("Test", { extra: "data" })).not.toThrow();
    });

    it("should accept additional context in warning", () => {
      expect(() => tracingLogger.warning("Test", { extra: "data" })).not.toThrow();
    });

    it("should accept additional context in debug", () => {
      expect(() => tracingLogger.debug("Test", { extra: "data" })).not.toThrow();
    });
  });

  describe("edge cases", () => {
    it("should handle minimal context", () => {
      const minimalContext: TracingContext = {
        conversationId: "conv-123",
        executionId: "exec-456",
      };

      const logger = new TracingLogger(minimalContext);
      expect(() => logger.info("Test")).not.toThrow();
    });

    it("should handle undefined additional context", () => {
      tracingLogger = new TracingLogger(mockContext);
      expect(() => tracingLogger.info("Test", undefined)).not.toThrow();
    });

    it("should handle empty additional context", () => {
      tracingLogger = new TracingLogger(mockContext);
      expect(() => tracingLogger.info("Test", {})).not.toThrow();
    });
  });
});
