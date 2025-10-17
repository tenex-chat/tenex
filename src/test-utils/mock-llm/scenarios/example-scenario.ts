import type { MockLLMScenario, MockLLMResponse } from "../types";

/**
 * Example scenario showing how to create mock responses
 */
export const exampleScenario: MockLLMScenario = {
    name: "example-workflow",
    description: "Example scenario for testing basic workflows",
    responses: [
        // Simple greeting response
        {
            trigger: {
                userMessage: /hello|hi|hey/i,  // Regex pattern matching
            },
            response: {
                content: "Hello! I'm here to help. What would you like to work on today?",
            },
            priority: 10,  // Higher priority responses are checked first
        },

        // Response with tool calls
        {
            trigger: {
                userMessage: /create.*file/i,
                agentName: "project-manager",  // Only matches for specific agent
            },
            response: {
                content: "I'll delegate this to the appropriate agent for implementation.",
                toolCalls: [
                    {
                        function: "delegate_phase",
                        args: JSON.stringify({
                            phase: "execute",
                            reason: "File creation needs to be implemented"
                        })
                    }
                ],
            },
            priority: 15,
        },

        // Phase-specific response
        {
            trigger: {
                phase: "plan",  // Matches specific conversation phase
                messageContains: /authentication/i,
            },
            response: {
                content: "Let me create a plan for the authentication system:\n1. Set up user model\n2. Implement JWT tokens\n3. Add OAuth support",
                toolCalls: [
                    {
                        function: "delegate_phase",
                        args: JSON.stringify({
                            phase: "execute",
                            reason: "Plan is ready, moving to implementation"
                        })
                    }
                ],
            },
            priority: 20,
        },

        // Context-aware response (tracks iterations)
        {
            trigger: {
                agentName: "executor",
                iterationCount: 2,  // Only on second iteration of this agent
            },
            response: {
                content: "This is my second attempt. Let me try a different approach.",
            },
            priority: 5,
        },

        // Response after specific agent
        {
            trigger: {
                previousAgent: "planner",  // Responds after planner agent
                agentName: "executor",
            },
            response: {
                content: "I received the plan from the planner. Starting implementation now.",
            },
            priority: 10,
        },

        // Error simulation
        {
            trigger: {
                userMessage: /simulate.*error/i,
            },
            response: {
                error: new Error("Simulated error for testing"),
            },
            priority: 100,  // High priority to override other matches
        },

        // Response with streaming delay
        {
            trigger: {
                userMessage: /slow.*response/i,
            },
            response: {
                content: "This response will stream slowly for testing purposes.",
                streamDelay: 2000,  // 2 second delay
            },
            priority: 10,
        },

        // Default fallback for agent
        {
            trigger: {
                agentName: /.*/,  // Matches any agent
            },
            response: {
                content: "Processing your request with mock response.",
            },
            priority: 1,  // Lowest priority - only if nothing else matches
        },
    ],
};

/**
 * Helper function to create a simple pattern-based scenario
 */
export function createSimpleScenario(patterns: Record<string, string>): MockLLMScenario {
    const responses: MockLLMResponse[] = Object.entries(patterns).map(([pattern, response], index) => ({
        trigger: {
            userMessage: new RegExp(pattern, "i"),
        },
        response: {
            content: response,
        },
        priority: 10 - index,  // First patterns have higher priority
    }));

    return {
        name: "simple-patterns",
        description: "Simple pattern-based responses",
        responses,
    };
}

// Example usage of simple scenario
export const simpleIOSTestScenario = createSimpleScenario({
    "hello": "Hello! I'm running in test mode.",
    "create.*file": "Creating the file for you.",
    "list.*files": "Here are your files:\n- README.md\n- package.json",
    "error": "ERROR: Test error for iOS",
    ".*": "Default mock response",  // Fallback
});