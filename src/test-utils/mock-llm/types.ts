import type { Message, ToolCall } from "@/llm/types";

export interface MockLLMResponse {
    /** The messages that should trigger this response */
    trigger: {
        /** Match system prompt content */
        systemPrompt?: string | RegExp;
        /** Match user message content */
        userMessage?: string | RegExp;
        /** Match specific tool calls in the conversation */
        previousToolCalls?: string[];
        /** Match agent name */
        agentName?: string;
        /** Match conversation phase */
        phase?: string;
    };
    /** The response to return when triggered */
    response: {
        /** Text content of the response */
        content?: string;
        /** Tool calls to make */
        toolCalls?: ToolCall[];
        /** Simulate streaming delay in ms */
        streamDelay?: number;
        /** Simulate an error */
        error?: Error;
    };
    /** Priority for matching (higher = checked first) */
    priority?: number;
}

export interface MockLLMScenario {
    name: string;
    description: string;
    responses: MockLLMResponse[];
}

export interface MockLLMConfig {
    /** Default response if no triggers match */
    defaultResponse?: MockLLMResponse['response'];
    /** Log all requests for debugging */
    debug?: boolean;
    /** Scenarios to load */
    scenarios?: MockLLMScenario[];
}