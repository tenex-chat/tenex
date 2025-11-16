import type { MockLLMResponse, MockLLMScenario } from "../types";

const threadingResponses: MockLLMResponse[] = [
    // Root conversation responses
    {
        trigger: {
            agentName: "chat-agent",
            userMessage: /simply say "YELLOW"/i,
        },
        response: {
            content: "YELLOW",
        },
        priority: 90,
    },
    {
        trigger: {
            agentName: "chat-agent",
            userMessage: /simply say "BROWN"/i,
        },
        response: {
            content: "BROWN",
        },
        priority: 90,
    },
    {
        trigger: {
            agentName: "chat-agent",
            userMessage: /simply say "HELLO1"/i,
        },
        response: {
            content: "HELLO1",
        },
        priority: 90,
    },
    {
        trigger: {
            agentName: "chat-agent",
            userMessage: /simply say "HELLO2"/i,
        },
        response: {
            content: "HELLO2",
        },
        priority: 90,
    },

    // Thread-specific responses
    {
        trigger: {
            agentName: "chat-agent",
            userMessage: /give me this color in lowercase/i,
            messageContains: /YELLOW/,
        },
        response: {
            content: "yellow",
        },
        priority: 100,
    },
    {
        trigger: {
            agentName: "chat-agent",
            userMessage: /give me this color in lowercase/i,
            messageContains: /BROWN/,
        },
        response: {
            content: "brown",
        },
        priority: 100,
    },
    {
        trigger: {
            agentName: "chat-agent",
            userMessage: /tell me this color again/i,
            messageContains: /YELLOW/,
        },
        response: {
            content: "YELLOW",
        },
        priority: 100,
    },
    {
        trigger: {
            agentName: "chat-agent",
            userMessage: /tell me this color again/i,
            messageContains: /BROWN/,
        },
        response: {
            content: "BROWN",
        },
        priority: 100,
    },

    // Transcript generation responses
    {
        trigger: {
            agentName: "chat-agent",
            userMessage: /give me a transcript/i,
            messageContains: /YELLOW.*yellow/is,
        },
        response: {
            content: `Sure, here is the transcript of the conversation:

1. User: simply say "YELLOW"
2. Assistant: YELLOW
3. User: Give me this color in lowercase
4. Assistant: yellow
5. User: give me a transcript of the conversation

Let me know if you need anything else!`,
        },
        priority: 110,
    },
    {
        trigger: {
            agentName: "chat-agent",
            userMessage: /give me a transcript/i,
            messageContains: /BROWN.*brown/is,
        },
        response: {
            content: `Sure, here is the transcript of the conversation:

1. User: simply say "BROWN"
2. Assistant: BROWN
3. User: Give me this color in lowercase
4. Assistant: brown
5. User: give me a transcript of the conversation

Let me know if you need anything else!`,
        },
        priority: 110,
    },

    // Default fallback for unmatched thread contexts
    {
        trigger: {
            agentName: "chat-agent",
            userMessage: /give me a transcript/i,
        },
        response: {
            content:
                "I can provide a transcript of our conversation. However, I need more context about which part of the conversation you'd like transcribed.",
        },
        priority: 50,
    },
];

export const threadingWorkflow: MockLLMScenario = {
    name: "threading-workflow",
    description: "Mock LLM responses for testing NIP-22 threading behavior",
    responses: threadingResponses,
    verifyMessages: (messages) => {
        // Verify that thread context is properly filtered
        const messagesText = messages.map((m) => m.content).join("\n");

        // If we're in a YELLOW thread, should not see BROWN
        if (messagesText.includes("YELLOW") && messagesText.includes("lowercase")) {
            if (messagesText.includes("BROWN")) {
                throw new Error("Thread context leak: BROWN found in YELLOW thread");
            }
        }

        // If we're in a BROWN thread, should not see YELLOW
        if (messagesText.includes("BROWN") && messagesText.includes("lowercase")) {
            if (messagesText.includes("YELLOW") && !messagesText.includes('simply say "YELLOW"')) {
                throw new Error("Thread context leak: YELLOW found in BROWN thread");
            }
        }

        return true;
    },
};
