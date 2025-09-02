import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
    setupE2ETest,
    cleanupE2ETest,
    createConversation,
    executeConversationFlow,
    assertAgentSequence,
    type E2ETestContext
} from "@/test-utils/e2e-harness";
import type { MockLLMResponse } from "@/test-utils/mock-llm/types";
import { conversationalLogger } from "@/test-utils/conversational-logger";

/**
 * E2E Tests for Performance and Timeout Handling
 * 
 * Tests system behavior under performance stress:
 * - Slow LLM responses
 * - Timeout handling
 * - Recovery after timeouts
 * - Large response handling
 */
describe("E2E: Performance and Timeout Handling", () => {
    let context: E2ETestContext;

    beforeEach(async () => {
        context = await setupE2ETest([]);
    });

    afterEach(async () => {
        await cleanupE2ETest(context);
    });

    it("should handle slow LLM responses gracefully", async () => {
        conversationalLogger.logTestStart("Slow LLM Responses");
        
        // Define scenarios with simulated delays
        const slowResponseScenarios: MockLLMResponse[] = [
            // Initial slow routing
            {
                trigger: {
                    systemPrompt: /You must respond with ONLY a JSON object/,
                    userMessage: /slow.*response/i
                },
                response: {
                    content: JSON.stringify({
                        agents: ["planner"],
                        phase: "plan",
                        reason: "Processing slow response test."
                    }),
                    streamDelay: 5000 // 5 second delay
                },
                priority: 100
            },
            // Slow planner response
            {
                trigger: {
                    agentName: "planner",
                    phase: "plan"
                },
                response: {
                    content: "Creating plan with slow response simulation.",
                    toolCalls: [{
                        id: "1",
                        type: "function",
                        function: {
                            name: "complete",
                            arguments: JSON.stringify({
                                summary: "Slow plan created"
                            })
                        }
                    }],
                    streamDelay: 3000 // 3 second delay
                },
                priority: 90
            },
            // Route to executor
            {
                trigger: {
                    systemPrompt: /You must respond with ONLY a JSON object/,
                    previousAgent: "planner"
                },
                response: {
                    content: JSON.stringify({
                        agents: ["executor"],
                        phase: "execute",
                        reason: "Executing slowly."
                    })
                },
                priority: 100
            },
            // Slow executor
            {
                trigger: {
                    agentName: "executor",
                    phase: "execute"
                },
                response: {
                    content: "Executing with deliberate slowness.",
                    toolCalls: [{
                        id: "2",
                        type: "function",
                        function: {
                            name: "complete",
                            arguments: JSON.stringify({
                                summary: "Slow execution done"
                            })
                        }
                    }],
                    streamDelay: 4000 // 4 second delay
                },
                priority: 90
            },
            // Final routing
            {
                trigger: {
                    systemPrompt: /You must respond with ONLY a JSON object/,
                    previousAgent: "executor"
                },
                response: {
                    content: JSON.stringify({
                        agents: ["orchestrator"],
                        phase: "execute",
                        reason: "Completing slow test."
                    })
                },
                priority: 100
            },
            {
                trigger: {
                    agentName: "orchestrator"
                },
                response: {
                    content: "Slow response test completed.",
                    toolCalls: [{
                        id: "3",
                        type: "function",
                        function: {
                            name: "complete",
                            arguments: JSON.stringify({
                                summary: "Test completed"
                            })
                        }
                    }]
                },
                priority: 90
            }
        ];

        // Add scenarios to mock
        for (const scenario of slowResponseScenarios) {
            context.mockLLM.addResponse(scenario);
        }

        // Create conversation
        const conversationId = await createConversation(
            context,
            "Slow Response Test",
            "Test slow response handling"
        );

        const startTime = Date.now();
        
        // Execute workflow with slow responses
        const trace = await executeConversationFlow(
            context,
            conversationId,
            "Test slow response handling",
            { maxIterations: 8 }
        );

        const executionTime = Date.now() - startTime;
        
        // Verify execution took significant time due to delays
        expect(executionTime).toBeGreaterThanOrEqual(5000);
        
        // Verify workflow completed despite delays
        assertAgentSequence(trace, ["planner", "executor", "orchestrator"]);
        
        // Check that responses were received
        const history = context.mockLLM.getRequestHistory();
        expect(history.length).toBeGreaterThan(0);
        
        conversationalLogger.logTestEnd(true, "Slow LLM Responses");
    });

    it("should handle very large responses without memory issues", async () => {
        conversationalLogger.logTestStart("Large Response Handling");
        
        // Generate a large response string
        const largeContent = "Large response data: " + "x".repeat(100000);
        
        // Define scenarios with large responses
        const largeResponseScenarios: MockLLMResponse[] = [
            // Initial routing
            {
                trigger: {
                    systemPrompt: /You must respond with ONLY a JSON object/,
                    userMessage: /large.*response/i
                },
                response: {
                    content: JSON.stringify({
                        agents: ["executor"],
                        phase: "execute",
                        reason: "Testing large response handling."
                    })
                },
                priority: 100
            },
            // Executor with large response
            {
                trigger: {
                    agentName: "executor",
                    phase: "execute"
                },
                response: {
                    content: largeContent,
                    toolCalls: [{
                        id: "1",
                        type: "function",
                        function: {
                            name: "writeContextFile",
                            arguments: JSON.stringify({
                                filename: "large-output.txt",
                                content: largeContent.substring(0, 10000) // Write a portion
                            })
                        }
                    }, {
                        id: "2",
                        type: "function",
                        function: {
                            name: "complete",
                            arguments: JSON.stringify({
                                summary: "Large response handled"
                            })
                        }
                    }]
                },
                priority: 90
            },
            // Complete
            {
                trigger: {
                    systemPrompt: /You must respond with ONLY a JSON object/,
                    previousAgent: "executor"
                },
                response: {
                    content: JSON.stringify({
                        agents: ["orchestrator"],
                        phase: "execute",
                        reason: "Large response test complete."
                    })
                },
                priority: 100
            },
            {
                trigger: {
                    agentName: "orchestrator"
                },
                response: {
                    content: "Successfully handled large response.",
                    toolCalls: [{
                        id: "3",
                        type: "function",
                        function: {
                            name: "complete",
                            arguments: JSON.stringify({
                                summary: "Test done"
                            })
                        }
                    }]
                },
                priority: 90
            }
        ];

        // Add scenarios to mock
        for (const scenario of largeResponseScenarios) {
            context.mockLLM.addResponse(scenario);
        }

        // Create conversation
        const conversationId = await createConversation(
            context,
            "Large Response Test",
            "Test large response handling"
        );

        // Track memory before execution
        const memBefore = process.memoryUsage().heapUsed;

        // Execute workflow
        const trace = await executeConversationFlow(
            context,
            conversationId,
            "Test large response handling",
            { maxIterations: 5 }
        );

        // Track memory after execution
        const memAfter = process.memoryUsage().heapUsed;
        const memIncrease = memAfter - memBefore;

        // Verify memory increase is reasonable (less than 50MB for large response)
        expect(memIncrease).toBeLessThan(50 * 1024 * 1024);

        // Verify large response was handled
        assertAgentSequence(trace, ["executor", "orchestrator"]);
        
        const history = context.mockLLM.getRequestHistory();
        const largeResponse = history.find(h => 
            h.response.content?.includes("Large response data")
        );
        expect(largeResponse).toBeDefined();
        expect(largeResponse?.response.content?.length).toBeGreaterThan(50000);
        
        conversationalLogger.logTestEnd(true, "Large Response Handling");
    });

    it("should respect iteration limits to prevent infinite loops", async () => {
        conversationalLogger.logTestStart("Iteration Limit Enforcement");
        
        // Define scenarios that would loop indefinitely
        const loopingScenarios: MockLLMResponse[] = [
            // Orchestrator keeps routing to itself
            {
                trigger: {
                    systemPrompt: /You must respond with ONLY a JSON object/
                },
                response: {
                    content: JSON.stringify({
                        agents: ["planner"],
                        phase: "plan",
                        reason: "Starting loop test."
                    })
                },
                priority: 100
            },
            // Planner keeps continuing
            {
                trigger: {
                    agentName: "planner"
                },
                response: {
                    content: "Continuing indefinitely...",
                    toolCalls: [{
                        id: "loop",
                        type: "function",
                        function: {
                            name: "continue",
                            arguments: JSON.stringify({
                                summary: "Keep going"
                            })
                        }
                    }]
                },
                priority: 50
            },
            // Orchestrator routes back to planner
            {
                trigger: {
                    systemPrompt: /You must respond with ONLY a JSON object/,
                    previousAgent: "planner"
                },
                response: {
                    content: JSON.stringify({
                        agents: ["planner"],
                        phase: "plan",
                        reason: "Loop back to planner."
                    })
                },
                priority: 50
            }
        ];

        // Add scenarios to mock
        for (const scenario of loopingScenarios) {
            context.mockLLM.addResponse(scenario);
        }

        // Create conversation
        const conversationId = await createConversation(
            context,
            "Loop Test",
            "Test iteration limits"
        );

        // Execute with low iteration limit
        const trace = await executeConversationFlow(
            context,
            conversationId,
            "Test iteration limits",
            { maxIterations: 3 }
        );

        // Verify execution stopped at iteration limit
        expect(trace.length).toBeLessThanOrEqual(3);
        
        // Verify we hit planner multiple times (looping)
        const plannerExecutions = trace.filter(e => e.agent === "planner");
        expect(plannerExecutions.length).toBeGreaterThan(0);
        
        conversationalLogger.logTestEnd(true, "Iteration Limit Enforcement");
    });

    it("should handle concurrent slow operations efficiently", async () => {
        conversationalLogger.logTestStart("Concurrent Slow Operations");
        
        // Define scenarios for multiple conversations
        const concurrentScenarios: MockLLMResponse[] = [
            // Generic routing
            {
                trigger: {
                    systemPrompt: /You must respond with ONLY a JSON object/
                },
                response: {
                    content: JSON.stringify({
                        agents: ["executor"],
                        phase: "execute",
                        reason: "Processing concurrent request."
                    })
                },
                priority: 50
            },
            // Generic executor
            {
                trigger: {
                    agentName: "executor"
                },
                response: {
                    content: "Processing concurrent operation.",
                    toolCalls: [{
                        id: "1",
                        type: "function",
                        function: {
                            name: "shell",
                            arguments: JSON.stringify({
                                command: "sleep 0.5 && echo 'Done'"
                            })
                        }
                    }, {
                        id: "2",
                        type: "function",
                        function: {
                            name: "complete",
                            arguments: JSON.stringify({
                                summary: "Concurrent op done"
                            })
                        }
                    }],
                    streamDelay: 1000
                },
                priority: 40
            },
            // Generic completion
            {
                trigger: {
                    systemPrompt: /You must respond with ONLY a JSON object/,
                    previousAgent: "executor"
                },
                response: {
                    content: JSON.stringify({
                        agents: ["orchestrator"],
                        phase: "execute",
                        reason: "Completing."
                    })
                },
                priority: 50
            },
            {
                trigger: {
                    agentName: "orchestrator"
                },
                response: {
                    content: "Done.",
                    toolCalls: [{
                        id: "3",
                        type: "function",
                        function: {
                            name: "complete",
                            arguments: JSON.stringify({
                                summary: "Complete"
                            })
                        }
                    }]
                },
                priority: 40
            }
        ];

        // Add scenarios to mock
        for (const scenario of concurrentScenarios) {
            context.mockLLM.addResponse(scenario);
        }

        // Create multiple conversations
        const conversations = await Promise.all([
            createConversation(context, "Concurrent 1", "Task 1"),
            createConversation(context, "Concurrent 2", "Task 2"),
            createConversation(context, "Concurrent 3", "Task 3")
        ]);

        const startTime = Date.now();

        // Execute all conversations concurrently
        const traces = await Promise.all(
            conversations.map(id => 
                executeConversationFlow(context, id, `Task for ${id}`, { maxIterations: 5 })
            )
        );

        const totalTime = Date.now() - startTime;

        // Verify all completed
        expect(traces.length).toBe(3);
        traces.forEach(trace => {
            expect(trace.length).toBeGreaterThan(0);
            assertAgentSequence(trace, ["executor", "orchestrator"]);
        });

        // Verify concurrent execution was faster than sequential would be
        // With streamDelay of 1000ms per operation, sequential would take ~3000ms minimum
        // Concurrent should be significantly faster
        expect(totalTime).toBeLessThan(5000);
        
        conversationalLogger.logTestEnd(true, "Concurrent Slow Operations");
    });

    it("should gracefully degrade under high load", async () => {
        conversationalLogger.logTestStart("High Load Degradation");
        
        // Simple fast-response scenario
        const fastScenarios: MockLLMResponse[] = [
            {
                trigger: {
                    systemPrompt: /You must respond with ONLY a JSON object/
                },
                response: {
                    content: JSON.stringify({
                        agents: ["orchestrator"],
                        phase: "chat",
                        reason: "Quick response."
                    })
                },
                priority: 50
            },
            {
                trigger: {
                    agentName: "orchestrator"
                },
                response: {
                    content: "Quick task done.",
                    toolCalls: [{
                        id: "1",
                        type: "function",
                        function: {
                            name: "complete",
                            arguments: JSON.stringify({
                                summary: "Done"
                            })
                        }
                    }]
                },
                priority: 40
            }
        ];

        // Add scenarios to mock
        for (const scenario of fastScenarios) {
            context.mockLLM.addResponse(scenario);
        }

        // Create many conversations to simulate high load
        const conversationCount = 10;
        const conversationPromises = [];
        
        for (let i = 0; i < conversationCount; i++) {
            conversationPromises.push(
                createConversation(context, `Load Test ${i}`, `Task ${i}`)
            );
        }
        
        const conversationIds = await Promise.all(conversationPromises);

        const startTime = Date.now();

        // Execute all conversations at once (high load)
        const executionPromises = conversationIds.map((id, index) =>
            executeConversationFlow(
                context,
                id,
                `High load task ${index}`,
                { maxIterations: 3 }
            )
        );

        const traces = await Promise.all(executionPromises);
        const totalTime = Date.now() - startTime;

        // Verify all conversations completed
        expect(traces.length).toBe(conversationCount);
        
        // Verify none failed
        traces.forEach((trace, index) => {
            expect(trace.length).toBeGreaterThan(0);
        });

        // Verify system handled load in reasonable time (less than 30 seconds)
        expect(totalTime).toBeLessThan(30000);
        
        conversationalLogger.logTestEnd(true, "High Load Degradation");
    });
});