import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { LLMService } from "@/llm/types";
import { createMockLLMService } from "./index";

// Example of how to use the mock LLM service in E2E tests
describe("Example E2E Test with Mock LLM", () => {
  let mockLLM: LLMService;

  beforeEach(() => {
    // Create mock with orchestrator workflow scenario
    mockLLM = createMockLLMService(["orchestrator-workflow"], {
      debug: true, // Enable debug logging
    });

    // Mock the LLM router to return our mock service
    mock.module("@/llm/router", () => ({
      getLLMService: () => mockLLM,
    }));
  });

  it("should complete full workflow from chat to verification", async () => {
    // This would be your actual E2E test code
    // For example, starting the daemon and sending events

    // Simulate user message
    const userMessage = "Create a user authentication system with JWT and OAuth";

    // The mock will automatically respond based on the scenario
    const response = await mockLLM.complete({
      messages: [
        { role: "system", content: "You are the Orchestrator agent. Current Phase: CHAT" },
        { role: "user", content: userMessage },
      ],
      options: { configName: "mock-model" },
    });

    // Verify orchestrator response
    expect(response.content).toContain("I'll help you create a user authentication system");
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0].name).toBe("continue");

    // Get request history for debugging
    const history = (mockLLM as any).getRequestHistory();
    expect(history).toHaveLength(1);
  });

  it("should handle errors gracefully", async () => {
    // Add error scenario
    mockLLM = createMockLLMService(["error-handling"]);

    const response = await mockLLM.complete({
      messages: [
        { role: "system", content: "You are the Executor agent" },
        { role: "user", content: "simulate an error" },
      ],
      options: { configName: "mock-model" },
    });

    expect(response.toolCalls).toBeDefined();
    expect(response.toolCalls[0].name).toBe("shell");
    expect(JSON.stringify(response.toolCalls[0].params)).toContain("exit 1");
  });

  it("should detect infinite loops", async () => {
    // Create custom scenario
    const loopMock = createMockLLMService([
      {
        name: "loop-test",
        description: "Test loop detection",
        responses: [
          {
            trigger: { agentName: "Orchestrator" },
            response: {
              toolCalls: [
                {
                  id: "1",
                  message: null,
                  function: "continue",
                  args: JSON.stringify({
                    summary: "Continuing...",
                    suggestedPhase: "CHAT",
                    confidence: 50,
                  }),
                },
              ],
            },
          },
        ],
      },
    ]);

    // Simulate multiple continues
    for (let i = 0; i < 5; i++) {
      await loopMock.complete({
        messages: [
          { role: "system", content: "You are the Orchestrator agent" },
          { role: "user", content: "continue" },
        ],
        options: { configName: "mock-model" },
      });
    }

    const history = (loopMock as any).getRequestHistory();
    expect(history).toHaveLength(5);
  });
});
