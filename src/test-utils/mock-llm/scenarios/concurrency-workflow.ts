import type { MockLLMResponse, MockLLMScenario } from "../types";

const concurrencyResponses: MockLLMResponse[] = [
    // Routing decisions for orchestrator
    {
        trigger: {
            agentName: "orchestrator",
            messageContains: /routing.*decision/i,
            userMessage: /User A/,
        },
        response: {
            content: JSON.stringify({
                agents: ["orchestrator"],
                phase: "CHAT",
                reason: "User A wants to create an authentication system. Starting in chat phase to understand requirements.",
            }),
        },
        priority: 100,
    },
    {
        trigger: {
            agentName: "orchestrator",
            messageContains: /routing.*decision/i,
            userMessage: /User B/,
        },
        response: {
            content: JSON.stringify({
                agents: ["orchestrator"],
                phase: "CHAT",
                reason: "User B wants payment processing. Starting in chat phase to understand requirements.",
            }),
        },
        priority: 100,
    },
    {
        trigger: {
            agentName: "orchestrator",
            messageContains: /routing.*decision/i,
            userMessage: /User C/,
        },
        response: {
            content: JSON.stringify({
                agents: ["orchestrator"],
                phase: "CHAT",
                reason: "User C wants payment processing. Starting in chat phase to understand requirements.",
            }),
        },
        priority: 100,
    },

    // Orchestrator Phase 1: Initial task understanding for User A
    {
        trigger: {
            agentName: "orchestrator",
            phase: "CHAT",
            userMessage: /create.*user.*authentication.*A/i,
        },
        response: {
            content:
                "I'll help User A create an authentication system. Let me understand the requirements.",
            toolCalls: [
                {
                    id: "1",
                    message: null,
                    function: "continue",
                    args: JSON.stringify({
                        summary: "Creating authentication system for User A",
                        suggestedPhase: "PLAN",
                    }),
                } as unknown,
            ],
        },
        priority: 10,
    },

    // Orchestrator Phase 1: Initial task understanding for User B
    {
        trigger: {
            agentName: "orchestrator",
            phase: "CHAT",
            userMessage: /implement.*payment.*processing.*B/i,
        },
        response: {
            content:
                "I'll help User B implement payment processing. Let me analyze the requirements.",
            toolCalls: [
                {
                    id: "1",
                    message: null,
                    function: "continue",
                    args: JSON.stringify({
                        summary: "Implementing payment processing for User B",
                        suggestedPhase: "PLAN",
                    }),
                } as unknown,
            ],
        },
        priority: 10,
    },

    // Orchestrator Phase 2: Planning for User A
    {
        trigger: {
            agentName: "orchestrator",
            phase: "PLAN",
            messageContains: /User A/,
        },
        response: {
            content:
                "## Authentication System Plan for User A\n\n1. Create user model\n2. Implement JWT tokens\n3. Add login endpoints",
            toolCalls: [
                {
                    id: "2",
                    message: null,
                    function: "continue",
                    args: JSON.stringify({
                        summary: "Authentication plan ready for User A",
                        suggestedPhase: "EXECUTE",
                    }),
                } as unknown,
            ],
        },
        priority: 5,
    },

    // Orchestrator Phase 2: Planning for User B
    {
        trigger: {
            agentName: "orchestrator",
            phase: "PLAN",
            messageContains: /User B/,
        },
        response: {
            content:
                "## Payment Processing Plan for User B\n\n1. Integrate payment gateway\n2. Create payment models\n3. Add webhook handlers",
            toolCalls: [
                {
                    id: "2",
                    message: null,
                    function: "continue",
                    args: JSON.stringify({
                        summary: "Payment plan ready for User B",
                        suggestedPhase: "EXECUTE",
                    }),
                } as unknown,
            ],
        },
        priority: 5,
    },

    // Orchestrator Phase 3: Implementation delegation for User A
    {
        trigger: {
            agentName: "orchestrator",
            phase: "EXECUTE",
            messageContains: /User A/,
        },
        response: {
            content: "Delegating to Executor agent to implement authentication for User A.",
            toolCalls: [
                {
                    id: "3",
                    message: null,
                    function: "delegate",
                    args: JSON.stringify({
                        toAgent: "executor",
                        context: "Implement authentication system for User A as planned",
                    }),
                } as unknown,
            ],
        },
        priority: 5,
    },

    // Orchestrator Phase 3: Implementation delegation for User B
    {
        trigger: {
            agentName: "orchestrator",
            phase: "EXECUTE",
            messageContains: /User B/,
        },
        response: {
            content: "Delegating to Executor agent to implement payment processing for User B.",
            toolCalls: [
                {
                    id: "3",
                    message: null,
                    function: "delegate",
                    args: JSON.stringify({
                        toAgent: "executor",
                        context: "Implement payment processing for User B as planned",
                    }),
                } as unknown,
            ],
        },
        priority: 5,
    },

    // Executor implementation for User A
    {
        trigger: {
            agentName: "executor",
            phase: "EXECUTE",
            messageContains: /User A/,
        },
        response: {
            content:
                "Implementing authentication system for User A:\n\n1. Creating user model...\n2. Setting up JWT...\n3. Adding endpoints...\n\nAuthentication system implemented successfully!",
            toolCalls: [
                {
                    id: "4",
                    message: null,
                    function: "delegate",
                    args: JSON.stringify({
                        toAgent: "orchestrator",
                        context: "Authentication implementation completed for User A",
                    }),
                } as unknown,
            ],
        },
        priority: 5,
    },

    // Executor implementation for User B
    {
        trigger: {
            agentName: "executor",
            phase: "EXECUTE",
            messageContains: /User B/,
        },
        response: {
            content:
                "Implementing payment processing for User B:\n\n1. Integrating payment gateway...\n2. Creating payment models...\n3. Setting up webhooks...\n\nPayment processing implemented successfully!",
            toolCalls: [
                {
                    id: "4",
                    message: null,
                    function: "delegate",
                    args: JSON.stringify({
                        toAgent: "orchestrator",
                        context: "Payment implementation completed for User B",
                    }),
                } as unknown,
            ],
        },
        priority: 5,
    },

    // Orchestrator Phase 4: Verification for User A
    {
        trigger: {
            agentName: "orchestrator",
            phase: "EXECUTE",
            messageContains: /completed for User A/,
        },
        response: {
            content:
                "Authentication system has been implemented for User A. Moving to verification.",
            toolCalls: [
                {
                    id: "5",
                    message: null,
                    function: "continue",
                    args: JSON.stringify({
                        summary: "Ready to verify authentication for User A",
                        suggestedPhase: "VERIFICATION",
                    }),
                } as unknown,
            ],
        },
        priority: 5,
    },

    // Orchestrator Phase 4: Verification for User B
    {
        trigger: {
            agentName: "orchestrator",
            phase: "EXECUTE",
            messageContains: /completed for User B/,
        },
        response: {
            content: "Payment processing has been implemented for User B. Moving to verification.",
            toolCalls: [
                {
                    id: "5",
                    message: null,
                    function: "continue",
                    args: JSON.stringify({
                        summary: "Ready to verify payment processing for User B",
                        suggestedPhase: "VERIFICATION",
                    }),
                } as unknown,
            ],
        },
        priority: 5,
    },

    // Orchestrator Phase 5: Completion for User A
    {
        trigger: {
            agentName: "orchestrator",
            phase: "VERIFICATION",
            messageContains: /User A/,
        },
        response: {
            content:
                "✅ Authentication system for User A has been successfully implemented and verified!",
            toolCalls: [
                {
                    id: "6",
                    message: null,
                    function: "completeConversation",
                    args: JSON.stringify({
                        summary: "Authentication system completed for User A",
                    }),
                } as unknown,
            ],
        },
        priority: 5,
    },

    // Orchestrator Phase 5: Completion for User B
    {
        trigger: {
            agentName: "orchestrator",
            phase: "VERIFICATION",
            messageContains: /User B/,
        },
        response: {
            content:
                "✅ Payment processing for User B has been successfully implemented and verified!",
            toolCalls: [
                {
                    id: "6",
                    message: null,
                    function: "completeConversation",
                    args: JSON.stringify({
                        summary: "Payment processing completed for User B",
                    }),
                } as unknown,
            ],
        },
        priority: 5,
    },

    // Orchestrator Phase 1: Initial task understanding for User C
    {
        trigger: {
            agentName: "orchestrator",
            phase: "CHAT",
            userMessage: /implement.*payment.*processing.*C/i,
        },
        response: {
            content:
                "I'll help User C implement payment processing. Let me analyze the requirements.",
            toolCalls: [
                {
                    id: "1",
                    message: null,
                    function: "continue",
                    args: JSON.stringify({
                        summary: "Implementing payment processing for User C",
                        suggestedPhase: "PLAN",
                    }),
                } as unknown,
            ],
        },
        priority: 10,
    },

    // Orchestrator Phase 2: Planning for User C
    {
        trigger: {
            agentName: "orchestrator",
            phase: "PLAN",
            messageContains: /User C/,
        },
        response: {
            content:
                "## Payment Processing Plan for User C\n\n1. Integrate payment gateway\n2. Create payment models\n3. Add webhook handlers",
            toolCalls: [
                {
                    id: "2",
                    message: null,
                    function: "continue",
                    args: JSON.stringify({
                        summary: "Payment plan ready for User C",
                        suggestedPhase: "EXECUTE",
                    }),
                } as unknown,
            ],
        },
        priority: 5,
    },

    // Orchestrator Phase 3: Implementation delegation for User C
    {
        trigger: {
            agentName: "orchestrator",
            phase: "EXECUTE",
            messageContains: /User C/,
        },
        response: {
            content: "Delegating to Executor agent to implement payment processing for User C.",
            toolCalls: [
                {
                    id: "3",
                    message: null,
                    function: "handoff",
                    args: JSON.stringify({
                        toAgent: "executor",
                        context: "Implement payment processing for User C as planned",
                    }),
                } as unknown,
            ],
        },
        priority: 5,
    },

    // Executor implementation for User C
    {
        trigger: {
            agentName: "executor",
            phase: "EXECUTE",
            messageContains: /User C/,
        },
        response: {
            content:
                "Implementing payment processing for User C:\n\n1. Integrating payment gateway...\n2. Creating payment models...\n3. Setting up webhooks...\n\nPayment processing implemented successfully!",
            toolCalls: [
                {
                    id: "4",
                    message: null,
                    function: "delegate",
                    args: JSON.stringify({
                        toAgent: "orchestrator",
                        context: "Payment implementation completed for User C",
                    }),
                } as unknown,
            ],
        },
        priority: 5,
    },

    // Orchestrator Phase 4: Verification for User C
    {
        trigger: {
            agentName: "orchestrator",
            phase: "EXECUTE",
            messageContains: /completed for User C/,
        },
        response: {
            content: "Payment processing has been implemented for User C. Moving to verification.",
            toolCalls: [
                {
                    id: "5",
                    message: null,
                    function: "continue",
                    args: JSON.stringify({
                        summary: "Ready to verify payment processing for User C",
                        suggestedPhase: "VERIFICATION",
                    }),
                } as unknown,
            ],
        },
        priority: 5,
    },

    // Orchestrator Phase 5: Completion for User C
    {
        trigger: {
            agentName: "orchestrator",
            phase: "VERIFICATION",
            messageContains: /User C/,
        },
        response: {
            content:
                "✅ Payment processing for User C has been successfully implemented and verified!",
            toolCalls: [
                {
                    id: "6",
                    message: null,
                    function: "completeConversation",
                    args: JSON.stringify({
                        summary: "Payment processing completed for User C",
                    }),
                } as unknown,
            ],
        },
        priority: 5,
    },
];

export const concurrencyWorkflowScenarios: MockLLMScenario[] = [
    {
        name: "concurrency-workflow",
        description: "Mock responses for concurrent conversation workflow testing",
        responses: concurrencyResponses,
    },
];
