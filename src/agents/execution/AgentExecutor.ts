import { formatAnyError } from "@/utils/error-formatter";
import type { ConversationManager } from "@/conversations/ConversationManager";
import type { LLMService } from "@/llm/types";
import { NostrPublisher } from "@/nostr";
import { buildSystemPromptMessages } from "@/prompts/utils/systemPromptBuilder";
import { getProjectContext } from "@/services";
import { mcpService } from "@/services/mcp/MCPService";
import {
    type TracingContext,
    createAgentExecutionContext,
    createTracingContext,
} from "@/tracing";
import { logger } from "@/utils/logger";
import type NDK from "@nostr-dev-kit/ndk";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { AgentInstance } from "@/agents/types";
import { Message } from "multi-llm-ts";
import { ReasonActLoop } from "./ReasonActLoop";
import { ClaudeBackend } from "./ClaudeBackend";
import { RoutingBackend } from "./RoutingBackend";
import type { ExecutionBackend } from "./ExecutionBackend";
import type { ExecutionContext } from "./types";
import "@/prompts/fragments/25-orchestrator-routing";
import "@/prompts/fragments/01-specialist-identity";
import "@/prompts/fragments/01-orchestrator-identity";
import "@/prompts/fragments/25-specialist-tools";
import "@/prompts/fragments/85-specialist-reasoning";
import "@/prompts/fragments/15-specialist-available-agents";
import "@/prompts/fragments/15-orchestrator-available-agents";
import { startExecutionTime, stopExecutionTime } from "@/conversations/executionTime";
import { createExecutionLogger } from "@/logging/ExecutionLogger";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";

export class AgentExecutor {
    constructor(
        private llmService: LLMService,
        ndk: NDK,
        private conversationManager: ConversationManager
    ) {}

    /**
     * Get the appropriate execution backend based on agent configuration
     */
    private getBackend(agent: AgentInstance): ExecutionBackend {
        const backendType = agent.backend || "reason-act-loop";

        switch (backendType) {
            case "claude":
                return new ClaudeBackend();
            case "routing":
                return new RoutingBackend(this.llmService, this.conversationManager);
            case "reason-act-loop":
            default:
                return new ReasonActLoop(this.llmService, this.conversationManager);
        }
    }

    /**
     * Execute an agent's assignment for a conversation with streaming
     */
    async execute(context: ExecutionContext, parentTracingContext?: TracingContext): Promise<void> {
        // Create agent execution tracing context
        const tracingContext = parentTracingContext
            ? createAgentExecutionContext(parentTracingContext, context.agent.name)
            : createAgentExecutionContext(
                  createTracingContext(context.conversationId),
                  context.agent.name
              );
        
        const executionLogger = createExecutionLogger(tracingContext, "agent");

        // Build messages first to get the Claude session ID
        const messages = await this.buildMessages(context, context.triggeringEvent);
        
        // Get the Claude session ID from the conversation state
        const conversation = this.conversationManager.getConversation(context.conversationId);
        const agentState = conversation?.agentStates.get(context.agent.slug);
        const claudeSessionId = context.claudeSessionId || agentState?.claudeSessionId;
        
        if (claudeSessionId) {
            logger.info(`[AgentExecutor] Found Claude session ID for agent ${context.agent.slug}`, {
                conversationId: context.conversationId,
                agentSlug: context.agent.slug,
                sessionId: claudeSessionId,
                source: context.claudeSessionId ? "triggering-event" : "agent-context"
            });
        }

        // Build full context with additional properties
        const fullContext: ExecutionContext = {
            ...context,
            publisher:
                context.publisher ||
                new NostrPublisher({
                    conversationId: context.conversationId,
                    agent: context.agent,
                    triggeringEvent: context.triggeringEvent,
                    conversationManager: this.conversationManager,
                }),
            conversationManager: context.conversationManager || this.conversationManager,
            agentExecutor: this, // Pass this AgentExecutor instance for continue() tool
            claudeSessionId, // Pass the determined session ID
        };

        try {
            // Get fresh conversation data for execution time tracking
            const conversation = context.conversationManager.getConversation(
                context.conversationId
            );
            if (!conversation) {
                throw new Error(`Conversation ${context.conversationId} not found`);
            }

            // Start execution time tracking
            startExecutionTime(conversation);
            
            // Log execution flow start
            executionLogger.logEvent({
                type: "execution_start",
                timestamp: new Date(),
                conversationId: context.conversationId,
                agent: context.agent.name,
                narrative: `Agent ${context.agent.name} starting execution in ${context.phase} phase`
            });

            // Publish typing indicator start (skip for orchestrator)
            if (!context.agent.isOrchestrator) {
                await fullContext.publisher.publishTypingIndicator("start");
            }

            await this.executeWithStreaming(fullContext, messages, tracingContext);
            
            // Log execution flow complete
            executionLogger.logEvent({
                type: "execution_complete",
                timestamp: new Date(),
                conversationId: context.conversationId,
                agent: context.agent.name,
                narrative: `Agent ${context.agent.name} completed execution successfully`,
                success: true
            });

            // Stop typing indicator after successful execution (skip for orchestrator)
            if (!context.agent.isOrchestrator) {
                await fullContext.publisher.publishTypingIndicator("stop");
            }
            
            // Clean up the publisher resources
            await fullContext.publisher.cleanup();

            // Conversation updates are now handled by NostrPublisher
        } catch (error) {
            // Log execution flow failure
            executionLogger.logEvent({
                type: "execution_complete",
                timestamp: new Date(),
                conversationId: context.conversationId,
                agent: context.agent.name,
                narrative: `Agent ${context.agent.name} execution failed: ${formatAnyError(error)}`,
                success: false
            });
            // Stop execution time tracking even on error
            const conversation = context.conversationManager.getConversation(
                context.conversationId
            );
            if (conversation) {
                stopExecutionTime(conversation);
            }

            // Conversation saving is now handled by NostrPublisher

            // Ensure typing indicator is stopped even on error (skip for orchestrator)
            if (!context.agent.isOrchestrator) {
                await fullContext.publisher.publishTypingIndicator("stop");
            }
            
            // Clean up the publisher resources
            await fullContext.publisher.cleanup();

            throw error;
        }
    }

    /**
     * Build the messages array for the agent execution
     */
    private async buildMessages(
        context: ExecutionContext,
        _triggeringEvent: NDKEvent
    ): Promise<Message[]> {
        const projectCtx = getProjectContext();
        const project = projectCtx.project;

        // Get fresh conversation data
        const conversation = context.conversationManager.getConversation(context.conversationId);
        if (!conversation) {
            throw new Error(`Conversation ${context.conversationId} not found`);
        }

        // Create tag map for efficient lookup
        const tagMap = new Map<string, string>();
        for (const tag of project.tags) {
            if (tag.length >= 2 && tag[0] && tag[1]) {
                tagMap.set(tag[0], tag[1]);
            }
        }

        // Get all available agents for handoffs
        const availableAgents = Array.from(projectCtx.agents.values());

        const messages: Message[] = [];

        // Get MCP tools for the prompt
        const mcpTools = mcpService.getCachedTools();

        // Build system prompt using the shared function
        // Only pass the current agent's lessons
        const agentLessonsMap = new Map<
            string,
            NDKAgentLesson[]
        >();
        const currentAgentLessons = projectCtx.getLessonsForAgent(context.agent.pubkey);
        
        if (currentAgentLessons.length > 0) {
            agentLessonsMap.set(context.agent.pubkey, currentAgentLessons);
        }

        // Build system prompt messages for all agents (including orchestrator)
        const systemMessages = buildSystemPromptMessages({
            agent: context.agent,
            phase: context.phase,
            project,
            availableAgents,
            conversation,
            agentLessons: agentLessonsMap,
            mcpTools,
            triggeringEvent: context.triggeringEvent,
        });

        // Add all system messages
        for (const systemMsg of systemMessages) {
            messages.push(systemMsg.message);
        }

        // Check for #debug flag in triggering event content
        const hasDebugFlag = context.triggeringEvent?.content?.includes("#debug");
        if (hasDebugFlag) {
            const debugMetaCognitionPrompt = `
=== DEBUG MODE: META-COGNITIVE ANALYSIS REQUESTED ===

The user has included "#debug" in their message. They are asking you to explain your decision-making process.

Provide a transparent, honest analysis of:

1. **System Prompt Influence**: Which specific parts of your system prompt or instructions guided this decision
2. **Reasoning Chain**: The step-by-step thought process that led to your choice
3. **Alternatives Considered**: Other approaches you evaluated but didn't choose, and why
4. **Assumptions Made**: Any implicit assumptions about the project, user needs, or context
5. **Constraints Applied**: Technical, architectural, or guideline constraints that limited options
6. **Confidence Level**: How certain you were about this decision and any doubts you had
7. **Pattern Matching**: If you followed a common pattern or best practice, explain why it seemed applicable

Be completely transparent about your internal process. If you made a mistake or could have done better, acknowledge it. The goal is to help the user understand exactly how you arrived at your decision.
=== END DEBUG MODE ===`;
            
            messages.push(new Message("system", debugMetaCognitionPrompt));
            logger.info(`[AgentExecutor] Debug mode activated for agent ${context.agent.name}`, {
                conversationId: context.conversationId,
                agentSlug: context.agent.slug
            });
        }

        // Orchestrator gets structured routing context, others get conversation transcript
        if (context.agent.isOrchestrator) {
            const routingContext = await context.conversationManager.buildOrchestratorRoutingContext(
                context.conversationId,
                context.triggeringEvent
            );
            
            // Send as structured JSON to orchestrator
            messages.push(new Message("user", JSON.stringify(routingContext, null, 2)));
        } else {
            // Use the existing buildAgentMessages method for non-orchestrator agents
            const { messages: agentMessages } = await context.conversationManager.buildAgentMessages(
                context.conversationId,
                context.agent,
                context.triggeringEvent,
                context.handoff
            );

            // Add the agent's messages
            messages.push(...agentMessages);
        }

        return messages;
    }

    /**
     * Execute with streaming support
     */
    private async executeWithStreaming(
        context: ExecutionContext,
        messages: Message[],
        _tracingContext: TracingContext
    ): Promise<void> {
        // Get tools for response processing - use agent's configured tools
        const tools = context.agent.tools || [];

        // Add MCP tools if available and agent has MCP access
        let allTools = tools;
        if (context.agent.mcp !== false) {
            const mcpTools = mcpService.getCachedTools();
            allTools = [...tools, ...mcpTools];
        }

        // Get the appropriate backend for this agent
        const backend = this.getBackend(context.agent);

        // Execute using the backend - all backends now use the same interface
        await backend.execute(messages, allTools, context, context.publisher);
    }
}
