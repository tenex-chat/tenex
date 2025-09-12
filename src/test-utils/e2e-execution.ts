import { Message } from "@/conversations/Message";
import type { 
    E2ETestContext, 
    ExecutionTrace, 
    AgentExecutionResult, 
    RoutingDecision
} from "./e2e-types";

/**
 * Execute agent and return result (internal helper)
 */
async function executeAgentWithResult(
    context: E2ETestContext,
    agentName: string,
    conversationId: string,
    userMessage: string
): Promise<AgentExecutionResult> {
    const result: AgentExecutionResult = {
        message: "",
        toolCalls: []
    };
    
    // Find the agent
    const agent = context.agentRegistry.getAgentBySlug(agentName.toLowerCase());
    
    if (!agent) {
        console.error("Available agents:", context.agentRegistry.getAllAgents().map(a => ({ slug: a.slug, name: a.name })));
        throw new Error(`Agent not found: ${agentName}`);
    }
    
    const conversation = context.conversationCoordinator.getConversation(conversationId);
    if (!conversation) {
        throw new Error(`Conversation not found: ${conversationId}`);
    }
    
    // Execute different behavior for orchestrator vs other agents
    if (agentName.toLowerCase() === "orchestrator") {
        // Build orchestrator messages with routing prompt
        const orchestratorMessages = [
            new Message("system", `You are the orchestrator. Current phase: ${conversation.phase}. You must respond with ONLY a JSON object in this exact format:
{
    "agents": ["agent1", "agent2"],
    "phase": "currentPhase",
    "reason": "Brief explanation"
}
Select appropriate agents for the task. Use ["END"] when conversation is complete.`),
        ];
        
        // Add user message if provided
        if (userMessage) {
            orchestratorMessages.push(new Message("user", userMessage));
        }
        
        // Use the mock LLM directly to get routing decision
        const response = await context.mockLLM.complete({
            messages: orchestratorMessages,
            options: {
                configName: agent.llmConfig || "orchestrator",
                agentName: agent.name
            }
        });
        
        // Stream the response
        if (response.content) {
            result.message = response.content;
        }
    } else {
        // Execute non-orchestrator agents directly with mock LLM
        // Build simple agent messages
        const agentMessages = [
            new Message("system", `You are the ${agent.slug || agent.name} agent. Current Phase: ${conversation.phase}.`),
        ];
        
        if (userMessage) {
            agentMessages.push(new Message("user", userMessage));
        }
        
        // Get response from mock LLM
        const response = await context.mockLLM.complete({
            messages: agentMessages,
            options: {
                configName: agent.llmConfig || agent.name,
                agentName: agent.name
            }
        });
        
        // Stream the response
        if (response.content) {
            result.message = response.content;
        }
        
        // Process tool calls
        if (response.toolCalls && response.toolCalls.length > 0) {
            result.toolCalls = response.toolCalls.map(tc => ({
                id: tc.name || 'mock-tool-call',
                type: 'function' as const,
                function: {
                    name: tc.name,
                    arguments: JSON.stringify(tc.params || {})
                }
            }));
        }
    }
    
    // Result is already logged by the conversational logger in MockLLMService
    
    return result;
}

/**
 * Extract routing decision from orchestrator response
 */
function extractRoutingDecision(orchestratorResult: AgentExecutionResult): RoutingDecision | null {
    try {
        // Orchestrator with routing backend returns JSON
        const content = orchestratorResult.message;
        if (!content) return null;
        
        // Try to parse as JSON
        const parsed = JSON.parse(content);
        if (parsed.agents && Array.isArray(parsed.agents)) {
            return parsed;
        }
    } catch {
        // Not a routing decision
    }
    return null;
}

/**
 * Execute a conversation flow with multiple agents
 */
export async function executeConversationFlow(
    context: E2ETestContext,
    conversationId: string,
    initialMessage: string,
    options?: {
        maxIterations?: number;
        onAgentExecution?: (agent: string, phase: string) => void;
        onPhaseTransition?: (from: string, to: string) => void;
    }
): Promise<ExecutionTrace> {
    const maxIterations = options?.maxIterations || 20;
    let iteration = 0;
    
    const trace: ExecutionTrace = {
        conversationId,
        executions: [],
        toolCalls: [],
        routingDecisions: []
    };
    
    // Track conversation state
    const currentMessage = initialMessage;
    
    while (iteration < maxIterations) {
        iteration++;
        
        // Get current conversation state
        const state = await getConversationState(context, conversationId);
        const currentPhase = state.phase;
        
        // Always execute orchestrator for routing
        const orchestratorResult = await executeAgentWithResult(
            context,
            "orchestrator",
            conversationId,
            iteration === 1 ? currentMessage : ""
        );
        
        // Record orchestrator execution
        trace.executions.push({
            agent: "orchestrator",
            phase: currentPhase,
            timestamp: new Date(),
            message: orchestratorResult.message
        });
        
        // Extract routing decision from orchestrator response
        const routingDecision = extractRoutingDecision(orchestratorResult);
        if (!routingDecision) {
            console.error("Orchestrator response:", orchestratorResult.message);
            throw new Error("Orchestrator did not return valid routing decision");
        }
        
        // Record routing decision
        trace.routingDecisions.push({
            phase: currentPhase,
            decision: routingDecision,
            timestamp: new Date()
        });
        
        // Check for END signal
        if (routingDecision.agents.includes("END")) {
            break;
        }
        
        // Execute each target agent
        for (const targetAgent of routingDecision.agents) {
            if (targetAgent === "END") {
                // Conversation complete
                return trace;
            }
            
            // Notify callback
            if (options?.onAgentExecution) {
                options.onAgentExecution(targetAgent, routingDecision.phase || currentPhase);
            }
            
            // Execute target agent
            const agentResult = await executeAgentWithResult(
                context,
                targetAgent,
                conversationId,
                "" // No message, agent gets context from conversation
            );
            
            // Record agent execution
            trace.executions.push({
                agent: targetAgent,
                phase: routingDecision.phase || currentPhase,
                timestamp: new Date(),
                message: agentResult.message,
                toolCalls: agentResult.toolCalls
            });
            
            // Record tool calls
            if (agentResult.toolCalls) {
                for (const toolCall of agentResult.toolCalls) {
                    // Handle different tool call structures
                    let toolName: string;
                    let toolArgs: any;
                    
                    if (toolCall.function) {
                        // Standard OpenAI-style structure
                        toolName = toolCall.function.name;
                        toolArgs = JSON.parse(toolCall.function.arguments || '{}');
                    } else if (toolCall.name) {
                        // Simplified structure from our mock
                        toolName = toolCall.name;
                        toolArgs = toolCall.params || {};
                    } else {
                        console.warn('Unknown tool call structure:', toolCall);
                        continue;
                    }
                    
                    trace.toolCalls.push({
                        agent: targetAgent,
                        tool: toolName,
                        arguments: toolArgs,
                        timestamp: new Date()
                    });
                    
                    // Check for continue tool - means we need to go back to orchestrator
                    if (toolName === 'continue') {
                        // Update mock LLM context for next iteration
                        if ((context.mockLLM as any).updateContext) {
                            (context.mockLLM as any).updateContext({
                                lastContinueCaller: targetAgent,
                                iteration: iteration,
                            });
                        }
                        
                        // End conversation in specific scenarios:
                        // 1. If certain phases are completed
                        // 2. If workflow is complete
                        // Check if PM agent (first agent in project) completed certain phases
                        const pmAgent = context.projectContext.getProjectManager();
                        const isPMAgent = targetAgent === pmAgent.slug;
                        
                        if (targetAgent === 'orchestrator' || 
                            (isPMAgent && 
                             (routingDecision.phase === 'verification' || routingDecision.phase === 'plan'))) {
                            return trace;
                        }
                    }
                }
            }
            
            // Check for phase transitions
            const newState = await getConversationState(context, conversationId);
            if (newState.phase !== currentPhase) {
                // Phase change detected - record in execution trace
                trace.executions.push({
                    agent: targetAgent,
                    phase: newState.phase,
                    timestamp: new Date(),
                    message: `Phase changed from ${currentPhase} to ${newState.phase}: ${routingDecision.reason}`
                });
                
                if (options?.onPhaseTransition) {
                    options.onPhaseTransition(currentPhase, newState.phase);
                }
            }
        }
    }
    
    return trace;
}

/**
 * Create a new conversation
 */
export async function createConversation(
    context: E2ETestContext,
    userMessage: string = "Test conversation"
): Promise<string> {
    const conversationId = `conv-${Date.now()}`;
    
    // Create conversation in coordinator
    context.conversationCoordinator.createConversation(
        conversationId,
        userMessage,
        null,
        "discovery"
    );
    
    // Initialize conversation with user message
    await context.messageRepo.saveMessage({
        conversationId,
        role: "user",
        content: userMessage,
        timestamp: new Date()
    });
    
    return conversationId;
}

/**
 * Get conversation state
 */
export async function getConversationState(
    context: E2ETestContext,
    conversationId: string
): Promise<{ phase: string; messages: any[] }> {
    const conversation = context.conversationCoordinator.getConversation(conversationId);
    if (!conversation) {
        throw new Error(`Conversation not found: ${conversationId}`);
    }
    
    const messages = await context.messageRepo.getMessages(conversationId);
    
    return {
        phase: conversation.phase,
        messages
    };
}

/**
 * Wait for a specific phase
 */
export async function waitForPhase(
    context: E2ETestContext,
    conversationId: string,
    targetPhase: string,
    timeoutMs: number = 5000
): Promise<boolean> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeoutMs) {
        const state = await getConversationState(context, conversationId);
        if (state.phase === targetPhase) {
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    return false;
}

/**
 * Get tool calls from mock LLM history
 */
export function getToolCallsFromHistory(mockLLM: any): string[] {
    const toolCalls: string[] = [];
    
    // Access the conversational logger from the mock LLM
    if ((mockLLM as any).conversationalLogger) {
        const history = (mockLLM as any).conversationalLogger.getHistory();
        for (const entry of history) {
            if (entry.toolCalls) {
                for (const tc of entry.toolCalls) {
                    toolCalls.push(tc.name);
                }
            }
        }
    }
    
    return toolCalls;
}