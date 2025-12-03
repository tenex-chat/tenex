import type {
    CompletionRequest,
    CompletionResponse,
    LLMService,
    Message,
    StreamEvent,
} from "@/llm/types";
import { conversationalLogger } from "../conversational-logger";
import type { MockLLMConfig, MockLLMResponse } from "./types";

export class MockLLMService implements LLMService {
    private config: MockLLMConfig;
    private responses: MockLLMResponse[] = [];
    private requestHistory: Array<{
        messages: Message[];
        model?: string;
        response: MockLLMResponse["response"];
        timestamp: Date;
    }> = [];

    // Context tracking for enhanced triggers
    private conversationContext: Map<
        string,
        {
            lastContinueCaller?: string;
            iteration: number;
            agentIterations: Map<string, number>;
            lastAgentExecuted?: string;
        }
    > = new Map();

    constructor(config: MockLLMConfig = {}) {
        this.config = config;

        // Load responses from scenarios
        if (config.scenarios) {
            for (const scenario of config.scenarios) {
                this.responses.push(...scenario.responses);
            }
        }

        // Load responses directly from config
        if (config.responses) {
            for (const response of config.responses) {
                // Convert simple response format to MockLLMResponse
                if ("match" in response) {
                    // Simple format with match pattern
                    this.responses.push({
                        trigger: {
                            userMessage: response.match,
                        },
                        response: response.response,
                        priority: response.priority || 0,
                    });
                } else {
                    // Full MockLLMResponse format
                    this.responses.push(response);
                }
            }
        }

        // Sort by priority
        this.responses.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    }

    async complete(request: CompletionRequest): Promise<CompletionResponse> {
        const messages = request.messages;
        const model = request.options?.configName || "mock-model";

        const response = this.findMatchingResponse(messages);

        this.recordRequest(messages, model, response);

        if (response.error) {
            throw response.error;
        }

        // Simulate delay if specified
        if (response.streamDelay) {
            await new Promise((resolve) => setTimeout(resolve, response.streamDelay));
        }

        // Convert to CompletionResponse format
        // toolCalls with proper structure
        const toolCallsInfo = response.toolCalls
            ? response.toolCalls.map((tc) => {
                  // Convert our mock format to LlmToolCallInfo format
                  let functionName: string;
                  let args: Record<string, unknown> = {};

                  if (typeof tc === "object" && "function" in tc) {
                      // Format with function as string
                      functionName = tc.function || "unknown";
                      try {
                          const argsStr = typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args);
                          args = JSON.parse(argsStr || "{}");
                      } catch {
                          args = {};
                      }
                  } else if (typeof tc === "object" && "name" in tc) {
                      // Direct ToolCall format
                      functionName = tc.name || "unknown";
                      args = tc.params || {};
                  } else {
                      functionName = "unknown";
                  }

                  return {
                      name: functionName,
                      params: args,
                      result: null,
                  };
              })
            : [];

        return {
            type: "text",
            content: response.content || "",
            toolCalls: toolCallsInfo.length > 0 ? toolCallsInfo : undefined,
            usage: {
                prompt_tokens: 100,
                completion_tokens: 50,
                total_tokens: 150,
            },
        } as CompletionResponse;
    }

    async *stream(request: CompletionRequest): AsyncIterableIterator<StreamEvent> {
        const messages = request.messages;
        const model = request.options?.configName || "mock-model";

        const response = this.findMatchingResponse(messages);

        this.recordRequest(messages, model, response);

        if (response.error) {
            yield { type: "error", error: response.error.message };
            return;
        }

        // Simulate streaming content
        if (response.content) {
            const words = response.content.split(" ");
            for (const word of words) {
                yield { type: "content", content: `${word} ` };
                if (response.streamDelay) {
                    await new Promise((resolve) =>
                        setTimeout(resolve, (response.streamDelay || 0) / words.length)
                    );
                }
            }
        }

        // Send tool calls
        if (response.toolCalls && response.toolCalls.length > 0) {
            for (const toolCall of response.toolCalls) {
                const toolName = toolCall.function;
                const toolArgs = toolCall.args || "{}";
                const argsStr = typeof toolArgs === "string" ? toolArgs : JSON.stringify(toolArgs);

                yield {
                    type: "tool_start",
                    tool: toolName,
                    args: JSON.parse(argsStr),
                };
            }
        }

        // Send completion event
        yield {
            type: "done",
            response: {
                type: "text",
                content: response.content || "",
                toolCalls: [],
                usage: {
                    prompt_tokens: 100,
                    completion_tokens: 50,
                },
            },
        };
    }

    private findMatchingResponse(messages: Message[]): MockLLMResponse["response"] {
        const systemMessage = messages.find((m) => m.role === "system");
        const lastUserMessage = messages.filter((m) => m.role === "user").pop();

        // Extract tool calls from messages that have them
        interface MessageWithToolCalls extends Message {
            tool_calls?: Array<{
                function: string | { name: string };
            }>;
        }

        const toolCalls = messages
            .filter((m): m is MessageWithToolCalls => {
                const msg = m as MessageWithToolCalls;
                return Boolean(
                    msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0
                );
            })
            .flatMap((m) => {
                return (m.tool_calls || []).map((tc) => {
                    return typeof tc.function === "string" ? tc.function : tc.function?.name;
                });
            })
            .filter((name): name is string => typeof name === "string");

        // Extract agent name and phase from system prompt
        const agentName = this.extractAgentName(systemMessage?.content || "");
        const phase = this.extractPhase(systemMessage?.content || "");

        // Get conversation context
        const conversationId = this.extractConversationId();
        const context = this.getOrCreateContext(conversationId);

        // Update agent iteration count
        if (!context.agentIterations.has(agentName)) {
            context.agentIterations.set(agentName, 0);
        }
        const currentIteration = context.agentIterations.get(agentName) || 0;
        context.agentIterations.set(agentName, currentIteration + 1);
        const agentIteration = context.agentIterations.get(agentName) || 0;

        if (this.config.debug) {
            conversationalLogger.logAgentThinking(agentName, {
                phase,
                userMessage: lastUserMessage?.content,
                iteration: context.iteration,
                agentIteration,
            });
        }

        // Find matching response
        for (const mockResponse of this.responses) {
            const trigger = mockResponse.trigger;

            // Check all trigger conditions
            if (trigger.systemPrompt && systemMessage) {
                if (!systemMessage.content) continue;
                const matches =
                    trigger.systemPrompt instanceof RegExp
                        ? trigger.systemPrompt.test(systemMessage.content)
                        : systemMessage.content.includes(trigger.systemPrompt);
                if (!matches) continue;
            }

            if (trigger.userMessage) {
                if (!lastUserMessage || !lastUserMessage.content) {
                    continue; // No user message, but trigger expects one
                }
                const matches =
                    trigger.userMessage instanceof RegExp
                        ? trigger.userMessage.test(lastUserMessage.content)
                        : lastUserMessage.content.includes(trigger.userMessage);
                if (!matches) continue;
            }

            if (trigger.previousToolCalls) {
                const hasAllTools = trigger.previousToolCalls.every((tool) =>
                    toolCalls.includes(tool)
                );
                if (!hasAllTools) continue;
            }

            if (trigger.agentName) {
                if (typeof trigger.agentName === "string") {
                    if (trigger.agentName.toLowerCase() !== agentName.toLowerCase()) {
                        continue;
                    }
                } else if (trigger.agentName instanceof RegExp) {
                    if (!trigger.agentName.test(agentName)) {
                        continue;
                    }
                }
            }

            if (trigger.phase && trigger.phase.toLowerCase() !== phase.toLowerCase()) {
                continue;
            }

            if (trigger.messageContains) {
                const allContent = messages.map((m) => m.content || "").join(" ");
                const matches =
                    trigger.messageContains instanceof RegExp
                        ? trigger.messageContains.test(allContent)
                        : allContent.includes(trigger.messageContains);
                if (!matches) continue;
            }

            if (trigger.iterationCount !== undefined) {
                if (agentIteration !== trigger.iterationCount) continue;
            }

            if (trigger.previousAgent) {
                if (context.lastContinueCaller !== trigger.previousAgent) continue;
            }

            if (trigger.afterAgent) {
                if (context.lastAgentExecuted !== trigger.afterAgent) continue;
            }

            // All conditions matched
            if (this.config.debug) {
                conversationalLogger.logMatchedResponse(mockResponse);
            }

            // Log the response using conversational logger
            if (this.config.debug && mockResponse.response) {
                conversationalLogger.logAgentResponse(agentName, {
                    content: mockResponse.response.content,
                    toolCalls: mockResponse.response.toolCalls as any,
                    phase,
                    reason: "Mock response matched",
                });
            }

            return mockResponse.response;
        }

        // Return default response
        if (this.config.debug) {
            conversationalLogger.logAgentResponse("unknown", {
                content: this.config.defaultResponse?.content || "Default mock response",
                toolCalls: this.config.defaultResponse?.toolCalls as any,
                reason: "No matching response found, using default",
            });
        }
        return this.config.defaultResponse || { content: "Default mock response" };
    }

    private extractAgentName(systemPrompt: string): string {
        // Try multiple patterns to extract agent name
        const patterns = [
            /You are the ([\w-]+) agent/i,
            /You are ([\w-]+)[\s.]/i,
            /Agent: ([\w-]+)/i,
            /\[Agent: ([\w-]+)\]/i,
        ];

        for (const pattern of patterns) {
            const match = systemPrompt.match(pattern);
            if (match) {
                const name = match[1]?.toLowerCase();
                // Handle special cases
                if (!name || name === "the") continue; // Skip if we accidentally matched "the"
                return name;
            }
        }

        // Check for specific agent keywords
        if (systemPrompt.includes("orchestrator")) return "orchestrator";
        if (systemPrompt.includes("message router")) return "orchestrator";
        if (systemPrompt.includes("execution specialist")) return "executor";
        if (systemPrompt.includes("executor")) return "executor";
        if (systemPrompt.includes("project-manager")) return "project-manager";
        if (systemPrompt.includes("project manager")) return "project-manager";
        if (systemPrompt.includes("planning specialist")) return "planner";
        if (systemPrompt.includes("planner")) return "planner";

        return "unknown";
    }

    private extractPhase(systemPrompt: string): string {
        // Try multiple patterns to extract phase
        const patterns = [
            /Current Phase: (\w+)/i,
            /Phase: (\w+)/i,
            /\[Phase: (\w+)\]/i,
            /in (\w+) phase/i,
        ];

        for (const pattern of patterns) {
            const match = systemPrompt.match(pattern);
            if (match) {
                return match[1]?.toLowerCase() || "unknown";
            }
        }

        return "unknown";
    }

    private recordRequest(
        messages: Message[],
        model: string,
        response: MockLLMResponse["response"]
    ): void {
        this.requestHistory.push({
            messages,
            model,
            response,
            timestamp: new Date(),
        });
    }

    // Helper methods for testing

    addResponse(response: MockLLMResponse): void {
        this.responses.push(response);
        this.responses.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    }

    getRequestHistory(): Array<{
        messages: Message[];
        model?: string;
        response: MockLLMResponse["response"];
    }> {
        return this.requestHistory;
    }

    clearHistory(): void {
        this.requestHistory = [];
    }

    // Method to update context (called by test harness)
    updateContext(updates: {
        conversationId?: string;
        lastContinueCaller?: string;
        iteration?: number;
        lastAgentExecuted?: string;
    }): void {
        const conversationId = updates.conversationId || "default";
        const context = this.getOrCreateContext(conversationId);

        if (updates.lastContinueCaller !== undefined) {
            context.lastContinueCaller = updates.lastContinueCaller;
        }
        if (updates.iteration !== undefined) {
            context.iteration = updates.iteration;
        }
        if (updates.lastAgentExecuted !== undefined) {
            context.lastAgentExecuted = updates.lastAgentExecuted;
        }
    }

    private getOrCreateContext(conversationId: string): {
        iteration: number;
        agentIterations: Map<string, number>;
        lastContinueCaller?: string;
        lastAgentExecuted?: string;
    } {
        if (!this.conversationContext.has(conversationId)) {
            this.conversationContext.set(conversationId, {
                iteration: 0,
                agentIterations: new Map(),
            });
        }
        const context = this.conversationContext.get(conversationId);
        if (!context) {
            throw new Error(`Conversation context not found for ${conversationId}`);
        }
        return context;
    }

    private extractConversationId(): string {
        // Try to extract conversation ID from messages
        // For now, use a default ID
        return "default";
    }
}
