import { describe, expect, it, beforeEach, vi, type Mock } from "vitest";
import { TracingLogger } from "../TracingLogger";
import type { TracingContext } from "../TracingContext";
import { logger as baseLogger } from "@/utils/logger";

// Mock the base logger
vi.mock("@/utils/logger", () => ({
    logger: {
        info: vi.fn(),
        success: vi.fn(),
        warning: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        forModule: vi.fn(() => ({
            info: vi.fn(),
            success: vi.fn(),
            warning: vi.fn(),
            error: vi.fn(),
            debug: vi.fn()
        }))
    },
    parseModuleVerbosity: vi.fn(() => ({
        default: "normal",
        modules: {}
    }))
}));

describe("TracingLogger", () => {
    let mockContext: TracingContext;
    let tracingLogger: TracingLogger;
    let moduleLogger: any;

    beforeEach(() => {
        vi.clearAllMocks();
        
        mockContext = {
            conversationId: "conv-123",
            executionId: "exec-456",
            currentAgent: "TestAgent",
            currentPhase: "CHAT",
            currentTool: "testTool"
        };

        moduleLogger = {
            info: vi.fn(),
            success: vi.fn(),
            warning: vi.fn(),
            error: vi.fn(),
            debug: vi.fn()
        };

        (baseLogger.forModule as Mock).mockReturnValue(moduleLogger);
        
        tracingLogger = new TracingLogger(mockContext);
    });

    describe("initialization", () => {
        it("should create logger with context", () => {
            expect(tracingLogger).toBeDefined();
        });

        it("should create logger with module", () => {
            const { parseModuleVerbosity } = await import("@/utils/logger");
            (parseModuleVerbosity as Mock).mockReturnValue({
                default: "debug",
                modules: { agent: "verbose" }
            });

            const moduleTracingLogger = new TracingLogger(mockContext, "agent");
            expect(moduleTracingLogger).toBeDefined();
        });

        it("should disable tracing for normal verbosity", () => {
            const { parseModuleVerbosity } = await import("@/utils/logger");
            (parseModuleVerbosity as Mock).mockReturnValue({
                default: "normal",
                modules: {}
            });

            const logger = new TracingLogger(mockContext);
            logger.info("test message");

            expect(baseLogger.info).toHaveBeenCalledWith("test message", "normal", {});
        });

        it("should enable tracing for verbose verbosity", () => {
            const { parseModuleVerbosity } = await import("@/utils/logger");
            (parseModuleVerbosity as Mock).mockReturnValue({
                default: "verbose",
                modules: {}
            });

            const logger = new TracingLogger(mockContext);
            logger.info("test message");

            expect(baseLogger.info).toHaveBeenCalledWith("test message", "normal", {
                conversationId: "conv-123",
                executionId: "exec-456",
                agent: "TestAgent",
                phase: "CHAT",
                tool: "testTool"
            });
        });

        it("should enable tracing for debug verbosity", () => {
            const { parseModuleVerbosity } = await import("@/utils/logger");
            (parseModuleVerbosity as Mock).mockReturnValue({
                default: "debug",
                modules: {}
            });

            const logger = new TracingLogger(mockContext);
            logger.info("test message");

            expect(baseLogger.info).toHaveBeenCalledWith("test message", "normal", {
                conversationId: "conv-123",
                executionId: "exec-456",
                agent: "TestAgent",
                phase: "CHAT",
                tool: "testTool"
            });
        });
    });

    describe("forModule", () => {
        it("should create scoped logger for module", () => {
            const moduleLogger = tracingLogger.forModule("agent");
            expect(moduleLogger).toBeDefined();
            expect(moduleLogger).toBeInstanceOf(TracingLogger);
        });

        it("should preserve context when creating module logger", () => {
            const { parseModuleVerbosity } = await import("@/utils/logger");
            (parseModuleVerbosity as Mock).mockReturnValue({
                default: "debug",
                modules: {}
            });

            const moduleLogger = tracingLogger.forModule("agent");
            moduleLogger.info("module test");

            expect(baseLogger.forModule).toHaveBeenCalledWith("agent");
        });
    });

    describe("withContext", () => {
        it("should create new logger with updated context", () => {
            const newContext: TracingContext = {
                conversationId: "new-conv",
                executionId: "new-exec"
            };

            const newLogger = tracingLogger.withContext(newContext);
            expect(newLogger).toBeDefined();
            expect(newLogger).toBeInstanceOf(TracingLogger);
            expect(newLogger).not.toBe(tracingLogger);
        });
    });

    describe("logging methods", () => {
        beforeEach(() => {
            const { parseModuleVerbosity } = await import("@/utils/logger");
            (parseModuleVerbosity as Mock).mockReturnValue({
                default: "debug",
                modules: {}
            });
            tracingLogger = new TracingLogger(mockContext);
        });

        describe("info", () => {
            it("should log info message with context", () => {
                tracingLogger.info("Test info message");

                expect(baseLogger.info).toHaveBeenCalledWith(
                    "Test info message",
                    "normal",
                    {
                        conversationId: "conv-123",
                        executionId: "exec-456",
                        agent: "TestAgent",
                        phase: "CHAT",
                        tool: "testTool"
                    }
                );
            });

            it("should merge additional context", () => {
                tracingLogger.info("Test info", { extra: "data" });

                expect(baseLogger.info).toHaveBeenCalledWith(
                    "Test info",
                    "normal",
                    {
                        conversationId: "conv-123",
                        executionId: "exec-456",
                        agent: "TestAgent",
                        phase: "CHAT",
                        tool: "testTool",
                        extra: "data"
                    }
                );
            });

            it("should use module logger when module is set", () => {
                const moduleTracingLogger = new TracingLogger(mockContext, "agent");
                moduleTracingLogger.info("Module info");

                expect(baseLogger.forModule).toHaveBeenCalledWith("agent");
                expect(moduleLogger.info).toHaveBeenCalled();
            });
        });

        describe("success", () => {
            it("should log success message", () => {
                tracingLogger.success("Operation completed");

                expect(baseLogger.success).toHaveBeenCalledWith("Operation completed", "normal");
                expect(baseLogger.debug).toHaveBeenCalledWith(
                    "Context",
                    "debug",
                    {
                        conversationId: "conv-123",
                        executionId: "exec-456",
                        agent: "TestAgent",
                        phase: "CHAT",
                        tool: "testTool"
                    }
                );
            });

            it("should log context separately with additional data", () => {
                tracingLogger.success("Success", { result: "good" });

                expect(baseLogger.success).toHaveBeenCalledWith("Success", "normal");
                expect(baseLogger.debug).toHaveBeenCalledWith(
                    "Context",
                    "debug",
                    {
                        conversationId: "conv-123",
                        executionId: "exec-456",
                        agent: "TestAgent",
                        phase: "CHAT",
                        tool: "testTool",
                        result: "good"
                    }
                );
            });
        });

        describe("warning", () => {
            it("should log warning message with context", () => {
                tracingLogger.warning("Warning message");

                expect(baseLogger.warning).toHaveBeenCalledWith(
                    "Warning message",
                    "normal",
                    {
                        conversationId: "conv-123",
                        executionId: "exec-456",
                        agent: "TestAgent",
                        phase: "CHAT",
                        tool: "testTool"
                    }
                );
            });
        });

        describe("error", () => {
            it("should log error message with context", () => {
                const testError = new Error("Test error");
                tracingLogger.error("Error occurred", testError);

                expect(baseLogger.error).toHaveBeenCalledWith(
                    "Error occurred",
                    {
                        error: testError,
                        conversationId: "conv-123",
                        executionId: "exec-456",
                        agent: "TestAgent",
                        phase: "CHAT",
                        tool: "testTool"
                    }
                );
            });

            it("should log error without error object", () => {
                tracingLogger.error("Error message");

                expect(baseLogger.error).toHaveBeenCalledWith(
                    "Error message",
                    {
                        conversationId: "conv-123",
                        executionId: "exec-456",
                        agent: "TestAgent",
                        phase: "CHAT",
                        tool: "testTool"
                    }
                );
            });

            it("should merge additional context with error", () => {
                const error = new Error("Test");
                tracingLogger.error("Error", error, { code: "ERR_001" });

                expect(baseLogger.error).toHaveBeenCalledWith(
                    "Error",
                    {
                        error,
                        conversationId: "conv-123",
                        executionId: "exec-456",
                        agent: "TestAgent",
                        phase: "CHAT",
                        tool: "testTool",
                        code: "ERR_001"
                    }
                );
            });
        });

        describe("debug", () => {
            it("should log debug message with context", () => {
                tracingLogger.debug("Debug info");

                expect(baseLogger.debug).toHaveBeenCalledWith(
                    "Debug info",
                    "debug",
                    {
                        conversationId: "conv-123",
                        executionId: "exec-456",
                        agent: "TestAgent",
                        phase: "CHAT",
                        tool: "testTool"
                    }
                );
            });
        });

        describe("startOperation", () => {
            it("should log operation start with context", () => {
                tracingLogger.startOperation("data processing");

                expect(baseLogger.info).toHaveBeenCalledWith(
                    "Starting data processing",
                    "normal",
                    {
                        operation: "data processing",
                        event: "operation_start",
                        conversationId: "conv-123",
                        executionId: "exec-456",
                        agent: "TestAgent",
                        phase: "CHAT",
                        tool: "testTool"
                    }
                );
            });

            it("should include additional operation context", () => {
                tracingLogger.startOperation("file upload", { fileSize: 1024 });

                expect(baseLogger.info).toHaveBeenCalledWith(
                    "Starting file upload",
                    "normal",
                    {
                        operation: "file upload",
                        event: "operation_start",
                        fileSize: 1024,
                        conversationId: "conv-123",
                        executionId: "exec-456",
                        agent: "TestAgent",
                        phase: "CHAT",
                        tool: "testTool"
                    }
                );
            });
        });
    });

    describe("context formatting", () => {
        it("should omit undefined context fields", () => {
            const { parseModuleVerbosity } = await import("@/utils/logger");
            (parseModuleVerbosity as Mock).mockReturnValue({
                default: "debug",
                modules: {}
            });

            const minimalContext: TracingContext = {
                conversationId: "conv-123",
                executionId: "exec-456"
            };

            const minimalLogger = new TracingLogger(minimalContext);
            minimalLogger.info("Minimal context");

            expect(baseLogger.info).toHaveBeenCalledWith(
                "Minimal context",
                "normal",
                {
                    conversationId: "conv-123",
                    executionId: "exec-456"
                }
            );
        });

        it("should handle empty additional context", () => {
            const { parseModuleVerbosity } = await import("@/utils/logger");
            (parseModuleVerbosity as Mock).mockReturnValue({
                default: "normal",
                modules: {}
            });

            const logger = new TracingLogger(mockContext);
            logger.info("No extra context", undefined);

            expect(baseLogger.info).toHaveBeenCalledWith("No extra context", "normal", {});
        });
    });

    describe("module verbosity integration", () => {
        it("should respect module-specific verbosity settings", () => {
            const { parseModuleVerbosity } = await import("@/utils/logger");
            (parseModuleVerbosity as Mock).mockReturnValue({
                default: "normal",
                modules: {
                    agent: "debug",
                    tools: "silent"
                }
            });

            const agentLogger = new TracingLogger(mockContext, "agent");
            agentLogger.info("Agent message");

            // Should include context because agent module is debug level
            expect(moduleLogger.info).toHaveBeenCalledWith(
                "Agent message",
                "normal",
                expect.objectContaining({
                    conversationId: "conv-123"
                })
            );
        });

        it("should use default verbosity when module not specified", () => {
            const { parseModuleVerbosity } = await import("@/utils/logger");
            (parseModuleVerbosity as Mock).mockReturnValue({
                default: "silent",
                modules: {
                    agent: "debug"
                }
            });

            const generalLogger = new TracingLogger(mockContext, "general");
            generalLogger.info("General message");

            // Should not include context because default is silent
            expect(baseLogger.forModule).toHaveBeenCalledWith("general");
            expect(moduleLogger.info).toHaveBeenCalledWith(
                "General message",
                "normal",
                {}
            );
        });
    });
});