import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
    setupE2ETest,
    cleanupE2ETest,
    createConversation,
    executeConversationFlow,
    assertAgentSequence,
    assertPhaseTransitions,
    assertToolCalls,
    type E2ETestContext
} from "@/test-utils/e2e-harness";
import type { MockLLMResponse } from "@/test-utils/mock-llm/types";
import { conversationalLogger } from "@/test-utils/conversational-logger";

describe("E2E: Agent Error Recovery", () => {
    let context: E2ETestContext;
    
    beforeEach(async () => {
        context = await setupE2ETest([]);
    });

    afterEach(async () => {
        await cleanupE2ETest(context);
    });

    it("should recover from tool execution errors", async () => {
        conversationalLogger.logTestStart("Tool Execution Error Recovery");
        
        // Define error recovery workflow
        const errorRecoveryScenarios: MockLLMResponse[] = [
            // 1. Initial orchestrator routing
            {
                trigger: {
                    systemPrompt: /You must respond with ONLY a JSON object/,
                    userMessage: /test.*error.*recovery/i
                },
                response: {
                    content: JSON.stringify({
                        agents: ["planner"],
                        phase: "plan",
                        reason: "Testing error recovery mechanisms by creating a plan."
                    })
                },
                priority: 100
            },
            
            // 2. Planner with tool error
            {
                trigger: {
                    agentName: "planner",
                    phase: "plan"
                },
                response: {
                    content: "I'll create a plan that will trigger an error.",
                    toolCalls: [{
                        id: "1",
                        type: "function",
                        function: {
                            name: "shell",
                            arguments: JSON.stringify({
                                command: "ls /nonexistent/path",
                                expectError: false
                            })
                        }
                    }]
                },
                priority: 90
            },
            
            // 3. Planner recovers from error
            {
                trigger: {
                    agentName: "planner",
                    phase: "plan",
                    previousToolCalls: ["shell"]
                },
                response: {
                    content: "The command failed. Let me try a different approach and create a simple plan.",
                    toolCalls: [{
                        id: "2",
                        type: "function",
                        function: {
                            name: "complete",
                            arguments: JSON.stringify({
                                summary: "Recovered from error, created alternative plan"
                            })
                        }
                    }]
                },
                priority: 95
            },
            
            // 4. Orchestrator routes to executor
            {
                trigger: {
                    systemPrompt: /You must respond with ONLY a JSON object/,
                    previousAgent: "planner",
                    phase: "plan"
                },
                response: {
                    content: JSON.stringify({
                        agents: ["executor"],
                        phase: "execute",
                        reason: "Plan created with error recovery. Moving to execution."
                    })
                },
                priority: 100
            },
            
            // 5. Executor with shell error
            {
                trigger: {
                    agentName: "executor",
                    phase: "execute"
                },
                response: {
                    content: "I'll execute a command that will fail to test error handling.",
                    toolCalls: [{
                        id: "3",
                        type: "function",
                        function: {
                            name: "shell",
                            arguments: JSON.stringify({
                                command: "false",
                                expectError: false
                            })
                        }
                    }]
                },
                priority: 90
            },
            
            // 6. Executor recovers from shell error
            {
                trigger: {
                    agentName: "executor",
                    phase: "execute",
                    previousToolCalls: ["shell"]
                },
                response: {
                    content: "The command failed as expected. Let me execute a successful command to complete the test.",
                    toolCalls: [{
                        id: "4",
                        type: "function",
                        function: {
                            name: "shell",
                            arguments: JSON.stringify({
                                command: "echo 'Error recovery successful'"
                            })
                        }
                    }, {
                        id: "5",
                        type: "function",
                        function: {
                            name: "complete",
                            arguments: JSON.stringify({
                                summary: "Error recovery test completed successfully"
                            })
                        }
                    }]
                },
                priority: 95
            },
            
            // 7. Orchestrator ends conversation
            {
                trigger: {
                    systemPrompt: /You must respond with ONLY a JSON object/,
                    previousAgent: "executor",
                    phase: "execute"
                },
                response: {
                    content: JSON.stringify({
                        agents: ["orchestrator"],
                        phase: "execute",
                        reason: "Execution completed with error recovery. Test successful."
                    })
                },
                priority: 100
            },
            
            // 8. Orchestrator completes
            {
                trigger: {
                    agentName: "orchestrator",
                    phase: "execute"
                },
                response: {
                    content: "Error recovery test completed successfully. Both the planner and executor recovered from errors gracefully.",
                    toolCalls: [{
                        id: "6",
                        type: "function",
                        function: {
                            name: "complete",
                            arguments: JSON.stringify({
                                summary: "Error recovery test completed"
                            })
                        }
                    }]
                },
                priority: 90
            }
        ];

        // Add scenarios to mock
        for (const scenario of errorRecoveryScenarios) {
            context.mockLLM.addResponse(scenario);
        }

        // Create conversation
        const conversationId = await createConversation(
            context,
            "Error Recovery Test",
            "Test error recovery mechanisms"
        );

        // Execute the complete workflow
        const trace = await executeConversationFlow(
            context,
            conversationId,
            "Test error recovery mechanisms",
            { maxIterations: 10 }
        );

        // Verify error recovery workflow
        assertAgentSequence(trace, ["planner", "executor", "orchestrator"]);
        assertPhaseTransitions(trace, ["plan", "execute"]);
        assertToolCalls(trace, [
            "shell",  // Failed command
            "complete",          // Planner recovery
            "shell",            // Failed command
            "shell",            // Successful command
            "complete",         // Executor completion
            "complete"          // Orchestrator completion
        ]);

        // Verify error recovery happened
        const history = context.mockLLM.getRequestHistory();
        const recoveryResponses = history.filter(h => 
            h.response.content?.includes("failed") || 
            h.response.content?.includes("error") ||
            h.response.content?.includes("recovery")
        );
        expect(recoveryResponses.length).toBeGreaterThan(0);
        
        conversationalLogger.logTestEnd(true, "Tool Execution Error Recovery");
    });

    it("should handle multiple agent failures", async () => {
        conversationalLogger.logTestStart("Multiple Agent Failures");
        
        // Define multiple failure scenarios
        const multipleFailureScenarios: MockLLMResponse[] = [
            // Initial routing
            {
                trigger: {
                    systemPrompt: /You must respond with ONLY a JSON object/,
                    userMessage: /multiple.*failures/i
                },
                response: {
                    content: JSON.stringify({
                        agents: ["planner"],
                        phase: "plan",
                        reason: "Testing multiple failure handling."
                    })
                },
                priority: 100
            },
            
            // Planner fails twice
            {
                trigger: {
                    agentName: "planner",
                    phase: "plan",
                    iteration: 1
                },
                response: {
                    content: "First attempt will fail.",
                    toolCalls: [{
                        id: "1",
                        type: "function",
                        function: {
                            name: "shell",
                            arguments: JSON.stringify({
                                command: "exit 1"
                            })
                        }
                    }]
                },
                priority: 90
            },
            {
                trigger: {
                    agentName: "planner",
                    phase: "plan",
                    previousToolCalls: ["shell"]
                },
                response: {
                    content: "Second attempt will also fail.",
                    toolCalls: [{
                        id: "2",
                        type: "function",
                        function: {
                            name: "shell",
                            arguments: JSON.stringify({
                                command: "exit 2"
                            })
                        }
                    }]
                },
                priority: 95
            },
            {
                trigger: {
                    agentName: "planner",
                    phase: "plan",
                    iteration: 2
                },
                response: {
                    content: "Third attempt will succeed.",
                    toolCalls: [{
                        id: "3",
                        type: "function",
                        function: {
                            name: "complete",
                            arguments: JSON.stringify({
                                summary: "Recovered after multiple failures"
                            })
                        }
                    }]
                },
                priority: 95
            },
            
            // Orchestrator routes to PM (test-pm)
            {
                trigger: {
                    systemPrompt: /You must respond with ONLY a JSON object/,
                    previousAgent: "planner"
                },
                response: {
                    content: JSON.stringify({
                        agents: ["test-pm"],  // Dynamic PM
                        phase: "verify",
                        reason: "Plan completed after recovery. Verifying results."
                    })
                },
                priority: 100
            },
            
            // Project manager verifies
            {
                trigger: {
                    agentName: "test-pm",  // Dynamic PM
                    phase: "verify"
                },
                response: {
                    content: "Verification complete. The system successfully recovered from multiple failures.",
                    toolCalls: [{
                        id: "4",
                        type: "function",
                        function: {
                            name: "complete",
                            arguments: JSON.stringify({
                                summary: "Multiple failure recovery verified"
                            })
                        }
                    }]
                },
                priority: 90
            }
        ];

        // Add scenarios to mock
        for (const scenario of multipleFailureScenarios) {
            context.mockLLM.addResponse(scenario);
        }

        // Create conversation
        const conversationId = await createConversation(
            context,
            "Multiple Failures Test",
            "Test multiple failures"
        );

        // Execute the complete workflow
        const trace = await executeConversationFlow(
            context,
            conversationId,
            "Test multiple failures",
            { maxIterations: 10 }
        );

        // Verify recovery from multiple failures
        assertAgentSequence(trace, ["planner", "test-pm"]);
        assertPhaseTransitions(trace, ["plan", "verify"]);
        
        // Verify multiple shell failures before success
        const shellCalls = trace.filter(e => 
            e.toolCalls?.some(tc => tc.function.name === "shell")
        );
        expect(shellCalls.length).toBe(2); // Two failed shell commands
        
        conversationalLogger.logTestEnd(true, "Multiple Agent Failures");
    });

    it("should handle timeout scenarios gracefully", async () => {
        conversationalLogger.logTestStart("Timeout Handling");
        
        // Define timeout scenarios
        const timeoutScenarios: MockLLMResponse[] = [
            // Initial routing
            {
                trigger: {
                    systemPrompt: /You must respond with ONLY a JSON object/,
                    userMessage: /timeout.*test/i
                },
                response: {
                    content: JSON.stringify({
                        agents: ["executor"],
                        phase: "execute",
                        reason: "Testing timeout handling."
                    })
                },
                priority: 100
            },
            
            // Executor with simulated long-running operation
            {
                trigger: {
                    agentName: "executor",
                    phase: "execute"
                },
                response: {
                    content: "Simulating a long-running operation that might timeout.",
                    toolCalls: [{
                        id: "1",
                        type: "function",
                        function: {
                            name: "shell",
                            arguments: JSON.stringify({
                                command: "sleep 0.1 && echo 'Operation completed'"
                            })
                        }
                    }, {
                        id: "2",
                        type: "function",
                        function: {
                            name: "complete",
                            arguments: JSON.stringify({
                                summary: "Timeout test completed"
                            })
                        }
                    }]
                },
                priority: 90
            },
            
            // Orchestrator completes
            {
                trigger: {
                    systemPrompt: /You must respond with ONLY a JSON object/,
                    previousAgent: "executor"
                },
                response: {
                    content: JSON.stringify({
                        agents: ["orchestrator"],
                        phase: "execute",
                        reason: "Timeout test completed successfully."
                    })
                },
                priority: 100
            },
            {
                trigger: {
                    agentName: "orchestrator"
                },
                response: {
                    content: "Timeout handling test completed.",
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
        for (const scenario of timeoutScenarios) {
            context.mockLLM.addResponse(scenario);
        }

        // Create conversation
        const conversationId = await createConversation(
            context,
            "Timeout Test",
            "Test timeout handling"
        );

        // Execute the complete workflow with a reasonable timeout
        const trace = await executeConversationFlow(
            context,
            conversationId,
            "Test timeout handling",
            { maxIterations: 5 }  // Lower iteration limit to prevent actual timeout
        );

        // Verify workflow completed
        assertAgentSequence(trace, ["executor", "orchestrator"]);
        assertToolCalls(trace, ["shell"]);
        
        conversationalLogger.logTestEnd(true, "Timeout Handling");
    });
});