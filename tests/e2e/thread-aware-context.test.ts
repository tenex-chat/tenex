import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { 
    setupE2ETest, 
    cleanupE2ETest, 
    createConversation,
    executeConversationFlow,
    type E2ETestContext,
    type ExecutionTrace
} from "./test-harness";
import type { MockLLMResponse } from "@/test-utils/mock-llm/types";

describe("E2E: Thread-Aware Context", () => {
  let context: E2ETestContext;

  beforeEach(async () => {
    // Setup with threading scenario responses
    const threadingScenario: MockLLMResponse[] = [
      // Root conversation responses
      {
        trigger: {
          systemPrompt: /You must respond with ONLY a JSON object/,
          userMessage: /simply say "YELLOW"/i,
        },
        response: {
          content: JSON.stringify({
            agents: ["orchestrator"],
            phase: "CHAT",
            reason: "User wants me to say YELLOW."
          })
        },
        priority: 100
      },
      {
        trigger: {
          systemPrompt: /orchestrator/i,
          userMessage: /simply say "YELLOW"/i,
        },
        response: {
          content: "YELLOW"
        },
        priority: 90
      },
      {
        trigger: {
          systemPrompt: /You must respond with ONLY a JSON object/,
          userMessage: /simply say "BROWN"/i,
        },
        response: {
          content: JSON.stringify({
            agents: ["orchestrator"],
            phase: "CHAT",
            reason: "User wants me to say BROWN."
          })
        },
        priority: 100
      },
      {
        trigger: {
          systemPrompt: /orchestrator/i,
          userMessage: /simply say "BROWN"/i,
        },
        response: {
          content: "BROWN"
        },
        priority: 90
      },
      // Thread-specific responses
      {
        trigger: {
          systemPrompt: /orchestrator/i,
          userMessage: /give me this color in lowercase/i,
          messageContains: /YELLOW/,
        },
        response: {
          content: "yellow"
        },
        priority: 110
      },
      {
        trigger: {
          systemPrompt: /orchestrator/i,
          userMessage: /give me this color in lowercase/i,
          messageContains: /BROWN/,
        },
        response: {
          content: "brown"
        },
        priority: 110
      },
    ];
    
    context = await setupE2ETest(threadingScenario);
  });
  
  afterEach(async () => {
    await cleanupE2ETest(context);
  });

  describe("Linear thread conversations", () => {
    it("should maintain context in a single linear thread", async () => {
      const conversation = await createConversation(context, "test-thread-linear");
      
      // Execute conversation flow with threading
      const trace = await executeConversationFlow(
        context,
        conversation.id,
        [
          {
            message: 'simply say "YELLOW"',
            expectedResponse: /YELLOW/,
            expectedPhase: "CHAT"
          },
          {
            message: "Give me this color in lowercase",
            expectedResponse: /yellow/,
            expectedPhase: "CHAT",
            // This would reply to the previous message in a thread
            replyTo: "previous"
          }
        ]
      );
      
      // Verify the context was properly filtered
      expect(trace.agentExecutions.length).toBeGreaterThan(0);
      const lastExecution = trace.agentExecutions[trace.agentExecutions.length - 1];
      expect(lastExecution.response).toContain("yellow");
    });
  });

  describe("Thread filtering", () => {
    it("should filter context based on thread path", async () => {
      const conversation = await createConversation(context, "test-thread-filter");
      
      // Create two parallel threads and verify isolation
      const trace = await executeConversationFlow(
        context,
        conversation.id,
        [
          // Thread A
          {
            message: 'simply say "YELLOW"',
            expectedResponse: /YELLOW/,
            expectedPhase: "CHAT"
          },
          // Thread B (parallel to A)
          {
            message: 'simply say "BROWN"',
            expectedResponse: /BROWN/,
            expectedPhase: "CHAT",
            replyTo: "root" // Reply to root, not previous
          },
          // Continue in thread A
          {
            message: "Give me this color in lowercase",
            expectedResponse: /yellow/,
            expectedPhase: "CHAT",
            replyTo: 0 // Reply to first message (YELLOW)
          }
        ]
      );
      
      // Verify the last response is "yellow" not "brown"
      const lastExecution = trace.agentExecutions[trace.agentExecutions.length - 1];
      expect(lastExecution.response).toContain("yellow");
      expect(lastExecution.response).not.toContain("brown");
    });
  });

});