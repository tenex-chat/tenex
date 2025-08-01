import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { 
    setupE2ETest, 
    cleanupE2ETest, 
    createConversation, 
    executeAgent,
    getConversationState,
    e2eAssertions,
    type E2ETestContext 
} from "./test-harness";
import { createMockLLMService } from "@/test-utils/mock-llm";

// Error recovery scenarios
const errorRecoveryResponses = [
    // Initial chat phase
    {
        trigger: {
            agentName: "Orchestrator",
            phase: "CHAT",
            userMessage: /test.*error.*recovery/i
        },
        response: {
            content: "I'll help test error recovery mechanisms.",
            toolCalls: [{
                id: "1",
                type: "function",
                function: {
                    name: "continue",
                    arguments: JSON.stringify({
                        summary: "Testing error recovery",
                        suggestedPhase: "PLAN"
                    })
                }
            }]
        },
        priority: 10
    },
    // Plan phase with tool error
    {
        trigger: {
            agentName: "Planner",
            phase: "PLAN",
            previousToolCalls: ["continue"]
        },
        response: {
            content: "I'll create a plan that will trigger an error.",
            toolCalls: [{
                id: "2",
                type: "function",
                function: {
                    name: "generateInventory",
                    arguments: JSON.stringify({
                        paths: ["/nonexistent/path"]
                    })
                }
            }]
        },
        priority: 10
    },
    // Recovery from tool error
    {
        trigger: {
            agentName: "Planner",
            phase: "PLAN",
            previousToolCalls: ["generateInventory"]
        },
        response: {
            content: "The inventory generation failed. Let me try a different approach.",
            toolCalls: [{
                id: "3",
                type: "function",
                function: {
                    name: "continue",
                    arguments: JSON.stringify({
                        summary: "Recovered from error, proceeding with alternative plan",
                        suggestedPhase: "EXECUTE"
                    })
                }
            }]
        },
        priority: 15
    },
    // Execute phase with shell error
    {
        trigger: {
            agentName: "executor",
            phase: "EXECUTE",
            previousToolCalls: ["continue"]
        },
        response: {
            content: "I'll execute a command that will fail.",
            toolCalls: [{
                id: "4",
                type: "function",
                function: {
                    name: "shell",
                    arguments: JSON.stringify({
                        command: "false", // This command always exits with error
                        expectError: false
                    })
                }
            }]
        },
        priority: 10
    },
    // Recovery from shell error
    {
        trigger: {
            agentName: "executor",
            phase: "EXECUTE",
            previousToolCalls: ["shell"]
        },
        response: {
            content: "The command failed. Let me handle this gracefully and complete the task.",
            toolCalls: [{
                id: "5",
                type: "function",
                function: {
                    name: "complete",
                    arguments: JSON.stringify({
                        finalResponse: "Task completed with error recovery. Handled failures gracefully."
                    })
                }
            }]
        },
        priority: 15
    }
];

// Infinite loop detection scenario
const infiniteLoopResponses = [
    {
        trigger: {
            agentName: "orchestrator",
            phase: "CHAT",
            userMessage: /infinite.*loop/i
        },
        response: {
            content: "Starting infinite loop test.",
            toolCalls: [{
                id: "1",
                type: "function",
                function: {
                    name: "continue",
                    arguments: JSON.stringify({
                        summary: "Testing infinite loop detection",
                        suggestedPhase: "PLAN"
                    })
                }
            }]
        },
        priority: 10
    },
    // Planner keeps suggesting PLAN phase (infinite loop)
    {
        trigger: {
            agentName: "planner",
            phase: "PLAN"
        },
        response: {
            content: "I need more planning.",
            toolCalls: [{
                id: "loop",
                type: "function",
                function: {
                    name: "continue",
                    arguments: JSON.stringify({
                        summary: "Need more planning",
                        suggestedPhase: "PLAN" // Loop back to PLAN
                    })
                }
            }]
        },
        priority: 10
    }
];

// Agent timeout scenario
const timeoutResponses = [
    {
        trigger: {
            agentName: "orchestrator",
            phase: "CHAT",
            userMessage: /timeout.*test/i
        },
        response: {
            // Simulate timeout by providing error
            error: new Error("Request timed out")
        },
        priority: 10
    }
];

// Multi-agent error responses
const multiAgentErrorResponses = [
    // Orchestrator error
    {
        trigger: {
            agentName: "orchestrator",
            phase: "CHAT",
            userMessage: /multi.*agent.*error/i
        },
        response: {
            content: "Testing multi-agent errors.",
            toolCalls: [{
                id: "1",
                type: "function",
                function: {
                    name: "invalidTool", // This tool doesn't exist
                    arguments: "{}"
                }
            }]
        },
        priority: 10
    },
    // Recovery in orchestrator
    {
        trigger: {
            agentName: "orchestrator",
            phase: "CHAT",
            previousToolCalls: ["invalidTool"]
        },
        response: {
            content: "Let me use a valid tool instead.",
            toolCalls: [{
                id: "2",
                type: "function",
                function: {
                    name: "continue",
                    arguments: JSON.stringify({
                        summary: "Recovered from invalid tool error",
                        suggestedPhase: "PLAN"
                    })
                }
            }]
        },
        priority: 15
    }
];

describe("Agent Error Recovery E2E Tests", () => {
    let context: E2ETestContext;

    beforeEach(async () => {
        // Setup E2E test environment with routing decisions always included
        context = await setupE2ETest(["routing-decisions"]);
    });

    afterEach(async () => {
        await cleanupE2ETest(context);
    });

    it("should recover from tool execution errors", async () => {
        // Add error recovery scenarios to existing mock
        for (const response of errorRecoveryResponses) {
            context.mockLLM.addResponse(response);
        }

        // Create conversation
        const conversationId = await createConversation(
            context,
            "Error Recovery Test",
            "Test error recovery mechanisms"
        );

        // Execute Orchestrator to start the workflow
        await executeAgent(
            context,
            "orchestrator",
            conversationId,
            "Test error recovery mechanisms"
        );

        // Get conversation state
        const state = await getConversationState(context, conversationId);
        
        // Verify workflow progressed despite errors
        expect(state.phase).toBe("PLAN");
        expect(state.phaseTransitions.length).toBeGreaterThan(0);

        // Execute Planner with tool error
        await executeAgent(
            context,
            "planner",
            conversationId,
            "Create a plan"
        );

        // Verify error recovery happened
        const history = context.mockLLM.getRequestHistory();
        
        // Should have recovery responses triggered
        const recoveryResponses = history.filter(h => 
            h.response.content?.includes("failed") || 
            h.response.content?.includes("error") ||
            h.response.content?.includes("Recovered")
        );
        expect(recoveryResponses.length).toBeGreaterThan(0);

        // Verify proper tool call sequence with recovery
        e2eAssertions.toHaveToolCallSequence(context.mockLLM, [
            "continue",           // Initial routing
            "generateInventory",  // Failed tool
            "continue"           // Recovery action
        ]);
    });

    it("should detect and handle infinite loops", async () => {
        // Add infinite loop scenarios to existing mock
        for (const response of infiniteLoopResponses) {
            context.mockLLM.addResponse(response);
        }

        // Create conversation
        const conversationId = await createConversation(
            context,
            "Infinite Loop Test",
            "Test infinite loop detection"
        );

        // Execute workflow which should trigger loop detection
        await executeAgent(
            context,
            "orchestrator",
            conversationId,
            "Test infinite loop detection"
        );

        // Verify proper handling of repeated calls
        const history = context.mockLLM.getRequestHistory();
        const continueCalls = history.filter(h => 
            h.response.toolCalls?.some(tc => tc.function.name === "continue")
        );
        
        // Should detect repetition and stop
        expect(continueCalls.length).toBeGreaterThan(3);
        expect(continueCalls.length).toBeLessThan(10); // Should stop before too many
    });

    it("should handle agent timeouts gracefully", async () => {
        // Add timeout scenarios to existing mock
        for (const response of timeoutResponses) {
            context.mockLLM.addResponse(response);
        }

        // Create conversation
        const conversationId = await createConversation(
            context,
            "Timeout Test",
            "Test timeout handling"
        );

        // Execute with simulated delay
        const errorHandler = {
            errorCaught: false,
            errorMessage: ""
        };

        await executeAgent(
            context,
            "orchestrator",
            conversationId,
            "Test timeout handling",
            {
                onError: (error) => {
                    errorHandler.errorCaught = true;
                    errorHandler.errorMessage = error.message;
                }
            }
        );

        // Should have executed without throwing
        const state = await getConversationState(context, conversationId);
        
        // Verify timeout response was triggered
        const history = context.mockLLM.getRequestHistory();
        const timeoutResponse = history.find(h => 
            h.response.content?.includes("Processing delayed")
        );
        expect(timeoutResponse).toBeDefined();
    });

    it("should maintain conversation state through multiple errors", async () => {
        // Create complex scenario with multiple error types
        const complexResponses = [
            ...errorRecoveryResponses,
            // Add verification failure scenario
            {
                trigger: {
                    agentName: "Executor",
                    phase: "EXECUTE",
                    messageCount: 10
                },
                response: {
                    content: "Triggering verification failure.",
                    toolCalls: [{
                        id: "6",
                        type: "function",
                        function: {
                            name: "continue",
                            arguments: JSON.stringify({
                                summary: "Moving to verification",
                                suggestedPhase: "VERIFICATION"
                            })
                        }
                    }]
                },
                priority: 5
            }
        ];

        // Add complex error scenarios to existing mock
        for (const response of complexResponses) {
            context.mockLLM.addResponse(response);
        }

        // Create conversation
        const conversationId = await createConversation(
            context,
            "Complex Error Test",
            "Test error recovery with multiple failures"
        );

        // Execute multiple agents to trigger various errors
        await executeAgent(context, "orchestrator", conversationId, "Test error recovery with multiple failures");
        
        const state = await getConversationState(context, conversationId);
        
        // Should have multiple phase transitions
        expect(state.phaseTransitions.length).toBeGreaterThan(0);
        
        // Verify error recovery across phases
        const history = context.mockLLM.getRequestHistory();
        const errorResponses = history.filter(h => 
            h.response.content?.includes("error") || 
            h.response.content?.includes("failed")
        );
        expect(errorResponses.length).toBeGreaterThan(1);
    });

    it("should handle errors in different agent types", async () => {
        // Add multi-agent error scenarios to existing mock
        for (const response of multiAgentErrorResponses) {
            context.mockLLM.addResponse(response);
        }

        // Create conversation
        const conversationId = await createConversation(
            context,
            "Multi-Agent Error Test",
            "Test multi agent error handling"
        );

        // Execute and verify error handling
        await executeAgent(
            context,
            "orchestrator",
            conversationId,
            "Test multi agent error handling"
        );

        // Verify error handling across different agents
        const history = context.mockLLM.getRequestHistory();
        const agentNames = new Set(history.map(h => h.request.messages[0]?.content || ""));
        
        // Should have handled errors from multiple agent types
        expect(agentNames.size).toBeGreaterThan(1);
    });
});