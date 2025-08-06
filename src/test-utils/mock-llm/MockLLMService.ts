import type { 
    LLMService, 
    Message,
    CompletionRequest,
    CompletionResponse,
    StreamEvent,
    ToolCall
} from "@/llm/types";
import type { MockLLMConfig, MockLLMResponse } from "./types";
import { logger } from "@/utils/logger";

export class MockLLMService implements LLMService {
    private config: MockLLMConfig;
    private responses: MockLLMResponse[] = [];
    private requestHistory: Array<{
        messages: Message[];
        model?: string;
        response: MockLLMResponse['response'];
        timestamp: Date;
    }> = [];
    
    // Context tracking for enhanced triggers
    private conversationContext: Map<string, {
        lastContinueCaller?: string;
        iteration: number;
        agentIterations: Map<string, number>;
        lastAgentExecuted?: string;
    }> = new Map();

    constructor(config: MockLLMConfig = {}) {
        this.config = config;
        
        // Load responses from scenarios
        if (config.scenarios) {
            for (const scenario of config.scenarios) {
                this.responses.push(...scenario.responses);
            }
        }
        
        // Sort by priority
        this.responses.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    }

    async complete(request: CompletionRequest): Promise<CompletionResponse> {
        const messages = request.messages;
        const model = request.options?.configName || 'mock-model';
        
        const response = this.findMatchingResponse(messages, model);
        
        this.recordRequest(messages, model, response);
        
        if (response.error) {
            throw response.error;
        }
        
        // Simulate delay if specified
        if (response.streamDelay) {
            await new Promise(resolve => setTimeout(resolve, response.streamDelay));
        }
        
        // Convert to CompletionResponse format that matches multi-llm-ts v4
        return {
            type: 'text',
            content: response.content || "",
            toolCalls: response.toolCalls || [],
            usage: {
                prompt_tokens: 100,
                completion_tokens: 50,
                total_tokens: 150
            }
        } as CompletionResponse;
    }

    async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
        const messages = request.messages;
        const model = request.options?.configName || 'mock-model';
        
        const response = this.findMatchingResponse(messages, model);
        
        this.recordRequest(messages, model, response);
        
        if (response.error) {
            yield { type: 'error', error: response.error.message };
            return;
        }
        
        // Simulate streaming content
        if (response.content) {
            const words = response.content.split(' ');
            for (const word of words) {
                yield { type: 'content', content: word + ' ' };
                if (response.streamDelay) {
                    await new Promise(resolve => setTimeout(resolve, response.streamDelay! / words.length));
                }
            }
        }
        
        // Send tool calls
        if (response.toolCalls && response.toolCalls.length > 0) {
            for (const toolCall of response.toolCalls) {
                yield { 
                    type: 'tool_start', 
                    tool: toolCall.function.name,
                    args: JSON.parse(toolCall.function.arguments || '{}')
                };
            }
        }
        
        // Send completion event
        yield { 
            type: 'done', 
            response: {
                type: 'text',
                content: response.content || "",
                toolCalls: response.toolCalls || [],
                usage: {
                    prompt_tokens: 100,
                    completion_tokens: 50,
                    total_tokens: 150
                }
            } as CompletionResponse
        };
    }

    private findMatchingResponse(messages: Message[], model: string): MockLLMResponse['response'] {
        const systemMessage = messages.find(m => m.role === 'system');
        const lastUserMessage = messages.filter(m => m.role === 'user').pop();
        const toolCalls = messages
            .filter(m => m.tool_calls && m.tool_calls.length > 0)
            .flatMap(m => m.tool_calls!.map(tc => tc.function.name));
        
        // Extract agent name and phase from system prompt
        const agentName = this.extractAgentName(systemMessage?.content || '');
        const phase = this.extractPhase(systemMessage?.content || '');
        
        // Get conversation context
        const conversationId = this.extractConversationId(messages);
        const context = this.getOrCreateContext(conversationId);
        
        // Update agent iteration count
        if (!context.agentIterations.has(agentName)) {
            context.agentIterations.set(agentName, 0);
        }
        context.agentIterations.set(agentName, context.agentIterations.get(agentName)! + 1);
        const agentIteration = context.agentIterations.get(agentName)!;
        
        if (this.config.debug) {
            logger.debug('MockLLM: Finding response for', {
                agentName,
                phase,
                lastUserMessage: lastUserMessage?.content?.substring(0, 100),
                toolCalls,
                iteration: context.iteration,
                agentIteration,
                lastContinueCaller: context.lastContinueCaller
            });
        }
        
        // Find matching response
        for (const mockResponse of this.responses) {
            const trigger = mockResponse.trigger;
            
            // Check all trigger conditions
            if (trigger.systemPrompt && systemMessage) {
                const matches = trigger.systemPrompt instanceof RegExp
                    ? trigger.systemPrompt.test(systemMessage.content!)
                    : systemMessage.content!.includes(trigger.systemPrompt);
                if (!matches) continue;
            }
            
            if (trigger.userMessage && lastUserMessage) {
                const matches = trigger.userMessage instanceof RegExp
                    ? trigger.userMessage.test(lastUserMessage.content!)
                    : lastUserMessage.content!.includes(trigger.userMessage);
                if (!matches) continue;
            }
            
            if (trigger.previousToolCalls) {
                const hasAllTools = trigger.previousToolCalls.every(tool => 
                    toolCalls.includes(tool)
                );
                if (!hasAllTools) continue;
            }
            
            if (trigger.agentName && trigger.agentName.toLowerCase() !== agentName.toLowerCase()) {
                continue;
            }
            
            if (trigger.phase && trigger.phase !== phase) {
                continue;
            }
            
            if (trigger.messageContains) {
                const allContent = messages.map(m => m.content || '').join(' ');
                const matches = trigger.messageContains instanceof RegExp
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
                logger.debug('MockLLM: Matched response', mockResponse);
            }
            return mockResponse.response;
        }
        
        // Return default response
        if (this.config.debug) {
            logger.debug('MockLLM: Using default response');
        }
        return this.config.defaultResponse || { content: "Default mock response" };
    }
    
    private extractAgentName(systemPrompt: string): string {
        // Try multiple patterns to extract agent name
        const patterns = [
            /You are the (\w+) agent/i,
            /You are (\w+)/i,
            /Agent: (\w+)/i,
            /\[Agent: (\w+)\]/i
        ];
        
        for (const pattern of patterns) {
            const match = systemPrompt.match(pattern);
            if (match) {
                return match[1].toLowerCase();
            }
        }
        
        // Check for specific agent keywords
        if (systemPrompt.includes('message router')) return 'orchestrator';
        if (systemPrompt.includes('execution specialist')) return 'executor';
        if (systemPrompt.includes('project manager')) return 'project-manager';
        if (systemPrompt.includes('planning specialist')) return 'planner';
        
        return 'unknown';
    }
    
    private extractPhase(systemPrompt: string): string {
        // Try multiple patterns to extract phase
        const patterns = [
            /Current Phase: (\w+)/i,
            /Phase: (\w+)/i,
            /\[Phase: (\w+)\]/i,
            /in (\w+) phase/i
        ];
        
        for (const pattern of patterns) {
            const match = systemPrompt.match(pattern);
            if (match) {
                return match[1].toLowerCase();
            }
        }
        
        return 'unknown';
    }
    
    private recordRequest(
        messages: Message[], 
        model: string, 
        response: MockLLMResponse['response']
    ): void {
        this.requestHistory.push({
            messages,
            model,
            response,
            timestamp: new Date()
        });
    }
    
    // Helper methods for testing
    
    addResponse(response: MockLLMResponse): void {
        this.responses.push(response);
        this.responses.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    }
    
    getRequestHistory() {
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
        const conversationId = updates.conversationId || 'default';
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
    
    private getOrCreateContext(conversationId: string) {
        if (!this.conversationContext.has(conversationId)) {
            this.conversationContext.set(conversationId, {
                iteration: 0,
                agentIterations: new Map()
            });
        }
        return this.conversationContext.get(conversationId)!;
    }
    
    private extractConversationId(messages: Message[]): string {
        // Try to extract conversation ID from messages
        // For now, use a default ID
        return 'default';
    }
}