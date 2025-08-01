import type { MockLLMScenario } from "../types";

/**
 * Error handling scenarios for testing edge cases and failures
 */
export const errorHandlingScenario: MockLLMScenario = {
    name: "error-handling",
    description: "Test error conditions and recovery",
    responses: [
        // Tool execution failure
        {
            trigger: {
                agentName: "Executor",
                userMessage: /simulate.*error/i
            },
            response: {
                content: "I'll simulate an error condition.",
                toolCalls: [{
                    id: "err1",
                    type: "function",
                    function: {
                        name: "shell",
                        arguments: JSON.stringify({
                            command: "exit 1",
                            cwd: "."
                        })
                    }
                }]
            },
            priority: 10
        },

        // Recovery after tool failure
        {
            trigger: {
                agentName: "Executor",
                previousToolCalls: ["shell"],
                userMessage: /tool call failed/i
            },
            response: {
                content: "I see the command failed. Let me try a different approach.",
                toolCalls: [{
                    id: "err2",
                    type: "function",
                    function: {
                        name: "analyze",
                        arguments: JSON.stringify({
                            query: "What went wrong with the previous command?"
                        })
                    }
                }]
            },
            priority: 9
        },

        // Network timeout simulation
        {
            trigger: {
                agentName: "Orchestrator",
                userMessage: /test.*timeout/i
            },
            response: {
                streamDelay: 5000, // 5 second delay
                content: "This response is delayed to simulate network issues...",
                toolCalls: [{
                    id: "timeout1",
                    type: "function",
                    function: {
                        name: "continue",
                        arguments: JSON.stringify({
                            summary: "Testing timeout handling",
                            suggestedPhase: "CHAT",
                            confidence: 50,
                            reasoning: "Network seems slow"
                        })
                    }
                }]
            },
            priority: 10
        },

        // Invalid tool arguments
        {
            trigger: {
                agentName: "Executor",
                userMessage: /malformed.*request/i
            },
            response: {
                content: "Testing malformed tool call...",
                toolCalls: [{
                    id: "bad1",
                    type: "function",
                    function: {
                        name: "continue",
                        arguments: "{ invalid json }" // Intentionally malformed
                    }
                }]
            },
            priority: 10
        },

        // LLM service error
        {
            trigger: {
                userMessage: /trigger.*llm.*error/i
            },
            response: {
                error: new Error("LLM Service Unavailable: Rate limit exceeded")
            },
            priority: 10
        },

        // Empty response handling
        {
            trigger: {
                agentName: "Executor",
                userMessage: /empty.*response/i
            },
            response: {
                content: "", // Empty content
                toolCalls: [] // No tool calls
            },
            priority: 10
        },

        // Multiple tool calls with mixed success
        {
            trigger: {
                agentName: "Executor",
                userMessage: /mixed.*results/i
            },
            response: {
                content: "Executing multiple operations with mixed results...",
                toolCalls: [
                    {
                        id: "mix1",
                        type: "function",
                        function: {
                            name: "readPath",
                            arguments: JSON.stringify({ path: "./exists.md" })
                        }
                    },
                    {
                        id: "mix2",
                        type: "function",
                        function: {
                            name: "readPath",
                            arguments: JSON.stringify({ path: "./does-not-exist.md" })
                        }
                    },
                    {
                        id: "mix3",
                        type: "function",
                        function: {
                            name: "shell",
                            arguments: JSON.stringify({ command: "echo 'success'" })
                        }
                    }
                ]
            },
            priority: 10
        },

        // Infinite loop prevention
        {
            trigger: {
                agentName: "Orchestrator",
                previousToolCalls: ["continue", "continue", "continue", "continue", "continue"]
            },
            response: {
                content: "I notice we're stuck in a loop. Let me break out of this pattern.",
                toolCalls: [{
                    id: "loop1",
                    type: "function",
                    function: {
                        name: "endConversation",
                        arguments: JSON.stringify({
                            reason: "Detected potential infinite loop"
                        })
                    }
                }]
            },
            priority: 15
        },

        // Phase transition failure
        {
            trigger: {
                agentName: "Orchestrator",
                userMessage: /invalid.*phase/i
            },
            response: {
                toolCalls: [{
                    id: "phase1",
                    type: "function",
                    function: {
                        name: "continue",
                        arguments: JSON.stringify({
                            summary: "Attempting invalid phase transition",
                            suggestedPhase: "INVALID_PHASE", // Invalid phase
                            confidence: 10,
                            reasoning: "Testing phase validation"
                        })
                    }
                }]
            },
            priority: 10
        },

        // Concurrent execution conflict
        {
            trigger: {
                agentName: "Executor",
                userMessage: /concurrent.*modification/i
            },
            response: {
                content: "Detecting concurrent modification conflict...",
                toolCalls: [{
                    id: "conc1",
                    type: "function",
                    function: {
                        name: "writeFile",
                        arguments: JSON.stringify({
                            path: "src/shared.ts",
                            content: "// Version A"
                        })
                    }
                }]
            },
            priority: 10
        },

        // Memory/context overflow simulation
        {
            trigger: {
                agentName: "Executor",
                userMessage: /large.*context/i
            },
            response: {
                content: "A".repeat(10000), // Very large response
                toolCalls: [{
                    id: "mem1",
                    type: "function",
                    function: {
                        name: "analyze",
                        arguments: JSON.stringify({
                            query: "Analyze this extremely large codebase with thousands of files"
                        })
                    }
                }]
            },
            priority: 10
        }
    ]
};