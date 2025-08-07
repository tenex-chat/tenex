import type { MockLLMScenario } from "../types";

/**
 * Scenario for testing conversation state persistence and recovery
 * Simulates partial workflow execution and recovery after restart
 */
export const statePersistenceScenario: MockLLMScenario = {
    name: "state-persistence",
    description: "Test conversation state persistence and recovery across restarts",
    responses: [
    // Initial orchestrator response - transition to PLAN phase
    {
        trigger: {
            agentName: "orchestrator",
            phase: "CHAT",
            userMessage: /create.*authentication/i,
        },
        response: {
            content: "I'll help you create an authentication system. Let me plan the implementation approach.",
            toolCalls: [
                {
                    id: "1",
                    function: "continue",
                    args: JSON.stringify({
                        summary: "Planning authentication system implementation",
                        suggestedPhase: "PLAN",
                    }),
                },
            ],
        },
        priority: 10,
    },
    // Plan phase response - transition to BUILD
    {
        trigger: {
            agentName: "orchestrator",
            phase: "PLAN",
            userMessage: /continue.*implementation/i,
        },
        response: {
            content: "I've planned the authentication system. Let's start building the components.",
            toolCalls: [
                {
                    id: "2",
                    function: "continue",
                    args: JSON.stringify({
                        summary: "Starting authentication implementation",
                        suggestedPhase: "BUILD",
                        suggestedAgent: "executor",
                    }),
                },
            ],
        },
        priority: 10,
    },
    // Test agent BUILD phase response
    {
        trigger: {
            agentName: "executor",
            phase: "BUILD",
        },
        response: {
            content: "I'll implement the authentication system components.",
            toolCalls: [
                {
                    id: "3",
                    function: "writeContextFile",
                    args: JSON.stringify({
                        filename: "auth-implementation.md",
                        content: "# Authentication Implementation\n\n- User registration\n- Login/logout\n- Session management",
                    }),
                },
            ],
        },
        priority: 10,
    },
    // Analyze project structure scenario
    {
        trigger: {
            agentName: "orchestrator",
            phase: "CHAT",
            userMessage: /analyze.*project.*structure/i,
        },
        response: {
            content: "I'll analyze the project structure for you.",
            toolCalls: [
                {
                    id: "4",
                    function: "continue",
                    args: JSON.stringify({
                        summary: "Analyzing project structure",
                        suggestedPhase: "BUILD",
                        suggestedAgent: "executor",
                    }),
                },
            ],
        },
        priority: 10,
    },
    // Recovery scenario - continue analysis
    {
        trigger: {
            agentName: "executor",
            phase: "BUILD",
            userMessage: /continue.*analysis/i,
        },
        response: {
            content: "Continuing with the project structure analysis.",
            toolCalls: [
                {
                    id: "5",
                    function: "complete",
                    args: JSON.stringify({
                        summary: "Project structure analyzed successfully",
                    }),
                },
            ],
        },
        priority: 10,
    },
    // Concurrent task scenarios
    {
        trigger: {
            agentName: "orchestrator",
            phase: "CHAT",
            userMessage: /Task.*Create feature/i,
        },
        response: {
            content: "I'll help you create this feature.",
            toolCalls: [
                {
                    id: "6",
                    function: "continue",
                    args: JSON.stringify({
                        summary: "Creating feature as requested",
                        suggestedPhase: "PLAN",
                    }),
                },
            ],
        },
        priority: 10,
    },
    ]
};