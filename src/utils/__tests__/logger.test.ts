import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  AgentLogger,
  configureLogger,
  logDebug,
  logError,
  logger,
  logInfo,
  logSuccess,
  logWarning,
  parseModuleVerbosity,
  ScopedLogger,
} from "../logger";

describe("Logger", () => {
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;
  let consoleWarnSpy: ReturnType<typeof spyOn>;
  const originalEnv = process.env;

  beforeEach(() => {
    consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
    consoleWarnSpy = spyOn(console, "warn").mockImplementation(() => {});
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    process.env = originalEnv;
    configureLogger({ moduleVerbosity: parseModuleVerbosity() });
  });

  describe("parseModuleVerbosity", () => {
    it("should parse LOG_LEVEL environment variable", () => {
      process.env.LOG_LEVEL = "debug";
      const config = parseModuleVerbosity();
      expect(config.default).toBe("debug");
    });

    it("should parse TENEX_LOG environment variable with levels", () => {
      process.env.TENEX_LOG = "agent:verbose,llm:debug,tools:silent";
      const config = parseModuleVerbosity();
      expect(config.modules?.agent).toBe("verbose");
      expect(config.modules?.llm).toBe("debug");
      expect(config.modules?.tools).toBe("silent");
    });

    it("should default to debug when no level specified in TENEX_LOG", () => {
      process.env.TENEX_LOG = "agent,llm";
      const config = parseModuleVerbosity();
      expect(config.modules?.agent).toBe("debug");
      expect(config.modules?.llm).toBe("debug");
    });

    it("should handle malformed module specs gracefully", () => {
      process.env.TENEX_LOG = "agent:verbose,,llm:invalid,tools";
      const config = parseModuleVerbosity();
      expect(config.modules?.agent).toBe("verbose");
      expect(config.modules?.llm).toBeUndefined();
      expect(config.modules?.tools).toBe("debug");
    });
  });

  describe("configureLogger", () => {
    it("should update global configuration", () => {
      configureLogger({ useEmoji: false, useLabels: true });
      logInfo("test message");
      expect(consoleLogSpy).toHaveBeenCalled();
      const call = consoleLogSpy.mock.calls[0];
      expect(call[0]).toContain("[INFO]");
      expect(call[0]).not.toContain("ℹ️");
    });
  });

  describe("log functions", () => {
    it("should log info messages at normal verbosity", () => {
      logInfo("info message");
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    });

    it("should not log info messages when below required verbosity", () => {
      configureLogger({ moduleVerbosity: { default: "silent" } });
      logInfo("info message", undefined, "normal");
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it("should always log errors regardless of verbosity", () => {
      configureLogger({ moduleVerbosity: { default: "silent" } });
      logError("error message");
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    });

    it("should always log warnings", () => {
      configureLogger({ moduleVerbosity: { default: "silent" } });
      logWarning("warning message");
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    });

    it("should respect debug flag for debug messages", () => {
      configureLogger({ debugEnabled: false, moduleVerbosity: { default: "debug" } });
      logDebug("debug message");
      expect(consoleLogSpy).not.toHaveBeenCalled();

      configureLogger({ debugEnabled: true, moduleVerbosity: { default: "debug" } });
      logDebug("debug message");
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    });

    it("should log success messages", () => {
      logSuccess("success message");
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("AgentLogger", () => {
    it("should create logger with agent name", () => {
      const agentLogger = new AgentLogger("test-agent");
      agentLogger.info("test message");
      expect(consoleLogSpy).toHaveBeenCalled();
      const call = consoleLogSpy.mock.calls[0];
      expect(call[0]).toContain("[test-agent]");
    });

    it("should include project name when provided", () => {
      const agentLogger = new AgentLogger("test-agent", "test-project");
      agentLogger.info("test message");
      expect(consoleLogSpy).toHaveBeenCalled();
      const call = consoleLogSpy.mock.calls[0];
      expect(call[0]).toContain("[test-project]");
      expect(call[0]).toContain("[test-agent]");
    });

    it("should respect module-specific verbosity", () => {
      configureLogger({
        moduleVerbosity: {
          default: "silent",
          modules: { agent: "verbose" },
        },
      });
      const agentLogger = new AgentLogger("test-agent");
      agentLogger.info("test message");
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    });

    it("should support all log levels", () => {
      configureLogger({ debugEnabled: true, moduleVerbosity: { default: "debug" } });
      const agentLogger = new AgentLogger("test-agent");

      agentLogger.info("info");
      agentLogger.success("success");
      agentLogger.warning("warning");
      agentLogger.error("error");
      agentLogger.debug("debug");

      expect(consoleLogSpy).toHaveBeenCalledTimes(3); // info, success, debug
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1); // warning
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1); // error
    });
  });

  describe("ScopedLogger", () => {
    it("should create logger for specific module", () => {
      const scopedLogger = new ScopedLogger("llm");
      configureLogger({
        moduleVerbosity: {
          default: "silent",
          modules: { llm: "verbose" },
        },
      });

      scopedLogger.info("test message");
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    });

    it("should support all log levels", () => {
      configureLogger({ debugEnabled: true, moduleVerbosity: { default: "debug" } });
      const scopedLogger = new ScopedLogger("tools");

      scopedLogger.info("info");
      scopedLogger.success("success");
      scopedLogger.warning("warning");
      scopedLogger.error("error");
      scopedLogger.debug("debug");

      expect(consoleLogSpy).toHaveBeenCalledTimes(3); // info, success, debug
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1); // warning
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1); // error
    });
  });

  describe("logger object", () => {
    it("should provide convenience methods", () => {
      configureLogger({ debugEnabled: true, moduleVerbosity: { default: "debug" } });

      logger.info("info");
      logger.success("success");
      logger.warning("warning");
      logger.error("error");
      logger.debug("debug");

      expect(consoleLogSpy).toHaveBeenCalledTimes(3);
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    });

    it("should create agent logger", () => {
      const agentLogger = logger.createAgent("test-agent");
      expect(agentLogger).toBeInstanceOf(AgentLogger);
    });

    it("should create scoped logger for module", () => {
      const scopedLogger = logger.forModule("nostr");
      expect(scopedLogger).toBeInstanceOf(ScopedLogger);
    });
  });

  describe("conversation flow logging", () => {
    it("should log conversation start", () => {
      logger.conversationStart("Hello world", "conv-123", "Test Conversation");
      expect(consoleLogSpy).toHaveBeenCalled();
    });

    it("should log LLM interaction", () => {
      configureLogger({
        moduleVerbosity: {
          default: "verbose",
          modules: { llm: "verbose" },
        },
      });

      logger.llmInteraction("request", {
        model: "test-model",
        userPrompt: "test prompt",
        response: "test response",
      });
      expect(consoleLogSpy).toHaveBeenCalled();
    });

    it("should log phase transition", () => {
      logger.phaseTransition("planning", "execution", "Task ready");
      expect(consoleLogSpy).toHaveBeenCalled();
    });

    it("should log user message", () => {
      logger.userMessage("User input", "conv-123");
      expect(consoleLogSpy).toHaveBeenCalled();
    });

    it("should log agent response", () => {
      logger.agentResponse("orchestrator", "Response text", "conv-123");
      expect(consoleLogSpy).toHaveBeenCalled();
    });

    it("should log conversation error", () => {
      logger.conversationError("Error occurred", { context: "test" });
      expect(consoleLogSpy).toHaveBeenCalled();
    });
  });
});
