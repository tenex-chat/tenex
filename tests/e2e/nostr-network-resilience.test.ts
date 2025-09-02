import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import {
    setupE2ETest,
    cleanupE2ETest,
    createConversation,
    executeConversationFlow,
    assertAgentSequence,
    assertPhaseTransitions,
    type E2ETestContext
} from "@/test-utils/e2e-harness";
import type { MockLLMResponse } from "@/test-utils/mock-llm/types";
import { conversationalLogger } from "@/test-utils/conversational-logger";

// Track network calls for verification
const networkCalls = {
    publish: [] as Array<{ event: any; success: boolean; error?: Error }>,
    connect: [] as Array<{ relay: string; success: boolean }>,
    sign: [] as Array<{ event: any }>
};

// Mock state for controlling network behavior
let failureMode: "none" | "publish" | "intermittent" | "timeout" = "none";
let failureCount = 0;
const MAX_FAILURES = 2; // For intermittent failures

// Mock NDKEvent to simulate network conditions
const mockPublish = mock(async function(this: any) {
    const shouldFail = 
        failureMode === "publish" ||
        (failureMode === "intermittent" && failureCount < MAX_FAILURES) ||
        failureMode === "timeout";
    
    if (shouldFail) {
        failureCount++;
        const error = failureMode === "timeout" 
            ? new Error("Network timeout: Failed to publish event")
            : new Error("Network error: Unable to reach relay");
            
        networkCalls.publish.push({ 
            event: this, 
            success: false, 
            error 
        });
        
        // Simulate timeout delay
        if (failureMode === "timeout") {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        throw error;
    }
    
    // Successful publish
    networkCalls.publish.push({ event: this, success: true });
    
    // Simulate network delay for realistic behavior
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // Set a fake ID to simulate successful publish
    this.id = `test-event-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
});

const mockSign = mock(async function(this: any, signer?: any) {
    networkCalls.sign.push({ event: this });
    // Set basic event properties
    this.sig = "mock-signature";
    this.pubkey = signer?.pubkey || "mock-pubkey";
});

// Mock NDK module
mock.module("@nostr-dev-kit/ndk", () => {
    return {
        NDKEvent: class MockNDKEvent {
            id?: string;
            sig?: string;
            pubkey?: string;
            content?: string;
            tags?: string[][];
            created_at?: number;
            kind?: number;
            
            constructor(ndk?: any, event?: any) {
                if (event) {
                    Object.assign(this, event);
                }
                this.created_at = Math.floor(Date.now() / 1000);
            }
            
            tag(tag: string[]): void {
                if (!this.tags) this.tags = [];
                this.tags.push(tag);
            }
            
            sign = mockSign;
            publish = mockPublish;
        },
        NDK: class MockNDK {
            explicitRelayUrls?: string[];
            
            constructor(options?: any) {
                this.explicitRelayUrls = options?.explicitRelayUrls;
            }
            
            async connect(): Promise<void> {
                networkCalls.connect.push({ 
                    relay: this.explicitRelayUrls?.[0] || "default",
                    success: true 
                });
                // Simulate connection delay
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
    };
});

// Helper functions to control failure modes
const setFailureMode = (mode: typeof failureMode) => {
    failureMode = mode;
    failureCount = 0;
};

const resetFailureMode = () => {
    failureMode = "none";
    failureCount = 0;
};

const clearNetworkCalls = () => {
    networkCalls.publish = [];
    networkCalls.connect = [];
    networkCalls.sign = [];
};

describe("E2E: Nostr Network Resilience", () => {
    let context: E2ETestContext;
    
    beforeEach(async () => {
        // Reset test state
        clearNetworkCalls();
        resetFailureMode();
        
        context = await setupE2ETest([]);
    });
    
    afterEach(async () => {
        resetFailureMode();
        await cleanupE2ETest(context);
    });

    it("should handle network publish failures gracefully", async () => {
        conversationalLogger.logTestStart("Network Publish Failures");
        
        // Define workflow scenarios
        const scenarios: MockLLMResponse[] = [
            // Initial routing
            {
                trigger: {
                    systemPrompt: /You must respond with ONLY a JSON object/,
                    userMessage: /network test/i
                },
                response: {
                    content: JSON.stringify({
                        agents: ["executor"],
                        phase: "execute",
                        reason: "Testing network resilience."
                    })
                },
                priority: 100
            },
            // Executor action
            {
                trigger: {
                    agentName: "executor",
                    phase: "execute"
                },
                response: {
                    content: "Testing network failure handling.",
                    toolCalls: [{
                        id: "1",
                        type: "function",
                        function: {
                            name: "shell",
                            arguments: JSON.stringify({
                                command: "echo 'Network test'"
                            })
                        }
                    }, {
                        id: "2",
                        type: "function",
                        function: {
                            name: "complete",
                            arguments: JSON.stringify({
                                summary: "Network test completed"
                            })
                        }
                    }]
                },
                priority: 90
            },
            // Orchestrator completion
            {
                trigger: {
                    systemPrompt: /You must respond with ONLY a JSON object/,
                    previousAgent: "executor"
                },
                response: {
                    content: JSON.stringify({
                        agents: ["orchestrator"],
                        phase: "execute",
                        reason: "Test completed."
                    })
                },
                priority: 100
            },
            {
                trigger: {
                    agentName: "orchestrator"
                },
                response: {
                    content: "Network resilience test completed.",
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
        for (const scenario of scenarios) {
            context.mockLLM.addResponse(scenario);
        }

        // Create conversation
        const conversationId = await createConversation(
            context,
            "Network Test",
            "Test network resilience"
        );

        // Set network to fail on publish
        setFailureMode("publish");

        // Execute workflow - should handle failures gracefully
        const trace = await executeConversationFlow(
            context,
            conversationId,
            "Test network resilience",
            { maxIterations: 5 }
        );

        // Verify workflow completed despite network issues
        assertAgentSequence(trace, ["executor", "orchestrator"]);
        
        // Check that publish attempts were made
        const failedPublishes = networkCalls.publish.filter(p => !p.success);
        expect(failedPublishes.length).toBeGreaterThan(0);
        
        conversationalLogger.logTestEnd(true, "Network Publish Failures");
    });

    it("should recover from intermittent network failures", async () => {
        conversationalLogger.logTestStart("Intermittent Network Failures");
        
        // Define workflow scenarios
        const scenarios: MockLLMResponse[] = [
            // Initial routing
            {
                trigger: {
                    systemPrompt: /You must respond with ONLY a JSON object/,
                    userMessage: /build feature/i
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
            // Planner
            {
                trigger: {
                    agentName: "planner",
                    phase: "plan"
                },
                response: {
                    content: "Creating feature plan.",
                    toolCalls: [{
                        id: "1",
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
            // Executor
            {
                trigger: {
                    agentName: "executor",
                    phase: "execute"
                },
                response: {
                    content: "Implementing feature.",
                    toolCalls: [{
                        id: "2",
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
                        reason: "Completing workflow."
                    })
                },
                priority: 100
            },
            {
                trigger: {
                    agentName: "orchestrator"
                },
                response: {
                    content: "Feature completed.",
                    toolCalls: [{
                        id: "3",
                        type: "function",
                        function: {
                            name: "complete",
                            arguments: JSON.stringify({
                                summary: "Done"
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

        // Create conversation
        const conversationId = await createConversation(
            context,
            "Feature Build",
            "Build new feature"
        );

        // Set intermittent failures (first 2 attempts fail, then succeed)
        setFailureMode("intermittent");

        // Execute workflow
        const trace = await executeConversationFlow(
            context,
            conversationId,
            "Build new feature",
            { maxIterations: 8 }
        );

        // Verify workflow completed with retries
        assertAgentSequence(trace, ["planner", "executor", "orchestrator"]);
        assertPhaseTransitions(trace, ["plan", "execute"]);
        
        // Check that some publishes failed and some succeeded
        const failedPublishes = networkCalls.publish.filter(p => !p.success);
        const successfulPublishes = networkCalls.publish.filter(p => p.success);
        
        expect(failedPublishes.length).toBe(MAX_FAILURES);
        expect(successfulPublishes.length).toBeGreaterThan(0);
        
        conversationalLogger.logTestEnd(true, "Intermittent Network Failures");
    });

    it("should handle network timeouts", async () => {
        conversationalLogger.logTestStart("Network Timeouts");
        
        // Define simple workflow
        const scenarios: MockLLMResponse[] = [
            {
                trigger: {
                    systemPrompt: /You must respond with ONLY a JSON object/,
                    userMessage: /quick task/i
                },
                response: {
                    content: JSON.stringify({
                        agents: ["orchestrator"],
                        phase: "chat",
                        reason: "Handling quick task."
                    })
                },
                priority: 100
            },
            {
                trigger: {
                    agentName: "orchestrator"
                },
                response: {
                    content: "Quick task completed.",
                    toolCalls: [{
                        id: "1",
                        type: "function",
                        function: {
                            name: "complete",
                            arguments: JSON.stringify({
                                summary: "Task done quickly"
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

        // Create conversation
        const conversationId = await createConversation(
            context,
            "Quick Task",
            "Do a quick task"
        );

        // Set timeout failure mode
        setFailureMode("timeout");

        // Execute workflow with timeout handling
        const startTime = Date.now();
        const trace = await executeConversationFlow(
            context,
            conversationId,
            "Do a quick task",
            { maxIterations: 3 }
        );
        const duration = Date.now() - startTime;

        // Verify workflow attempted despite timeouts
        expect(trace.length).toBeGreaterThan(0);
        
        // Check that timeout errors occurred
        const timeoutErrors = networkCalls.publish.filter(p => 
            p.error?.message.includes("timeout")
        );
        expect(timeoutErrors.length).toBeGreaterThan(0);
        
        // Verify the test didn't hang indefinitely
        expect(duration).toBeLessThan(30000); // Should complete within 30 seconds
        
        conversationalLogger.logTestEnd(true, "Network Timeouts");
    });

    it("should maintain conversation state across network disruptions", async () => {
        conversationalLogger.logTestStart("State Persistence Across Network Issues");
        
        // Define stateful workflow
        const scenarios: MockLLMResponse[] = [
            // Initial routing
            {
                trigger: {
                    systemPrompt: /You must respond with ONLY a JSON object/,
                    userMessage: /stateful task/i
                },
                response: {
                    content: JSON.stringify({
                        agents: ["planner"],
                        phase: "plan",
                        reason: "Starting stateful task."
                    })
                },
                priority: 100
            },
            // Planner creates state
            {
                trigger: {
                    agentName: "planner",
                    phase: "plan"
                },
                response: {
                    content: "Creating plan with important state: Project ID = ABC123, User = TestUser",
                    toolCalls: [{
                        id: "1",
                        type: "function",
                        function: {
                            name: "writeContextFile",
                            arguments: JSON.stringify({
                                filename: "state.json",
                                content: JSON.stringify({
                                    projectId: "ABC123",
                                    user: "TestUser",
                                    timestamp: Date.now()
                                })
                            })
                        }
                    }, {
                        id: "2",
                        type: "function",
                        function: {
                            name: "complete",
                            arguments: JSON.stringify({
                                summary: "State initialized"
                            })
                        }
                    }]
                },
                priority: 90
            },
            // Route after network disruption
            {
                trigger: {
                    systemPrompt: /You must respond with ONLY a JSON object/,
                    previousAgent: "planner"
                },
                response: {
                    content: JSON.stringify({
                        agents: ["executor"],
                        phase: "execute",
                        reason: "Continuing with saved state."
                    })
                },
                priority: 100
            },
            // Executor uses state
            {
                trigger: {
                    agentName: "executor",
                    phase: "execute"
                },
                response: {
                    content: "Using saved state: Project ABC123 for TestUser",
                    toolCalls: [{
                        id: "3",
                        type: "function",
                        function: {
                            name: "shell",
                            arguments: JSON.stringify({
                                command: "echo 'Processing project ABC123'"
                            })
                        }
                    }, {
                        id: "4",
                        type: "function",
                        function: {
                            name: "complete",
                            arguments: JSON.stringify({
                                summary: "Stateful task completed"
                            })
                        }
                    }]
                },
                priority: 90
            },
            // Final completion
            {
                trigger: {
                    systemPrompt: /You must respond with ONLY a JSON object/,
                    previousAgent: "executor"
                },
                response: {
                    content: JSON.stringify({
                        agents: ["test-pm"],  // Dynamic PM
                        phase: "verify",
                        reason: "Verifying stateful execution."
                    })
                },
                priority: 100
            },
            {
                trigger: {
                    agentName: "test-pm",  // Dynamic PM
                    phase: "verify"
                },
                response: {
                    content: "Verified: State maintained correctly throughout workflow",
                    toolCalls: [{
                        id: "5",
                        type: "function",
                        function: {
                            name: "complete",
                            arguments: JSON.stringify({
                                summary: "State verified"
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

        // Create conversation
        const conversationId = await createConversation(
            context,
            "Stateful Task",
            "Execute stateful task"
        );

        // Start with normal network
        resetFailureMode();
        
        // Execute workflow with network disruption midway
        // We'll simulate this by changing failure mode during execution
        setTimeout(() => {
            setFailureMode("intermittent");
        }, 500);
        
        setTimeout(() => {
            resetFailureMode();
        }, 2000);

        const trace = await executeConversationFlow(
            context,
            conversationId,
            "Execute stateful task",
            { maxIterations: 10 }
        );

        // Verify state was maintained
        assertAgentSequence(trace, ["planner", "executor", "test-pm"]);
        assertPhaseTransitions(trace, ["plan", "execute", "verify"]);
        
        // Check that state references are consistent
        const stateReferences = trace.filter(e => 
            e.response?.includes("ABC123") || e.response?.includes("TestUser")
        );
        expect(stateReferences.length).toBeGreaterThan(1);
        
        conversationalLogger.logTestEnd(true, "State Persistence Across Network Issues");
    });
});