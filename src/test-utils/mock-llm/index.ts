export * from "./types";
export * from "./MockLLMService";
export * from "./scenarios";

import { MockLLMService } from "./MockLLMService";
import type { MockLLMConfig, MockLLMScenario } from "./types";
import type { ToolCall } from "@/llm/types";
import { allScenarios } from "./scenarios";

/**
 * Create a mock LLM service with predefined scenarios
 */
export function createMockLLMService(
    scenarios?: string[] | MockLLMScenario[],
    config?: Partial<MockLLMConfig>
): MockLLMService {
    const loadedScenarios: MockLLMScenario[] = [];
    
    if (scenarios) {
        for (const scenario of scenarios) {
            if (typeof scenario === 'string') {
                // Load by name
                const found = allScenarios.find(s => s.name === scenario);
                if (found) {
                    loadedScenarios.push(found);
                }
            } else {
                // Direct scenario object
                loadedScenarios.push(scenario);
            }
        }
    }
    
    return new MockLLMService({
        ...config,
        scenarios: loadedScenarios,
        defaultResponse: config?.defaultResponse || {
            content: "Mock LLM: No matching response found",
            toolCalls: []
        }
    });
}

/**
 * Create a simple mock that always returns the same response
 */
export function createSimpleMock(
    content: string,
    toolCalls?: ToolCall[]
): MockLLMService {
    return new MockLLMService({
        defaultResponse: { content, toolCalls }
    });
}

/**
 * Create a mock that simulates errors
 */
export function createErrorMock(error: Error): MockLLMService {
    return new MockLLMService({
        defaultResponse: { error }
    });
}