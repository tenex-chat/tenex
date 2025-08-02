import { describe, it, expect, beforeEach, mock, spyOn } from "bun:test";
import { ExecutionLogger, createExecutionLogger } from "../ExecutionLogger";
import type { TracingContext } from "@/tracing";
import { createTracingLogger } from "@/tracing";
import type { Phase } from "@/conversations/phases";

// Mock dependencies
mock.module("@/utils/logger", () => ({
    logger: {
        info: mock(() => {}),
        error: mock(() => {}),
        warn: mock(() => {}),
        debug: mock(() => {}),
    },
}));

// Mock chalk to avoid color codes in tests
mock.module("chalk", () => {
    const mockChalk: any = (str: string) => str;
    mockChalk.bold = (str: string) => str;
    mockChalk.dim = (str: string) => str;
    mockChalk.gray = (str: string) => str;
    mockChalk.white = (str: string) => str;
    mockChalk.blue = (str: string) => str;
    mockChalk.green = (str: string) => str;
    mockChalk.red = (str: string) => str;
    mockChalk.yellow = (str: string) => str;
    mockChalk.cyan = (str: string) => str;
    mockChalk.magenta = (str: string) => str;
    mockChalk.greenBright = (str: string) => str;
    mockChalk.italic = (str: string) => str;
    mockChalk.bgGreen = {
        white: (str: string) => str,
    };
    mockChalk.bgRed = {
        white: (str: string) => str,
    };
    mockChalk.bold.cyan = (str: string) => str;
    mockChalk.bold.green = (str: string) => str;
    mockChalk.bold.red = (str: string) => str;
    return mockChalk;
});

// Mock tracing logger
const mockTracingLogger = {
    info: mock(() => {}),
    success: mock(() => {}),
    error: mock(() => {}),
    warn: mock(() => {}),
    debug: mock(() => {}),
};

mock.module("@/tracing", () => ({
    createTracingLogger: mock(() => mockTracingLogger),
}));

describe("ExecutionLogger", () => {
    let logger: ExecutionLogger;
    let consoleLogSpy: any;
    let context: TracingContext;

    beforeEach(() => {
        // Reset all mocks
        mock.restore();
        
        // Mock console.log to capture output
        consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});

        // Create test context
        context = {
            conversationId: "conv123",
            agentId: "agent123",
            phase: "CHAT" as Phase,
            requestId: "req123",
        };

        // Create logger instance
        logger = new ExecutionLogger(context);
    });

    describe("constructor", () => {
        it("should create logger with default module", () => {
            const logger = new ExecutionLogger(context);
            expect(createTracingLogger).toHaveBeenCalledWith(context, "agent");
        });

        it("should create logger with custom module", () => {
            const logger = new ExecutionLogger(context, "custom");
            expect(createTracingLogger).toHaveBeenCalledWith(context, "custom");
        });
    });

    describe("updateContext", () => {
        it("should update context and recreate tracing logger", () => {
            const newContext: TracingContext = {
                conversationId: "conv456",
                agentId: "agent456",
                phase: "PLAN" as Phase,
                requestId: "req456",
            };

            logger.updateContext(newContext);

            expect(createTracingLogger).toHaveBeenCalledWith(newContext, "agent");
        });
    });

    describe("agent events", () => {
        it("should log agent thinking event", () => {
            logger.logEvent({
                type: "agent_thinking",
                agent: "TestAgent",
                reasoning: "Analyzing user request",
                context: {
                    userMessage: "Help me build a feature",
                    considerations: ["complexity", "time"],
                    leaningToward: "step-by-step approach",
                    confidence: 0.85,
                },
            });

            expect(consoleLogSpy).toHaveBeenCalled();
            expect(mockTracingLogger.info).toHaveBeenCalledWith(
                "Agent thinking",
                expect.objectContaining({
                    event: "agent_thinking",
                    agent: "TestAgent",
                })
            );
        });

        it("should log agent decision event", () => {
            logger.logEvent({
                type: "agent_decision",
                agent: "TestAgent",
                decisionType: "routing",
                decision: "Route to Executor",
                reasoning: "Task requires implementation",
                confidence: 0.9,
                alternatives: ["Planner", "Analyst"],
            });

            expect(consoleLogSpy).toHaveBeenCalled();
            expect(mockTracingLogger.info).toHaveBeenCalledWith(
                "Agent decision made",
                expect.objectContaining({
                    event: "agent_decision",
                    decisionType: "routing",
                })
            );
        });

        it("should log agent handoff event", () => {
            logger.logEvent({
                type: "agent_handoff",
                from: "Orchestrator",
                to: "Executor",
                task: "Implement authentication feature",
                context: "User requested OAuth integration",
                phase: "EXECUTE" as Phase,
            });

            expect(consoleLogSpy).toHaveBeenCalled();
            expect(mockTracingLogger.info).toHaveBeenCalledWith(
                "Agent handoff",
                expect.objectContaining({
                    event: "agent_handoff",
                    from: "Orchestrator",
                    to: "Executor",
                })
            );
        });
    });

    describe("phase transition events", () => {
        it("should log phase transition trigger", () => {
            logger.logEvent({
                type: "phase_transition_trigger",
                conversationId: "conv123",
                currentPhase: "CHAT" as Phase,
                trigger: "User requested planning",
                triggerAgent: "Orchestrator",
                signal: "PLAN_REQUESTED",
            });

            expect(consoleLogSpy).toHaveBeenCalled();
            expect(mockTracingLogger.info).toHaveBeenCalledWith(
                "Phase transition triggered",
                expect.objectContaining({
                    event: "phase_transition_trigger",
                })
            );
        });

        it("should log phase transition decision", () => {
            logger.logEvent({
                type: "phase_transition_decision",
                conversationId: "conv123",
                from: "CHAT" as Phase,
                to: "PLAN" as Phase,
                decisionBy: "Orchestrator",
                reason: "Complex task requires planning",
                confidence: 0.95,
            });

            expect(consoleLogSpy).toHaveBeenCalled();
            expect(mockTracingLogger.info).toHaveBeenCalledWith(
                "Phase transition decision",
                expect.objectContaining({
                    event: "phase_transition_decision",
                })
            );
        });

        it("should log phase transition executed", () => {
            logger.logEvent({
                type: "phase_transition_executed",
                conversationId: "conv123",
                from: "CHAT" as Phase,
                to: "PLAN" as Phase,
                handoffTo: "Planner",
                handoffMessage: "Please create a plan for authentication",
                duration: 1500,
            });

            expect(consoleLogSpy).toHaveBeenCalled();
            expect(mockTracingLogger.success).toHaveBeenCalledWith(
                "Phase transition completed",
                expect.objectContaining({
                    event: "phase_transition_executed",
                })
            );
        });
    });

    describe("routing events", () => {
        it("should log routing analysis", () => {
            logger.logEvent({
                type: "routing_analysis",
                agent: "Orchestrator",
                messageAnalysis: "User needs implementation help",
                candidateAgents: ["Executor", "CodeReviewer"],
                phaseConsiderations: "Currently in EXECUTE phase",
            });

            expect(consoleLogSpy).toHaveBeenCalled();
            expect(mockTracingLogger.info).toHaveBeenCalledWith(
                "Routing analysis",
                expect.objectContaining({
                    event: "routing_analysis",
                })
            );
        });

        it("should log routing decision", () => {
            logger.logEvent({
                type: "routing_decision",
                agent: "Orchestrator",
                targetAgents: ["Executor"],
                targetPhase: "EXECUTE" as Phase,
                reason: "Implementation task identified",
                confidence: 0.88,
            });

            expect(consoleLogSpy).toHaveBeenCalled();
            // Note: routing decision doesn't call tracingLogger in the implementation
        });
    });

    describe("tool execution events", () => {
        it("should log tool execution start", () => {
            logger.logEvent({
                type: "tool_execution_start",
                agent: "Executor",
                tool: "shell",
                parameters: {
                    command: "npm test",
                    cwd: "/project",
                },
            });

            expect(consoleLogSpy).toHaveBeenCalled();
            expect(mockTracingLogger.info).toHaveBeenCalledWith(
                "Tool execution started",
                expect.objectContaining({
                    event: "tool_execution_start",
                    tool: "shell",
                })
            );
        });

        it("should log tool execution complete - success", () => {
            logger.logEvent({
                type: "tool_execution_complete",
                agent: "Executor",
                tool: "shell",
                status: "success",
                duration: 2500,
                result: "All tests passed",
            });

            expect(consoleLogSpy).toHaveBeenCalled();
            expect(mockTracingLogger.info).toHaveBeenCalledWith(
                "Tool execution completed",
                expect.objectContaining({
                    event: "tool_execution_complete",
                    status: "success",
                })
            );
        });

        it("should log tool execution complete - error", () => {
            logger.logEvent({
                type: "tool_execution_complete",
                agent: "Executor",
                tool: "shell",
                status: "error",
                duration: 500,
                error: "Command not found",
            });

            expect(consoleLogSpy).toHaveBeenCalled();
            expect(mockTracingLogger.info).toHaveBeenCalledWith(
                "Tool execution completed",
                expect.objectContaining({
                    event: "tool_execution_complete",
                    status: "error",
                })
            );
        });
    });

    describe("conversation events", () => {
        it("should log conversation start", () => {
            logger.logEvent({
                type: "conversation_start",
                conversationId: "conv123",
                title: "Build Authentication",
                userMessage: "Help me implement OAuth",
                eventId: "event123",
            });

            expect(consoleLogSpy).toHaveBeenCalled();
        });

        it("should log conversation complete - success", () => {
            logger.logEvent({
                type: "conversation_complete",
                conversationId: "conv123",
                finalPhase: "COMPLETE" as Phase,
                totalDuration: 60000,
                success: true,
            });

            expect(consoleLogSpy).toHaveBeenCalled();
            expect(mockTracingLogger.info).toHaveBeenCalledWith(
                "Conversation completed",
                expect.objectContaining({
                    event: "conversation_complete",
                    success: true,
                })
            );
        });

        it("should log execution flow complete", () => {
            logger.logEvent({
                type: "execution_flow_complete",
                conversationId: "conv123",
                narrative: "Successfully implemented authentication",
                success: true,
            });

            expect(consoleLogSpy).toHaveBeenCalled();
            expect(mockTracingLogger.info).toHaveBeenCalledWith(
                "Execution flow completed",
                expect.objectContaining({
                    event: "execution_flow_complete",
                })
            );
        });
    });

    describe("helper methods", () => {
        it("should truncate long text", () => {
            const longText = "a".repeat(100);
            logger.logEvent({
                type: "agent_thinking",
                agent: "TestAgent",
                reasoning: "test",
                context: {
                    userMessage: longText,
                },
            });

            // Verify truncation happened (60 chars + "...")
            const calls = consoleLogSpy.mock.calls;
            const outputStr = calls.flat().join(" ");
            expect(outputStr).toContain("...");
        });

        it("should format duration correctly", () => {
            // Test seconds
            logger.logEvent({
                type: "conversation_complete",
                conversationId: "conv123",
                finalPhase: "COMPLETE" as Phase,
                totalDuration: 45000, // 45 seconds
                success: true,
            });

            let outputStr = consoleLogSpy.mock.calls.flat().join(" ");
            expect(outputStr).toContain("45.0s");

            // Reset spy
            consoleLogSpy.mockClear();

            // Test minutes
            logger.logEvent({
                type: "conversation_complete",
                conversationId: "conv123",
                finalPhase: "COMPLETE" as Phase,
                totalDuration: 125000, // 2m 5s
                success: true,
            });

            outputStr = consoleLogSpy.mock.calls.flat().join(" ");
            expect(outputStr).toContain("2m 5s");
        });

        it("should format parameters correctly", () => {
            logger.logEvent({
                type: "tool_execution_start",
                agent: "Executor",
                tool: "test",
                parameters: {
                    string: "value",
                    number: 42,
                    object: { nested: true },
                    longString: "a".repeat(50),
                    extra1: "val1",
                    extra2: "val2",
                },
            });

            const outputStr = consoleLogSpy.mock.calls.flat().join(" ");
            expect(outputStr).toContain("{...}"); // object formatting
            expect(outputStr).toContain("..."); // parameter truncation
        });
    });

    describe("quick logging methods", () => {
        it("should log agent thinking via helper", () => {
            logger.agentThinking("TestAgent", "Analyzing request", {
                userMessage: "Build feature",
                confidence: 0.8,
            });

            expect(mockTracingLogger.info).toHaveBeenCalledWith(
                "Agent thinking",
                expect.objectContaining({
                    agent: "TestAgent",
                    reasoning: "Analyzing request",
                })
            );
        });

        it("should log agent decision via helper", () => {
            logger.agentDecision(
                "TestAgent",
                "routing",
                "Route to Executor",
                "Task requires implementation",
                { confidence: 0.9, alternatives: ["Planner"] }
            );

            expect(mockTracingLogger.info).toHaveBeenCalledWith(
                "Agent decision made",
                expect.objectContaining({
                    agent: "TestAgent",
                    decisionType: "routing",
                })
            );
        });

        it("should log routing decision via helper", () => {
            logger.routingDecision(
                "Orchestrator",
                ["Executor", "CodeReviewer"],
                "Implementation needed",
                { targetPhase: "EXECUTE" as Phase, confidence: 0.85 }
            );

            expect(consoleLogSpy).toHaveBeenCalled();
        });

        it("should log tool start via helper", () => {
            logger.toolStart("Executor", "shell", { command: "npm test" });

            expect(mockTracingLogger.info).toHaveBeenCalledWith(
                "Tool execution started",
                expect.objectContaining({
                    tool: "shell",
                })
            );
        });

        it("should log tool complete via helper", () => {
            logger.toolComplete(
                "Executor",
                "shell",
                "success",
                1500,
                { result: "Tests passed" }
            );

            expect(mockTracingLogger.info).toHaveBeenCalledWith(
                "Tool execution completed",
                expect.objectContaining({
                    status: "success",
                    duration: 1500,
                })
            );
        });
    });

    describe("createExecutionLogger", () => {
        it("should create logger instance", () => {
            const logger = createExecutionLogger(context);
            expect(logger).toBeInstanceOf(ExecutionLogger);
        });

        it("should pass custom module", () => {
            const logger = createExecutionLogger(context, "custom");
            expect(createTracingLogger).toHaveBeenCalledWith(context, "custom");
        });
    });

    describe("edge cases", () => {
        it("should handle events without optional fields", () => {
            // Agent thinking without context
            logger.logEvent({
                type: "agent_thinking",
                agent: "TestAgent",
                reasoning: "Basic reasoning",
                context: {},
            });

            expect(consoleLogSpy).toHaveBeenCalled();
        });

        it("should handle tool execution without parameters", () => {
            logger.logEvent({
                type: "tool_execution_start",
                agent: "Executor",
                tool: "simple_tool",
            });

            expect(consoleLogSpy).toHaveBeenCalled();
        });

        it("should handle phase transition without optional fields", () => {
            logger.logEvent({
                type: "phase_transition_executed",
                conversationId: "conv123",
                from: "CHAT" as Phase,
                to: "PLAN" as Phase,
            });

            expect(consoleLogSpy).toHaveBeenCalled();
        });

        it("should handle conversation start without title or eventId", () => {
            logger.logEvent({
                type: "conversation_start",
                conversationId: "conv123",
                userMessage: "Help me",
            });

            expect(consoleLogSpy).toHaveBeenCalled();
        });
    });
});