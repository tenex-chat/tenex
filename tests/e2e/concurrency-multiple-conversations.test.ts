import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
    setupE2ETest,
    cleanupE2ETest,
    createConversation,
    executeConversationFlow,
    assertAgentSequence,
    assertPhaseTransitions,
    type E2ETestContext
} from "../test-harness";
import type { MockLLMResponse } from "@/test-utils/mock-llm/types";
import { conversationalLogger } from "@/test-utils/conversational-logger";

describe("E2E: Concurrent Multiple Conversations", () => {
    let context: E2ETestContext;
    
    beforeEach(async () => {
        context = await setupE2ETest([]);
    });
    
    afterEach(async () => {
        await cleanupE2ETest(context);
    });

    it("should handle multiple simultaneous conversations without interference", async () => {
        conversationalLogger.logTestStart("Concurrent Conversations");
        
        // Define scenarios for conversation A (Authentication)
        const authScenarios: MockLLMResponse[] = [
            // Initial routing for auth
            {
                trigger: {
                    systemPrompt: /You must respond with ONLY a JSON object/,
                    userMessage: /authentication.*User A/i
                },
                response: {
                    content: JSON.stringify({
                        agents: ["planner"],
                        phase: "plan",
                        reason: "User A needs authentication system. Creating plan."
                    })
                },
                priority: 100
            },
            // Planner for auth
            {
                trigger: {
                    agentName: "planner",
                    phase: "plan",
                    userMessage: /User A/i
                },
                response: {
                    content: "Creating authentication plan for User A with JWT tokens and OAuth.",
                    toolCalls: [{
                        id: "auth-1",
                        type: "function",
                        function: {
                            name: "complete",
                            arguments: JSON.stringify({
                                summary: "Authentication plan for User A created"
                            })
                        }
                    }]
                },
                priority: 90
            },
            // Route to executor
            {
                trigger: {
                    systemPrompt: /You must respond with ONLY a JSON object/,
                    previousAgent: "planner",
                    userMessage: /User A/i
                },
                response: {
                    content: JSON.stringify({
                        agents: ["executor"],
                        phase: "execute",
                        reason: "Plan ready for User A. Moving to implementation."
                    })
                },
                priority: 100
            },
            // Executor for auth
            {
                trigger: {
                    agentName: "executor",
                    phase: "execute",
                    userMessage: /User A/i
                },
                response: {
                    content: "Implementing authentication system for User A.",
                    toolCalls: [{
                        id: "auth-2",
                        type: "function",
                        function: {
                            name: "shell",
                            arguments: JSON.stringify({
                                command: "echo 'User A authentication implemented'"
                            })
                        }
                    }, {
                        id: "auth-3",
                        type: "function",
                        function: {
                            name: "complete",
                            arguments: JSON.stringify({
                                summary: "User A authentication implemented"
                            })
                        }
                    }]
                },
                priority: 90
            },
            // Route to verification
            {
                trigger: {
                    systemPrompt: /You must respond with ONLY a JSON object/,
                    previousAgent: "executor",
                    userMessage: /User A/i
                },
                response: {
                    content: JSON.stringify({
                        agents: ["test-pm"],  // Dynamic PM
                        phase: "verify",
                        reason: "User A implementation complete. Verifying."
                    })
                },
                priority: 100
            },
            // Verification for auth
            {
                trigger: {
                    agentName: "test-pm",  // Dynamic PM
                    phase: "verify",
                    userMessage: /User A/i
                },
                response: {
                    content: "User A authentication system verified successfully.",
                    toolCalls: [{
                        id: "auth-4",
                        type: "function",
                        function: {
                            name: "complete",
                            arguments: JSON.stringify({
                                summary: "User A authentication verified"
                            })
                        }
                    }]
                },
                priority: 90
            }
        ];

        // Define scenarios for conversation B (Payment)
        const paymentScenarios: MockLLMResponse[] = [
            // Initial routing for payment
            {
                trigger: {
                    systemPrompt: /You must respond with ONLY a JSON object/,
                    userMessage: /payment.*User B/i
                },
                response: {
                    content: JSON.stringify({
                        agents: ["planner"],
                        phase: "plan",
                        reason: "User B needs payment processing. Creating plan."
                    })
                },
                priority: 100
            },
            // Planner for payment
            {
                trigger: {
                    agentName: "planner",
                    phase: "plan",
                    userMessage: /User B/i
                },
                response: {
                    content: "Creating payment processing plan for User B with Stripe integration.",
                    toolCalls: [{
                        id: "pay-1",
                        type: "function",
                        function: {
                            name: "complete",
                            arguments: JSON.stringify({
                                summary: "Payment plan for User B created"
                            })
                        }
                    }]
                },
                priority: 90
            },
            // Route to executor
            {
                trigger: {
                    systemPrompt: /You must respond with ONLY a JSON object/,
                    previousAgent: "planner",
                    userMessage: /User B/i
                },
                response: {
                    content: JSON.stringify({
                        agents: ["executor"],
                        phase: "execute",
                        reason: "Plan ready for User B. Moving to implementation."
                    })
                },
                priority: 100
            },
            // Executor for payment
            {
                trigger: {
                    agentName: "executor",
                    phase: "execute",
                    userMessage: /User B/i
                },
                response: {
                    content: "Implementing payment processing for User B.",
                    toolCalls: [{
                        id: "pay-2",
                        type: "function",
                        function: {
                            name: "shell",
                            arguments: JSON.stringify({
                                command: "echo 'User B payment system implemented'"
                            })
                        }
                    }, {
                        id: "pay-3",
                        type: "function",
                        function: {
                            name: "complete",
                            arguments: JSON.stringify({
                                summary: "User B payment implemented"
                            })
                        }
                    }]
                },
                priority: 90
            },
            // Route to verification
            {
                trigger: {
                    systemPrompt: /You must respond with ONLY a JSON object/,
                    previousAgent: "executor",
                    userMessage: /User B/i
                },
                response: {
                    content: JSON.stringify({
                        agents: ["test-pm"],  // Dynamic PM
                        phase: "verify",
                        reason: "User B implementation complete. Verifying."
                    })
                },
                priority: 100
            },
            // Verification for payment
            {
                trigger: {
                    agentName: "test-pm",  // Dynamic PM
                    phase: "verify",
                    userMessage: /User B/i
                },
                response: {
                    content: "User B payment system verified successfully.",
                    toolCalls: [{
                        id: "pay-4",
                        type: "function",
                        function: {
                            name: "complete",
                            arguments: JSON.stringify({
                                summary: "User B payment verified"
                            })
                        }
                    }]
                },
                priority: 90
            }
        ];

        // Add all scenarios to mock
        for (const scenario of [...authScenarios, ...paymentScenarios]) {
            context.mockLLM.addResponse(scenario);
        }

        // Create two conversations
        const conversationA = await createConversation(
            context,
            "Authentication System for User A",
            "Please create a user authentication system for User A"
        );
        
        const conversationB = await createConversation(
            context,
            "Payment Processing for User B",
            "Please implement payment processing for User B"
        );

        // Execute both conversations concurrently
        const [traceA, traceB] = await Promise.all([
            executeConversationFlow(
                context,
                conversationA,
                "Please create a user authentication system for User A",
                { maxIterations: 10 }
            ),
            executeConversationFlow(
                context,
                conversationB,
                "Please implement payment processing for User B",
                { maxIterations: 10 }
            )
        ]);

        // Verify conversation A workflow
        assertAgentSequence(traceA, ["planner", "executor", "test-pm"]);
        assertPhaseTransitions(traceA, ["plan", "execute", "verify"]);
        
        // Verify conversation B workflow
        assertAgentSequence(traceB, ["planner", "executor", "test-pm"]);
        assertPhaseTransitions(traceB, ["plan", "execute", "verify"]);

        // Verify conversations didn't interfere with each other
        const historyA = context.mockLLM.getRequestHistory().filter(h => 
            h.messages.some(m => m.content?.includes("User A"))
        );
        const historyB = context.mockLLM.getRequestHistory().filter(h => 
            h.messages.some(m => m.content?.includes("User B"))
        );
        
        expect(historyA.length).toBeGreaterThan(0);
        expect(historyB.length).toBeGreaterThan(0);

        // Verify content isolation
        const authContent = traceA.some(e => e.response?.includes("authentication"));
        const paymentContent = traceB.some(e => e.response?.includes("payment"));
        
        expect(authContent).toBe(true);
        expect(paymentContent).toBe(true);
        
        // Ensure no cross-contamination
        const authHasPayment = traceA.some(e => e.response?.includes("payment"));
        const paymentHasAuth = traceB.some(e => e.response?.includes("authentication"));
        
        expect(authHasPayment).toBe(false);
        expect(paymentHasAuth).toBe(false);
        
        conversationalLogger.logTestEnd(true, "Concurrent Conversations");
    });

    it("should handle rapid-fire conversation creation", async () => {
        conversationalLogger.logTestStart("Rapid-Fire Conversations");
        
        // Define a simple workflow scenario that can be reused
        const simpleWorkflowScenario: MockLLMResponse = {
            trigger: {
                systemPrompt: /You must respond with ONLY a JSON object/
            },
            response: {
                content: JSON.stringify({
                    agents: ["orchestrator"],
                    phase: "chat",
                    reason: "Processing request."
                })
            },
            priority: 50
        };
        
        const orchestratorComplete: MockLLMResponse = {
            trigger: {
                agentName: "orchestrator"
            },
            response: {
                content: "Task completed.",
                toolCalls: [{
                    id: "1",
                    type: "function",
                    function: {
                        name: "complete",
                        arguments: JSON.stringify({
                            summary: "Task done"
                        })
                    }
                }]
            },
            priority: 40
        };

        context.mockLLM.addResponse(simpleWorkflowScenario);
        context.mockLLM.addResponse(orchestratorComplete);

        // Create multiple conversations rapidly
        const conversationPromises = [];
        for (let i = 0; i < 5; i++) {
            conversationPromises.push(
                createConversation(
                    context,
                    `Test Conversation ${i}`,
                    `Test message ${i}`
                )
            );
        }

        const conversationIds = await Promise.all(conversationPromises);
        
        // Execute all conversations concurrently
        const executionPromises = conversationIds.map((id, index) =>
            executeConversationFlow(
                context,
                id,
                `Test message ${index}`,
                { maxIterations: 3 }
            )
        );

        const traces = await Promise.all(executionPromises);
        
        // Verify all conversations completed
        expect(traces.length).toBe(5);
        traces.forEach(trace => {
            expect(trace.length).toBeGreaterThan(0);
            assertAgentSequence(trace, ["orchestrator"]);
        });
        
        conversationalLogger.logTestEnd(true, "Rapid-Fire Conversations");
    });

    it("should handle interleaved execution of multiple conversations", async () => {
        conversationalLogger.logTestStart("Interleaved Execution");
        
        // Define complex interleaved scenarios
        const scenarios: MockLLMResponse[] = [
            // Initial routing for all conversations
            {
                trigger: {
                    systemPrompt: /You must respond with ONLY a JSON object/,
                    userMessage: /feature/i
                },
                response: {
                    content: JSON.stringify({
                        agents: ["planner"],
                        phase: "plan",
                        reason: "Creating plan for feature."
                    })
                },
                priority: 100
            },
            // Planner responses
            {
                trigger: {
                    agentName: "planner",
                    phase: "plan"
                },
                response: {
                    content: "Creating implementation plan.",
                    toolCalls: [{
                        id: "plan-1",
                        type: "function",
                        function: {
                            name: "complete",
                            arguments: JSON.stringify({
                                summary: "Plan created"
                            })
                        }
                    }]
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
                        reason: "Executing plan."
                    })
                },
                priority: 100
            },
            // Executor responses
            {
                trigger: {
                    agentName: "executor",
                    phase: "execute"
                },
                response: {
                    content: "Implementing feature.",
                    toolCalls: [{
                        id: "exec-1",
                        type: "function",
                        function: {
                            name: "complete",
                            arguments: JSON.stringify({
                                summary: "Feature implemented"
                            })
                        }
                    }]
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
                        reason: "Completing workflow."
                    })
                },
                priority: 100
            },
            // Orchestrator complete
            {
                trigger: {
                    agentName: "orchestrator",
                    phase: "execute"
                },
                response: {
                    content: "Workflow completed successfully.",
                    toolCalls: [{
                        id: "orch-1",
                        type: "function",
                        function: {
                            name: "complete",
                            arguments: JSON.stringify({
                                summary: "All done"
                            })
                        }
                    }]
                },
                priority: 90
            }
        ];

        // Add scenarios to mock
        for (const scenario of scenarios) {
            context.mockLLM.addResponse(scenario);
        }

        // Create three conversations
        const conv1 = await createConversation(context, "Feature 1", "Build feature one");
        const conv2 = await createConversation(context, "Feature 2", "Build feature two");
        const conv3 = await createConversation(context, "Feature 3", "Build feature three");

        // Execute conversations with intentional interleaving
        const traces = await Promise.all([
            executeConversationFlow(context, conv1, "Build feature one", { maxIterations: 8 }),
            executeConversationFlow(context, conv2, "Build feature two", { maxIterations: 8 }),
            executeConversationFlow(context, conv3, "Build feature three", { maxIterations: 8 })
        ]);

        // Verify all conversations completed successfully
        expect(traces.length).toBe(3);
        
        traces.forEach((trace, index) => {
            assertAgentSequence(trace, ["planner", "executor", "orchestrator"]);
            assertPhaseTransitions(trace, ["plan", "execute"]);
            
            // Verify each has its own execution context
            expect(trace.length).toBeGreaterThan(0);
        });
        
        conversationalLogger.logTestEnd(true, "Interleaved Execution");
    });
});