import type { MockLLMScenario } from "../types";

/**
 * Scenario for testing Nostr network resilience
 * Provides simple, deterministic responses for network failure testing
 */
export const networkResilienceScenario: MockLLMScenario = {
  name: "network-resilience",
  description: "Test network resilience and recovery",

  responses: [
    // Orchestrator responses for initial requests
    {
      trigger: {
        agentName: "Orchestrator",
        phase: "chat",
        userMessage: /authentication|payment|notification|chat|feature/i,
      },
      response: {
        content:
          "I'll help you with that. Let me route this to the appropriate phase for planning.",
        toolCalls: [
          {
            id: "1",
            message: null,
            function: "continue",
            args: JSON.stringify({
              summary: "User requested a new system implementation",
              suggestedPhase: "plan",
              suggestedAgent: "planner",
            }),
          },
        ],
      },
      priority: 10,
    },

    // Planner responses
    {
      trigger: {
        agentName: "Planner",
        phase: "plan",
      },
      response: {
        content:
          "I've created a plan for implementing the requested system. The plan includes core components and basic functionality.",
        toolCalls: [
          {
            id: "1",
            message: null,
            function: "continue",
            args: JSON.stringify({
              summary: "Plan created for system implementation",
              suggestedPhase: "implementation",
              suggestedAgent: "executor",
            }),
          },
        ],
      },
      priority: 10,
    },

    // Executor responses
    {
      trigger: {
        agentName: "Executor",
        phase: "implementation",
      },
      response: {
        content:
          "I've implemented the basic structure for the requested system. The implementation is ready for verification.",
        toolCalls: [
          {
            id: "1",
            message: null,
            function: "continue",
            args: JSON.stringify({
              summary: "Basic implementation completed",
              suggestedPhase: "verification",
              suggestedAgent: "orchestrator",
            }),
          },
        ],
      },
      priority: 10,
    },

    // Verification phase
    {
      trigger: {
        agentName: "Orchestrator",
        phase: "verification",
      },
      response: {
        content:
          "The implementation has been verified and is working as expected. The system is ready for use.",
        toolCalls: [],
      },
      priority: 10,
    },

    // Generic fallback for any agent
    {
      trigger: {
        agentName: ".*",
      },
      response: {
        content: "Processing your request...",
        toolCalls: [],
      },
      priority: 1,
    },
  ],
};
