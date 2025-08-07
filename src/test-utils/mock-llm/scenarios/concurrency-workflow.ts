import type { MockLLMScenario, MockLLMResponse } from "../types";
import type { ToolCall } from "@/llm/types";

const concurrencyResponses: MockLLMResponse[] = [
    // Routing decisions for orchestrator
    {
        trigger: {
            agentName: "orchestrator",
            messageContains: /routing.*decision/i,
            userMessage: /User A/
        },
        response: {
            content: JSON.stringify({
                agents: ["orchestrator"],
                phase: "chat",
                reason: "User A wants to create an authentication system. Starting in chat phase to understand requirements."
            })
        },
        priority: 100
    },
    {
        trigger: {
            agentName: "orchestrator",
            messageContains: /routing.*decision/i,
            userMessage: /User B/
        },
        response: {
            content: JSON.stringify({
                agents: ["orchestrator"],
                phase: "chat",
                reason: "User B wants payment processing. Starting in chat phase to understand requirements."
            })
        },
        priority: 100
    },
    {
        trigger: {
            agentName: "orchestrator",
            messageContains: /routing.*decision/i,
            userMessage: /User C/
        },
        response: {
            content: JSON.stringify({
                agents: ["orchestrator"],
                phase: "chat",
                reason: "User C wants payment processing. Starting in chat phase to understand requirements."
            })
        },
        priority: 100
    },
    
    // Orchestrator Phase 1: Initial task understanding for User A
    {
        trigger: {
            agentName: "orchestrator",
            phase: "chat",
            userMessage: /create.*user.*authentication.*A/i,
        },
        response: {
            content: "I'll help User A create an authentication system. Let me understand the requirements.",
            toolCalls: [
                {
                    id: "1",
                    function: "continue",
                    args: JSON.stringify({
                        summary: "Creating authentication system for User A",
                        suggestedPhase: "plan",
                    }),
                } as any,
            ],
        },
        priority: 10,
    },

    // Orchestrator Phase 1: Initial task understanding for User B
    {
        trigger: {
            agentName: "orchestrator",
            phase: "chat",
            userMessage: /implement.*payment.*processing.*B/i,
        },
        response: {
            content: "I'll help User B implement payment processing. Let me analyze the requirements.",
            toolCalls: [
                {
                    id: "1",
                    function: "continue",
                    args: JSON.stringify({
                        summary: "Implementing payment processing for User B",
                        suggestedPhase: "plan",
                    }),
                } as any,
            ],
        },
        priority: 10,
    },

    // Orchestrator Phase 2: Planning for User A
    {
        trigger: {
            agentName: "orchestrator",
            phase: "plan",
            messageContent: /User A/,
        },
        response: {
            content: "## Authentication System Plan for User A\n\n1. Create user model\n2. Implement JWT tokens\n3. Add login endpoints",
            toolCalls: [
                {
                    id: "2",
                    function: "continue",
                    args: JSON.stringify({
                        summary: "Authentication plan ready for User A",
                        suggestedPhase: "implementation",
                    }),
                } as any,
            ],
        },
        priority: 5,
    },

    // Orchestrator Phase 2: Planning for User B
    {
        trigger: {
            agentName: "orchestrator",
            phase: "plan",
            messageContent: /User B/,
        },
        response: {
            content: "## Payment Processing Plan for User B\n\n1. Integrate payment gateway\n2. Create payment models\n3. Add webhook handlers",
            toolCalls: [
                {
                    id: "2",
                    function: "continue",
                    args: JSON.stringify({
                        summary: "Payment plan ready for User B",
                        suggestedPhase: "implementation",
                    }),
                } as any,
            ],
        },
        priority: 5,
    },

    // Orchestrator Phase 3: Implementation handoff for User A
    {
        trigger: {
            agentName: "orchestrator",
            phase: "implementation",
            messageContent: /User A/,
        },
        response: {
            content: "Handing off to Executor agent to implement authentication for User A.",
            toolCalls: [
                {
                    id: "3",
                    function: "handoff",
                    args: JSON.stringify({
                        toAgent: "executor",
                        context: "Implement authentication system for User A as planned",
                    }),
                } as any,
            ],
        },
        priority: 5,
    },

    // Orchestrator Phase 3: Implementation handoff for User B
    {
        trigger: {
            agentName: "orchestrator",
            phase: "implementation",
            messageContent: /User B/,
        },
        response: {
            content: "Handing off to Executor agent to implement payment processing for User B.",
            toolCalls: [
                {
                    id: "3",
                    function: "handoff",
                    args: JSON.stringify({
                        toAgent: "executor",
                        context: "Implement payment processing for User B as planned",
                    }),
                } as any,
            ],
        },
        priority: 5,
    },

    // Executor implementation for User A
    {
        trigger: {
            agentName: "executor",
            phase: "implementation",
            messageContent: /User A/,
        },
        response: {
            content: "Implementing authentication system for User A:\n\n1. Creating user model...\n2. Setting up JWT...\n3. Adding endpoints...\n\nAuthentication system implemented successfully!",
            toolCalls: [
                {
                    id: "4",
                    function: "handoff",
                    args: JSON.stringify({
                        toAgent: "orchestrator",
                        context: "Authentication implementation completed for User A",
                    }),
                } as any,
            ],
        },
        priority: 5,
    },

    // Executor implementation for User B
    {
        trigger: {
            agentName: "executor",
            phase: "implementation",
            messageContent: /User B/,
        },
        response: {
            content: "Implementing payment processing for User B:\n\n1. Integrating payment gateway...\n2. Creating payment models...\n3. Setting up webhooks...\n\nPayment processing implemented successfully!",
            toolCalls: [
                {
                    id: "4",
                    function: "handoff",
                    args: JSON.stringify({
                        toAgent: "orchestrator",
                        context: "Payment implementation completed for User B",
                    }),
                } as any,
            ],
        },
        priority: 5,
    },

    // Orchestrator Phase 4: Verification for User A
    {
        trigger: {
            agentName: "orchestrator",
            phase: "implementation",
            messageContent: /completed for User A/,
        },
        response: {
            content: "Authentication system has been implemented for User A. Moving to verification.",
            toolCalls: [
                {
                    id: "5",
                    function: "continue",
                    args: JSON.stringify({
                        summary: "Ready to verify authentication for User A",
                        suggestedPhase: "verification",
                    }),
                } as any,
            ],
        },
        priority: 5,
    },

    // Orchestrator Phase 4: Verification for User B
    {
        trigger: {
            agentName: "orchestrator",
            phase: "implementation",
            messageContent: /completed for User B/,
        },
        response: {
            content: "Payment processing has been implemented for User B. Moving to verification.",
            toolCalls: [
                {
                    id: "5",
                    function: "continue",
                    args: JSON.stringify({
                        summary: "Ready to verify payment processing for User B",
                        suggestedPhase: "verification",
                    }),
                } as any,
            ],
        },
        priority: 5,
    },

    // Orchestrator Phase 5: Completion for User A
    {
        trigger: {
            agentName: "orchestrator",
            phase: "verification",
            messageContent: /User A/,
        },
        response: {
            content: "✅ Authentication system for User A has been successfully implemented and verified!",
            toolCalls: [
                {
                    id: "6",
                    function: "completeConversation",
                    args: JSON.stringify({
                        summary: "Authentication system completed for User A",
                    }),
                } as any,
            ],
        },
        priority: 5,
    },

    // Orchestrator Phase 5: Completion for User B
    {
        trigger: {
            agentName: "orchestrator",
            phase: "verification",
            messageContent: /User B/,
        },
        response: {
            content: "✅ Payment processing for User B has been successfully implemented and verified!",
            toolCalls: [
                {
                    id: "6",
                    function: "completeConversation",
                    args: JSON.stringify({
                        summary: "Payment processing completed for User B",
                    }),
                } as any,
            ],
        },
        priority: 5,
    },

    // Orchestrator Phase 1: Initial task understanding for User C
    {
        trigger: {
            agentName: "orchestrator",
            phase: "chat",
            userMessage: /implement.*payment.*processing.*C/i,
        },
        response: {
            content: "I'll help User C implement payment processing. Let me analyze the requirements.",
            toolCalls: [
                {
                    id: "1",
                    function: "continue",
                    args: JSON.stringify({
                        summary: "Implementing payment processing for User C",
                        suggestedPhase: "plan",
                    }),
                } as any,
            ],
        },
        priority: 10,
    },

    // Orchestrator Phase 2: Planning for User C
    {
        trigger: {
            agentName: "orchestrator",
            phase: "plan",
            messageContent: /User C/,
        },
        response: {
            content: "## Payment Processing Plan for User C\n\n1. Integrate payment gateway\n2. Create payment models\n3. Add webhook handlers",
            toolCalls: [
                {
                    id: "2",
                    function: "continue",
                    args: JSON.stringify({
                        summary: "Payment plan ready for User C",
                        suggestedPhase: "implementation",
                    }),
                } as any,
            ],
        },
        priority: 5,
    },

    // Orchestrator Phase 3: Implementation handoff for User C
    {
        trigger: {
            agentName: "orchestrator",
            phase: "implementation",
            messageContent: /User C/,
        },
        response: {
            content: "Handing off to Executor agent to implement payment processing for User C.",
            toolCalls: [
                {
                    id: "3",
                    function: "handoff",
                    args: JSON.stringify({
                        toAgent: "executor",
                        context: "Implement payment processing for User C as planned",
                    }),
                } as any,
            ],
        },
        priority: 5,
    },

    // Executor implementation for User C
    {
        trigger: {
            agentName: "executor",
            phase: "implementation",
            messageContent: /User C/,
        },
        response: {
            content: "Implementing payment processing for User C:\n\n1. Integrating payment gateway...\n2. Creating payment models...\n3. Setting up webhooks...\n\nPayment processing implemented successfully!",
            toolCalls: [
                {
                    id: "4",
                    function: "handoff",
                    args: JSON.stringify({
                        toAgent: "orchestrator",
                        context: "Payment implementation completed for User C",
                    }),
                } as any,
            ],
        },
        priority: 5,
    },

    // Orchestrator Phase 4: Verification for User C
    {
        trigger: {
            agentName: "orchestrator",
            phase: "implementation",
            messageContent: /completed for User C/,
        },
        response: {
            content: "Payment processing has been implemented for User C. Moving to verification.",
            toolCalls: [
                {
                    id: "5",
                    function: "continue",
                    args: JSON.stringify({
                        summary: "Ready to verify payment processing for User C",
                        suggestedPhase: "verification",
                    }),
                } as any,
            ],
        },
        priority: 5,
    },

    // Orchestrator Phase 5: Completion for User C
    {
        trigger: {
            agentName: "orchestrator",
            phase: "verification",
            messageContent: /User C/,
        },
        response: {
            content: "✅ Payment processing for User C has been successfully implemented and verified!",
            toolCalls: [
                {
                    id: "6",
                    function: "completeConversation",
                    args: JSON.stringify({
                        summary: "Payment processing completed for User C",
                    }),
                } as any,
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