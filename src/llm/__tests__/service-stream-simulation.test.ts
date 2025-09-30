import { LLMService } from "../service";
import type { LLMLogger } from "@/logging/LLMLogger";
import type { AISdkTool } from "@/tools/registry";
import { createProviderRegistry } from "ai";
import { vi, describe, it, expect, beforeEach } from 'vitest';

describe("LLMService Stream Simulation", () => {
  let llmLogger: LLMLogger;
  let service: LLMService;
  const mockTools: Record<string, AISdkTool> = {};

  beforeEach(() => {
    // Mock logger
    llmLogger = {
      logLLMRequest: vi.fn().mockResolvedValue(undefined),
      logLLMResponse: vi.fn().mockResolvedValue(undefined),
    } as unknown as LLMLogger;
  });

  it.skip("should simulate streaming for claudeCode provider", async () => {
    // Create service for claudeCode (non-streaming provider)
    service = new LLMService(
      llmLogger,
      null, // No registry for claudeCode
      "claudeCode",
      "opus",
      undefined,
      undefined,
      // Mock claudeCode provider function
      () => ({
        doGenerate: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "This is a complete response from Claude Code" }],
          usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
          steps: [],
          finishReason: "stop",
          warnings: [],
          response: {
            id: "test-id",
            timestamp: new Date(),
            modelId: "opus",
          },
          request: {
            body: "test",
          },
          providerMetadata: {},
        }),
        // Add doStream method for middleware compatibility
        doStream: vi.fn().mockResolvedValue({
          stream: new ReadableStream({
            async start(controller) {
              controller.enqueue({
                type: "text-delta",
                delta: "This is a complete response from Claude Code",
              });
              controller.enqueue({
                type: "finish",
                finishReason: "stop",
                usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
              });
              controller.close();
            },
          }),
          warnings: [],
          rawResponse: {},
        }),
      } as any),
      undefined, // No session ID
      "test-agent" // Agent slug for test
    );

    const contentEvents: string[] = [];
    let completeEvent: any = null;

    // Listen for events
    service.on("content", (data) => {
      contentEvents.push(data.delta);
    });

    service.on("complete", (data) => {
      completeEvent = data;
    });

    // Call stream
    const messages = [
      { role: "user" as const, content: "Test message" },
    ];

    await service.stream(messages, mockTools);

    // Verify simulation behavior
    expect(contentEvents).toHaveLength(1);
    expect(contentEvents[0]).toBe("This is a complete response from Claude Code");
    expect(completeEvent).toBeTruthy();
    expect(completeEvent.message).toBe("This is a complete response from Claude Code");
    expect(completeEvent.usage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
    });
  });

  it("should not simulate streaming for OpenAI provider", async () => {
    // For this test, we'll verify that the service doesn't call simulateStream
    // by checking that it would try to use the registry instead
    const mockRegistry = createProviderRegistry({});
    
    service = new LLMService(
      llmLogger,
      mockRegistry,
      "openai",
      "gpt-4",
      undefined,
      undefined,
      undefined, // No Claude Code provider function
      undefined, // No session ID
      "test-agent" // Agent slug for test
    );

    // Spy on the private simulateStream method
    const simulateStreamSpy = vi.spyOn(service as any, "simulateStream");
    
    // This will fail because we don't have a real OpenAI provider,
    // but we're just checking that simulateStream is not called
    try {
      await service.stream(
        [{ role: "user" as const, content: "Test" }],
        mockTools
      );
    } catch (error) {
      // Expected to fail - no real provider
    }

    expect(simulateStreamSpy).not.toHaveBeenCalled();
  });

  it.skip("should handle tool calls in simulated stream", async () => {
    // Create service with mock complete method that returns tool calls
    service = new LLMService(
      llmLogger,
      null,
      "claudeCode",
      "opus",
      undefined,
      undefined,
      () => ({
        doGenerate: vi.fn(),
        // Add doStream method for middleware compatibility
        doStream: vi.fn().mockResolvedValue({
          stream: new ReadableStream({
            async start(controller) {
              controller.enqueue({
                type: "text-delta",
                delta: "I'll help you with that.",
              });
              controller.enqueue({
                type: "tool-call",
                toolCallId: "tool-1",
                toolName: "test-tool",
                input: { foo: "bar" },
              });
              controller.enqueue({
                type: "tool-result",
                toolCallId: "tool-1",
                toolName: "test-tool",
                output: { success: true },
              });
              controller.enqueue({
                type: "finish",
                finishReason: "stop",
                usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
              });
              controller.close();
            },
          }),
          warnings: [],
          rawResponse: {},
        }),
      } as any),
      undefined, // No session ID
      "test-agent" // Agent slug for test
    );

    // Mock the complete method to return tool calls
    vi.spyOn(service, "complete").mockResolvedValue({
      text: "I'll help you with that.",
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      steps: [],
      toolCalls: [
        {
          toolCallId: "tool-1",
          toolName: "test-tool",
          args: { foo: "bar" },
        },
      ],
      toolResults: [
        {
          toolCallId: "tool-1",
          result: { success: true },
        },
      ],
    } as any);

    const toolWillExecuteEvents: any[] = [];
    const toolDidExecuteEvents: any[] = [];

    service.on("tool-will-execute", (data) => {
      toolWillExecuteEvents.push(data);
    });

    service.on("tool-did-execute", (data) => {
      toolDidExecuteEvents.push(data);
    });

    await service.stream(
      [{ role: "user" as const, content: "Test" }],
      mockTools
    );

    expect(toolWillExecuteEvents).toHaveLength(1);
    expect(toolWillExecuteEvents[0]).toEqual({
      toolName: "test-tool",
      toolCallId: "tool-1",
      args: { foo: "bar" },
    });

    expect(toolDidExecuteEvents).toHaveLength(1);
    expect(toolDidExecuteEvents[0]).toEqual({
      toolName: "test-tool",
      toolCallId: "tool-1",
      result: { success: true },
    });
  });
});