export interface MockToolCall {
    name?: string;
    function?: string;
    params?: Record<string, unknown>;
    args?: string | Record<string, unknown>;
}

export interface MockMessage {
    role: string;
    content: string;
}

export interface MockCompletionRequest {
    messages: MockMessage[];
    model?: string;
    temperature?: number;
    maxTokens?: number;
    options?: {
        configName?: string;
        [key: string]: unknown;
    };
}

export interface MockCompletionResponse {
    content?: string;
    toolCalls?: MockToolCall[];
    model?: string;
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
    };
    experimental_providerMetadata?: Record<string, unknown>;
}

export interface MockStreamEvent {
    type: string;
    content?: string;
    delta?: string;
    error?: string;
    tool?: string;
    args?: unknown;
    response?: {
        type: string;
        content?: string;
        toolCalls?: MockToolCall[];
        usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
        };
    };
}

export interface MockLLMServiceContract {
    complete(request: MockCompletionRequest): Promise<MockCompletionResponse>;
    stream?(request: MockCompletionRequest): AsyncIterableIterator<MockStreamEvent>;
}

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
        agentName?: string | RegExp;
        /** Match conversation phase */
        phase?: string;
        /** Match if message contains text */
        messageContains?: string | RegExp;
        /** Which iteration for this agent (1st, 2nd, etc) */
        iterationCount?: number;
        /** Who called continue last */
        previousAgent?: string;
        /** Respond differently after specific agent */
        afterAgent?: string;
        /** Match when continue tool specifies a phase */
        continueToPhase?: string;
    };
    /** The response to return when triggered */
    response: {
        /** Text content of the response */
        content?: string;
        /** Tool calls to make */
        toolCalls?: MockToolCall[];
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
    defaultResponse?: MockLLMResponse["response"];
    /** Log all requests for debugging */
    debug?: boolean;
    /** Scenarios to load */
    scenarios?: MockLLMScenario[];
    /** Custom responses for matching specific patterns */
    responses?: Array<
        | {
              match: RegExp | string;
              response: MockLLMResponse["response"];
              priority?: number;
          }
        | MockLLMResponse
    >;
}
