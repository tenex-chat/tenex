import type { MockLLMScenario } from "../types";

/**
 * Performance testing scenarios that simulate slow responses, timeouts, and system stress
 */
export const performanceTestingScenario: MockLLMScenario = {
    name: "performance-testing",
    description: "Scenarios for testing system performance, timeouts, and stress conditions",
    responses: [
        // Scenario: Slow LLM response during orchestration
        {
            trigger: {
                agentName: "orchestrator",
                phase: "CHAT",
                userMessage: /performance.*test.*slow/i,
            },
            response: {
                streamDelay: 5000, // 5 second delay
                content: JSON.stringify({
                    agents: ["planner"],
                    phase: "PLAN",
                    reason: "Setting up performance test with intentional delays"
                }),
            },
            priority: 15,
        },

        // Scenario: Very slow planning phase
        {
            trigger: {
                agentName: "orchestrator",
                phase: "PLAN",
                userMessage: /performance test/,
            },
            response: {
                streamDelay: 8000, // 8 second delay
                content: JSON.stringify({
                    agents: ["executor"],
                    phase: "EXECUTE",
                    reason: "Plan created with multiple delayed operations"
                }),
            },
            priority: 15,
        },

        // Scenario: Timeout simulation (exceeds typical timeout)
        {
            trigger: {
                agentName: "executor",
                phase: "EXECUTE",
                userMessage: /timeout test/,
            },
            response: {
                streamDelay: 35000, // 35 second delay (should trigger timeout)
                content: "This response will be delayed beyond the typical timeout threshold...",
                toolCalls: [],
            },
            priority: 20,
        },

        // Scenario: Slow tool execution
        {
            trigger: {
                agentName: "executor",
                previousToolCalls: ["shell"],
                userMessage: /slow tool test/,
            },
            response: {
                streamDelay: 3000, // 3 second delay for tool response
                content: "The tool execution is taking longer than expected...",
                toolCalls: [
                    {
                        id: "4",
                        type: "function",
                        function: {
                            name: "complete",
                            arguments: JSON.stringify({
                                summary: "Completed slow tool execution",
                                details: ["Tool executed with 3 second delay"],
                            }),
                        },
                    },
                ],
            },
            priority: 15,
        },

        // Scenario: Rapid sequential requests (stress test)
        {
            trigger: {
                agentName: "orchestrator",
                userMessage: /stress test rapid/,
            },
            response: {
                streamDelay: 50, // Very short delay
                content: JSON.stringify({
                    agents: ["executor"],
                    phase: "EXECUTE",
                    reason: "Handling rapid sequential requests"
                }),
            },
            priority: 15,
        },

        // Scenario: Memory-intensive response
        {
            trigger: {
                agentName: "executor",
                userMessage: /large response test/,
            },
            response: {
                streamDelay: 2000,
                // Generate a large response to test memory handling
                content: "Large response data: " + "x".repeat(50000), // 50KB of data
                toolCalls: [
                    {
                        id: "6",
                        type: "function",
                        function: {
                            name: "complete",
                            arguments: JSON.stringify({
                                summary: "Processed large data response",
                                details: ["Generated 50KB response"],
                            }),
                        },
                    },
                ],
            },
            priority: 15,
        },

        // Scenario: Recovery after timeout
        {
            trigger: {
                agentName: "orchestrator",
                userMessage: /retry after timeout/,
            },
            response: {
                streamDelay: 100, // Quick response after timeout
                content: JSON.stringify({
                    agents: ["executor"],
                    phase: "VERIFICATION",
                    reason: "Successfully recovered from timeout"
                }),
            },
            priority: 20,
        },
        // Performance test initial response
        {
            trigger: {
                agentName: "orchestrator",
                userMessage: /performance test/,
            },
            response: {
                streamDelay: 1000,
                content: JSON.stringify({
                    agents: ["planner"],
                    phase: "PLAN",
                    reason: "Starting performance test workflow"
                }),
            },
            priority: 10,
        },
    ],
};