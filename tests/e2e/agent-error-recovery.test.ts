import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { ConversationManager } from "@/conversations";
import { AgentExecutor } from "@/agents/execution/AgentExecutor";
import type { ExecutionContext } from "@/agents/types";
import { createMockLLMService, MockLLMService } from "@/test-utils/mock-llm";
import { createTempDir, cleanupTempDir } from "@/test-utils";
import type { NostrEvent } from "nostr-tools";

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
            agentName: "Executor",
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
            agentName: "Executor",
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
            agentName: "Orchestrator",
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
            agentName: "Planner",
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
            agentName: "Orchestrator",
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

describe("Agent Error Recovery E2E Tests", () => {
    let mockLLM: MockLLMService;
    let testDir: string;
    let projectPath: string;
    let conversationManager: ConversationManager;

    beforeEach(async () => {
        // Create temp directory
        testDir = await createTempDir("agent-error-test-");
        projectPath = path.join(testDir, "test-project");

        // Create test configuration
        await Bun.write(
            path.join(projectPath, "tenex.json"),
            JSON.stringify({
                projectName: "error-recovery-test",
                agentModel: "test-model"
            })
        );

        // Initialize services
        conversationManager = new ConversationManager(projectPath);
    });

    afterEach(async () => {
        // Clean up temp directory
        await cleanupTempDir(testDir);
    });

    it("should recover from tool execution errors", async () => {
        // Create mock LLM with error recovery scenarios
        mockLLM = createMockLLMService([{
            name: "error-recovery",
            description: "Test error recovery",
            responses: errorRecoveryResponses
        }]);

        // Create test event
        const event: NostrEvent = {
            id: "test-error-recovery",
            pubkey: "test-pubkey",
            created_at: Date.now(),
            kind: 1,
            tags: [],
            content: "Test error recovery mechanisms",
            sig: "test-sig"
        };

        // Create conversation
        const conversation = await conversationManager.createConversation(event);
        expect(conversation).toBeDefined();

        // Create execution context
        const executionContext: ExecutionContext = {
            conversation,
            projectPath,
            llmService: mockLLM
        };

        // Execute the workflow
        const executor = new AgentExecutor(executionContext);
        await executor.execute();

        // Verify the conversation completed successfully despite errors
        expect(conversation.phase).toBe("COMPLETED");
        expect(conversation.completedAt).toBeDefined();

        // Verify error recovery happened
        const history = mockLLM.getRequestHistory();
        
        // Should have recovery responses triggered
        const recoveryResponses = history.filter(h => 
            h.response.content?.includes("failed") || 
            h.response.content?.includes("error") ||
            h.response.content?.includes("Recovered")
        );
        expect(recoveryResponses.length).toBeGreaterThan(0);

        // Verify phase transitions show recovery
        const transitions = conversation.phaseTransitions;
        expect(transitions).toContainEqual(
            expect.objectContaining({
                from: "PLAN",
                to: "EXECUTE",
                reason: expect.stringContaining("Recovered from error")
            })
        );

        // Final response should indicate successful recovery
        const lastMessage = conversation.messages[conversation.messages.length - 1];
        expect(lastMessage.content).toContain("error recovery");
        expect(lastMessage.content).toContain("Handled failures gracefully");
    });

    it("should detect and handle infinite loops", async () => {
        // Create mock LLM with infinite loop scenarios
        mockLLM = createMockLLMService([{
            name: "infinite-loop",
            description: "Test infinite loop detection",
            responses: infiniteLoopResponses
        }]);

        // Create test event
        const event: NostrEvent = {
            id: "test-infinite-loop",
            pubkey: "test-pubkey",
            created_at: Date.now(),
            kind: 1,
            tags: [],
            content: "Test infinite loop detection",
            sig: "test-sig"
        };

        // Create conversation
        const conversation = await conversationManager.createConversation(event);

        // Create execution context with loop detection
        const executionContext: ExecutionContext = {
            conversation,
            projectPath,
            llmService: mockLLM,
            maxIterations: 5 // Limit iterations to detect loops quickly
        };

        // Execute the workflow
        const executor = new AgentExecutor(executionContext);
        
        // Should complete (not hang) due to loop detection
        await executor.execute();

        // Verify loop was detected
        expect(conversation.phase).toBe("ERROR");
        
        // Should have error message about too many iterations
        const errorMessage = conversation.messages.find(m => 
            m.content.includes("iterations") || 
            m.content.includes("loop")
        );
        expect(errorMessage).toBeDefined();
    });

    it("should handle agent timeouts gracefully", async () => {
        // Create mock LLM with timeout scenario
        const timeoutMockLLM = createMockLLMService([{
            name: "timeout-test",
            description: "Test timeout handling",
            responses: timeoutResponses
        }], {
            timeout: 1000 // 1 second timeout for testing
        });

        // Create test event
        const event: NostrEvent = {
            id: "test-timeout",
            pubkey: "test-pubkey",
            created_at: Date.now(),
            kind: 1,
            tags: [],
            content: "Test timeout handling",
            sig: "test-sig"
        };

        // Create conversation
        const conversation = await conversationManager.createConversation(event);

        // Create execution context
        const executionContext: ExecutionContext = {
            conversation,
            projectPath,
            llmService: timeoutMockLLM
        };

        // Execute the workflow with timeout
        const executor = new AgentExecutor(executionContext);
        
        // Should handle timeout gracefully
        await expect(executor.execute()).resolves.not.toThrow();

        // Verify timeout was handled
        expect(conversation.phase).toBe("ERROR");
        
        // Should have timeout error message
        const timeoutMessage = conversation.messages.find(m => 
            m.content.includes("timeout") || 
            m.content.includes("timed out")
        );
        expect(timeoutMessage).toBeDefined();
    });

    it("should maintain conversation state through multiple errors", async () => {
        // Create complex scenario with multiple error types
        const complexResponses = [
            ...errorRecoveryResponses,
            // Add a scenario where verification fails
            {
                trigger: {
                    agentName: "Executor",
                    phase: "EXECUTE",
                    messageCount: 10 // After some messages
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
            },
            {
                trigger: {
                    agentName: "Executor",
                    phase: "VERIFICATION"
                },
                response: {
                    content: "Verification check failed. Need to retry.",
                    toolCalls: [{
                        id: "7",
                        type: "function",
                        function: {
                            name: "continue",
                            arguments: JSON.stringify({
                                summary: "Verification failed, retrying",
                                suggestedPhase: "EXECUTE"
                            })
                        }
                    }]
                },
                priority: 10
            }
        ];

        mockLLM = createMockLLMService([{
            name: "complex-errors",
            description: "Test multiple error types",
            responses: complexResponses
        }]);

        const event: NostrEvent = {
            id: "test-complex-errors",
            pubkey: "test-pubkey",
            created_at: Date.now(),
            kind: 1,
            tags: [],
            content: "Test error recovery with multiple failures",
            sig: "test-sig"
        };

        const conversation = await conversationManager.createConversation(event);
        const executionContext: ExecutionContext = {
            conversation,
            projectPath,
            llmService: mockLLM
        };

        const executor = new AgentExecutor(executionContext);
        await executor.execute();

        // Should have gone through multiple phases despite errors
        const uniquePhases = new Set(conversation.phaseTransitions.map(t => t.to));
        expect(uniquePhases.size).toBeGreaterThan(3);

        // Conversation state should be preserved
        expect(conversation.messages.length).toBeGreaterThan(5);
        expect(conversation.id).toBe("test-complex-errors");
        expect(conversation.projectPath).toBe(projectPath);
    });

    it("should handle errors in different agent types", async () => {
        // Test errors in orchestrator, planner, and executor
        const multiAgentErrorResponses = [
            // Orchestrator error
            {
                trigger: {
                    agentName: "Orchestrator",
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
                    agentName: "Orchestrator",
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
            },
            // Planner with malformed JSON
            {
                trigger: {
                    agentName: "Planner",
                    phase: "PLAN"
                },
                response: {
                    content: "Creating plan with bad JSON.",
                    toolCalls: [{
                        id: "3",
                        type: "function",
                        function: {
                            name: "continue",
                            arguments: "{ invalid json" // Malformed JSON
                        }
                    }]
                },
                priority: 10
            },
            // Recovery from JSON error
            {
                trigger: {
                    agentName: "Planner",
                    phase: "PLAN",
                    previousToolCalls: ["continue"]
                },
                response: {
                    content: "Fixed the JSON error.",
                    toolCalls: [{
                        id: "4",
                        type: "function",
                        function: {
                            name: "complete",
                            arguments: JSON.stringify({
                                finalResponse: "Recovered from errors in multiple agents."
                            })
                        }
                    }]
                },
                priority: 15
            }
        ];

        mockLLM = createMockLLMService([{
            name: "multi-agent-errors",
            description: "Test errors in different agents",
            responses: multiAgentErrorResponses
        }]);

        const event: NostrEvent = {
            id: "test-multi-agent-error",
            pubkey: "test-pubkey",
            created_at: Date.now(),
            kind: 1,
            tags: [],
            content: "Test multi agent error handling",
            sig: "test-sig"
        };

        const conversation = await conversationManager.createConversation(event);
        const executionContext: ExecutionContext = {
            conversation,
            projectPath,
            llmService: mockLLM
        };

        const executor = new AgentExecutor(executionContext);
        await executor.execute();

        // Should complete successfully
        expect(conversation.phase).toBe("COMPLETED");

        // Verify different agents handled errors
        const history = mockLLM.getRequestHistory();
        const agentsWithRecovery = new Set(
            history
                .filter(h => 
                    h.response.content?.includes("error") || 
                    h.response.content?.includes("Recovered")
                )
                .map(h => h.request.messages.find(m => m.role === "system")?.content?.match(/Agent Name: (\w+)/)?.[1])
                .filter(Boolean)
        );
        expect(agentsWithRecovery.size).toBeGreaterThan(1);
    });
});