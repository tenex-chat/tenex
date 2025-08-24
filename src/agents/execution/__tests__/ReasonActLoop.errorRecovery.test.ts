import { beforeEach, describe, expect, it, mock } from "bun:test";
import { serializeToolResult } from "@/llm/ToolResult";
import type { LLMService } from "@/llm/types";
import type { ToolError } from "@/tools/core";
import { formatToolError } from "@/utils/error-formatter";
import { ReasonActLoop } from "../ReasonActLoop";

describe("ReasonActLoop - Error Recovery", () => {
  let mockLLMService: LLMService;
  let reasonActLoop: ReasonActLoop;

  beforeEach(() => {
    // Reset mocks
    mock.restore();

    // Create mocks
    mockLLMService = {
      stream: mock(() => {
        throw new Error("Should be mocked per test");
      }),
      complete: mock(() =>
        Promise.resolve({
          content: "test",
          toolCalls: [],
        })
      ),
    } as unknown as LLMService;

    reasonActLoop = new ReasonActLoop(mockLLMService);
  });

  it("should handle tool execution errors and publish them", async () => {
    const mockPublisher = {
      publishError: mock(() => Promise.resolve({})),
      publishTypingIndicator: mock(() => Promise.resolve({})),
    } as any;

    const tracingLogger = {
      info: mock(() => {}),
      error: mock(() => {}),
    } as any;

    // Use reflection to access private method
    const handleToolCompleteEvent = (reasonActLoop as any).handleToolCompleteEvent.bind(
      reasonActLoop
    );

    // Simulate a tool_complete event with a complex error
    const event = {
      tool: "analyze",
      result: {
        __typedResult: serializeToolResult({
          success: false,
          duration: 100,
          error: {
            kind: "execution",
            tool: "analyze",
            message: "Failed to analyze: database connection timeout",
          } as ToolError,
        }),
      },
    };

    const state = {
      allToolResults: [],
      continueFlow: undefined,
      termination: undefined,
      finalResponse: undefined,
      fullContent: "",
      streamHandle: undefined,
      startedTools: new Set<string>(),
    };

    const context = {
      agent: { name: "test-agent", 
      phase: "execute",
    };

    await handleToolCompleteEvent(event, state, undefined, mockPublisher, tracingLogger, context);

    // Verify publishError was called with the formatted error
    expect(mockPublisher.publishError).toHaveBeenCalledWith(
      'Tool "analyze" failed: Failed to analyze: database connection timeout'
    );
    expect(mockPublisher.publishError).toHaveBeenCalledTimes(1);
  });

  it("should format different error types correctly", async () => {
    const mockPublisher = {
      publishError: mock(() => Promise.resolve({})),
      publishTypingIndicator: mock(() => Promise.resolve({})),
    } as any;

    const tracingLogger = {
      info: mock(() => {}),
      error: mock(() => {}),
    } as any;

    const handleToolCompleteEvent = (reasonActLoop as any).handleToolCompleteEvent.bind(
      reasonActLoop
    );

    const state = {
      allToolResults: [],
      continueFlow: undefined,
      termination: undefined,
      finalResponse: undefined,
      fullContent: "",
      streamHandle: undefined,
      startedTools: new Set<string>(),
    };

    const context = {
      agent: { name: "test-agent", 
      phase: "execute",
    };

    // Test system error
    const systemError: ToolError = {
      kind: "system",
      message: "File not found",
    };

    const stringErrorEvent = {
      tool: "readPath",
      result: {
        __typedResult: serializeToolResult({
          success: false,
          duration: 50,
          error: systemError,
        }),
      },
    };

    await handleToolCompleteEvent(
      stringErrorEvent,
      state,
      undefined,
      mockPublisher,
      tracingLogger,
      context
    );

    expect(mockPublisher.publishError).toHaveBeenCalledWith(
      'Tool "readPath" failed: File not found'
    );

    // Reset mock
    mockPublisher.publishError.mockClear();

    // Test complex error object
    const complexErrorEvent = {
      tool: "shell",
      result: {
        __typedResult: serializeToolResult({
          success: false,
          duration: 200,
          error: {
            kind: "execution",
            tool: "shell",
            message: "Command not found (exit code 127)",
          } as ToolError,
        }),
      },
    };

    await handleToolCompleteEvent(
      complexErrorEvent,
      state,
      undefined,
      mockPublisher,
      tracingLogger,
      context
    );

    expect(mockPublisher.publishError).toHaveBeenCalledWith(
      'Tool "shell" failed: Command not found (exit code 127)'
    );
  });

  it("should handle publisher error gracefully when publishing tool errors", async () => {
    const publishError = new Error("Network error");
    const mockPublisher = {
      publishError: mock(() => Promise.reject(publishError)),
      publishTypingIndicator: mock(() => Promise.resolve({})),
    } as any;

    const tracingLogger = {
      info: mock(() => {}),
      error: mock(() => {}),
    } as any;

    const handleToolCompleteEvent = (reasonActLoop as any).handleToolCompleteEvent.bind(
      reasonActLoop
    );

    const event = {
      tool: "complete",
      result: {
        __typedResult: serializeToolResult({
          success: false,
          duration: 100,
          error: {
            kind: "validation",
            field: "routing",
            message: "Invalid routing",
          } as ToolError,
        }),
      },
    };

    const state = {
      allToolResults: [],
      continueFlow: undefined,
      termination: undefined,
      finalResponse: undefined,
      fullContent: "",
      streamHandle: undefined,
      startedTools: new Set<string>(),
    };

    const context = {
      agent: { name: "test-agent", 
      phase: "execute",
    };

    // Should not throw even if publisher fails
    await handleToolCompleteEvent(event, state, undefined, mockPublisher, tracingLogger, context);

    // Verify error was logged
    expect(tracingLogger.error).toHaveBeenCalledWith(
      "Failed to publish tool error",
      expect.objectContaining({
        tool: "complete",
        originalError: {
          kind: "validation",
          field: "unknown", // Field is not serialized, so it becomes "unknown"
          message: "Invalid routing",
        },
        publishError: "Network error",
      })
    );
  });

  it("should validate tool result format", async () => {
    const handleToolCompleteEvent = (reasonActLoop as any).handleToolCompleteEvent.bind(
      reasonActLoop
    );

    const state = {
      allToolResults: [],
      continueFlow: undefined,
      termination: undefined,
      finalResponse: undefined,
      fullContent: "",
      streamHandle: undefined,
      startedTools: new Set<string>(),
    };

    const context = {
      agent: { name: "test-agent", 
      phase: "execute",
    };

    // Test with null result
    const nullResultEvent = {
      tool: "analyze",
      result: null,
    };

    // parseToolResult is called synchronously from handleToolCompleteEvent
    // and should throw immediately
    await expect(
      handleToolCompleteEvent(
        nullResultEvent,
        state,
        undefined,
        undefined,
        { info: mock(() => {}), error: mock(() => {}) },
        context
      )
    ).rejects.toThrow("Tool 'analyze' returned invalid result format");

    // Test with missing __typedResult
    const missingTypedResultEvent = {
      tool: "analyze",
      result: { someData: "test" },
    };

    await expect(
      handleToolCompleteEvent(
        missingTypedResultEvent,
        state,
        undefined,
        undefined,
        { info: mock(() => {}), error: mock(() => {}) },
        context
      )
    ).rejects.toThrow(
      "Tool 'analyze' returned invalid result format. Missing or invalid __typedResult."
    );
  });

  it("should handle error event in stream", () => {
    const streamPublisher = {
      addContent: mock(() => {}),
    } as any;

    const tracingLogger = {
      error: mock(() => {}),
    } as any;

    const handleErrorEvent = (reasonActLoop as any).handleErrorEvent.bind(reasonActLoop);

    const state = {
      fullContent: "Previous content",
    };

    const event = {
      error: "Connection timeout",
    };

    // Test non-orchestrator agent
    const nonOrchestratorContext = {
      agent: { name: "executor", 
    };

    handleErrorEvent(event, state, streamPublisher, tracingLogger, nonOrchestratorContext);

    expect(tracingLogger.error).toHaveBeenCalledWith("Stream error", {
      error: "Connection timeout",
    });
    expect(state.fullContent).toBe("Previous content\n\nError: Connection timeout");
    expect(streamPublisher.addContent).toHaveBeenCalledWith("\n\nError: Connection timeout");

    // Reset
    streamPublisher.addContent.mockClear();
    state.fullContent = "Previous content";

    // Test orchestrator agent (should not add to stream)
    const orchestratorContext = {
      agent: { name: "orchestrator", 
    };

    handleErrorEvent(event, state, streamPublisher, tracingLogger, orchestratorContext);

    expect(state.fullContent).toBe("Previous content\n\nError: Connection timeout");
    expect(streamPublisher.addContent).not.toHaveBeenCalled();
  });

  it("should format various error types correctly", () => {
    // Using the shared formatToolError utility directly

    // Test string error
    expect(formatToolError("Simple error message")).toBe("Simple error message");

    // Test error with message
    expect(formatToolError({ message: "Error with message" })).toBe("Error with message");

    // Test validation error
    const validationError: ToolError = {
      kind: "validation",
      field: "email",
      message: "Invalid email format",
    };
    expect(formatToolError(validationError)).toBe("Invalid email format");

    // Test execution error
    const executionError: ToolError = {
      kind: "execution",
      tool: "shell",
      message: "Command failed",
    };
    expect(formatToolError(executionError)).toBe("Command failed");

    // Test unparseable object
    const circularRef: any = { a: 1 };
    circularRef.self = circularRef;
    expect(formatToolError(circularRef)).toBe("[Complex Error Object]");

    // Test other types
    expect(formatToolError(123)).toBe("123");
    expect(formatToolError(null)).toBe("null");
    expect(formatToolError(undefined)).toBe("undefined");
  });
});
