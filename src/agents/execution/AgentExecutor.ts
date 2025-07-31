import type { ConversationManager } from "@/conversations/ConversationManager";
import type { LLMService } from "@/llm/types";
import { NostrPublisher } from "@/nostr";
import { buildSystemPrompt } from "@/prompts/utils/systemPromptBuilder";
import { getProjectContext } from "@/services";
import { mcpService } from "@/services/mcp/MCPService";
import {
    type TracingContext,
    createAgentExecutionContext,
    createTracingContext,
    createTracingLogger,
} from "@/tracing";
import { logger } from "@/utils/logger";
import type NDK from "@nostr-dev-kit/ndk";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { Message } from "multi-llm-ts";
import { ReasonActLoop } from "./ReasonActLoop";
import { ClaudeBackend } from "./ClaudeBackend";
import { RoutingBackend } from "./RoutingBackend";
import type { ExecutionBackend } from "./ExecutionBackend";
import type { ExecutionContext } from "./types";
import "@/prompts/fragments/available-agents";
import "@/prompts/fragments/orchestrator-routing";
import "@/prompts/fragments/expertise-boundaries";
import "@/prompts/fragments/domain-expert-guidelines";
import { startExecutionTime, stopExecutionTime } from "@/conversations/executionTime";
import { createExecutionLogger, type ExecutionLogger } from "@/logging/ExecutionLogger";

export class AgentExecutor {
    constructor(
        private llmService: LLMService,
        private ndk: NDK,
        private conversationManager: ConversationManager
    ) {}

    /**
     * Get the appropriate execution backend based on agent configuration
     */
    private getBackend(agent: import("@/agents/types").Agent): ExecutionBackend {
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

        // Ensure context has publisher and conversationManager
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
                type: "execution_flow_start",
                conversationId: context.conversationId,
                narrative: `Agent ${context.agent.name} starting execution in ${context.phase} phase`
            });

            // 1. Build the agent's messages
            const messages = await this.buildMessages(fullContext, fullContext.triggeringEvent);

            // 2. Publish typing indicator start
            await fullContext.publisher.publishTypingIndicator("start");

            await this.executeWithStreaming(fullContext, messages, tracingContext);
            
            // Log execution flow complete
            executionLogger.logEvent({
                type: "execution_flow_complete",
                conversationId: context.conversationId,
                narrative: `Agent ${context.agent.name} completed execution successfully`,
                success: true
            });

            // Conversation updates are now handled by NostrPublisher
        } catch (error) {
            // Log execution flow failure
            executionLogger.logEvent({
                type: "execution_flow_complete",
                conversationId: context.conversationId,
                narrative: `Agent ${context.agent.name} execution failed: ${error instanceof Error ? error.message : String(error)}`,
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

            // Ensure typing indicator is stopped even on error
            await fullContext.publisher.publishTypingIndicator("stop");

            throw error;
        }
    }

    /**
     * Build the messages array for the agent execution
     */
    private async buildMessages(
        context: ExecutionContext,
        triggeringEvent: NDKEvent
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

        // No need to load inventory or context files here anymore
        // The fragment handles this internally

        // Get all available agents for handoffs
        const availableAgents = Array.from(projectCtx.agents.values());

        const messages: Message[] = [];

        // Get MCP tools for the prompt
        const mcpTools = await mcpService.getAvailableTools();

        // Build system prompt using the shared function
        // Only pass the current agent's lessons
        const agentLessonsMap = new Map<
            string,
            import("@/events/NDKAgentLesson").NDKAgentLesson[]
        >();
        const currentAgentLessons = projectCtx.getLessonsForAgent(context.agent.pubkey);
        if (currentAgentLessons.length > 0) {
            agentLessonsMap.set(context.agent.pubkey, currentAgentLessons);
        }

        const systemPrompt = buildSystemPrompt({
            agent: context.agent,
            phase: context.phase,
            projectTitle: tagMap.get("title") || "Untitled Project",
            projectRepository: tagMap.get("repo"),
            availableAgents,
            conversation,
            agentLessons: agentLessonsMap,
            mcpTools,
        });

        messages.push(new Message("system", systemPrompt));

        // Use agent's isolated context instead of full history
        let agentContext = context.conversationManager.getAgentContext(
            context.conversationId,
            context.agent.slug
        );

        // If no context exists, this agent is being invoked for the first time
        if (!agentContext) {
            // Check if this is a handoff from another agent
            const handoff = context.handoff;

            if (handoff) {
                logger.info("[AGENT_EXECUTOR] Creating context from handoff", {
                    fromAgent: handoff.agentName,
                    toAgent: context.agent.slug,
                    handoffMessage: `${handoff.message.substring(0, 100)}...`,
                });

                // Create context with handoff information
                agentContext = context.conversationManager.createAgentContext(
                    context.conversationId,
                    context.agent.slug,
                    handoff
                );
            } else {
                // Bootstrap context for direct invocation (e.g., p-tag mention)
                agentContext = await context.conversationManager.bootstrapAgentContext(
                    context.conversationId,
                    context.agent.slug,
                    context.triggeringEvent
                );
            }
        } else {
            await context.conversationManager.synchronizeAgentContext(
                context.conversationId,
                context.agent.slug,
                context.triggeringEvent
            );
        }

        // Add the agent's isolated messages
        messages.push(...agentContext.messages);

        return messages;
    }

    /**
     * Execute with streaming support
     */
    private async executeWithStreaming(
        context: ExecutionContext,
        messages: Message[],
        tracingContext: TracingContext
    ): Promise<void> {
        // Get tools for response processing - use agent's configured tools
        const tools = context.agent.tools || [];

        // Add MCP tools if available and agent has MCP access
        let allTools = tools;
        if (context.agent.mcp !== false) {
            const mcpTools = await mcpService.getAvailableTools();
            allTools = [...tools, ...mcpTools];
        }

        // Get the appropriate backend for this agent
        const backend = this.getBackend(context.agent);

        // Execute using the backend - all backends now use the same interface
        await backend.execute(messages, allTools, context, context.publisher);
    }
}
