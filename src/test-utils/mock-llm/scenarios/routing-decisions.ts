import type { MockLLMScenario } from "../types";

/**
 * Mock responses for orchestrator routing decisions
 */
export const routingDecisions: MockLLMScenario = {
    name: "routing-decisions",
    description: "Mock routing decisions for orchestrator",
    responses: [
        // Error recovery routing
        {
            trigger: {
                agentName: "orchestrator",
                userMessage: /error.*recovery/i
            },
            response: {
                content: JSON.stringify({
                    agents: ["planner"],
                    phase: "PLAN",
                    reason: "The user wants to test error recovery mechanisms. I should continue the workflow."
                })
            },
            priority: 100
        },
        // Infinite loop routing
        {
            trigger: {
                agentName: "orchestrator",
                userMessage: /infinite.*loop/i
            },
            response: {
                content: JSON.stringify({
                    agents: ["planner"],
                    phase: "PLAN",
                    reason: "Testing infinite loop detection."
                })
            },
            priority: 100
        },
        // Timeout test routing
        {
            trigger: {
                agentName: "orchestrator",
                userMessage: /timeout/i
            },
            response: {
                content: JSON.stringify({
                    agents: ["planner"],
                    phase: "PLAN",
                    reason: "Testing timeout handling."
                })
            },
            priority: 100
        },
        // Multi-agent error routing
        {
            trigger: {
                agentName: "orchestrator",
                userMessage: /multi.*agent.*error/i
            },
            response: {
                content: JSON.stringify({
                    agents: ["planner"],
                    phase: "PLAN",
                    reason: "Testing multi-agent error handling."
                })
            },
            priority: 100
        },
        // Default routing response for any orchestrator message with JSON instruction
        {
            trigger: {
                systemPrompt: /You must respond with ONLY a JSON object/
            },
            response: {
                content: JSON.stringify({
                    agents: ["planner"],
                    phase: "PLAN",
                    reason: "Processing user request."
                })
            },
            priority: 1
        }
    ]
};