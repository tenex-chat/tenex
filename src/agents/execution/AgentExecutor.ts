import type { AgentInstance } from "@/agents/types";
import type { ConversationCoordinator } from "@/conversations/ConversationCoordinator";
import type { LLMService } from "@/llm/types";
import type { EventContext } from "@/nostr/AgentEventEncoder";
import { AgentPublisher } from "@/nostr/AgentPublisher";
import {
  buildStandaloneSystemPromptMessages,
  buildSystemPromptMessages,
} from "@/prompts/utils/systemPromptBuilder";
import { getProjectContext, isProjectContextInitialized } from "@/services";
import { mcpService } from "@/services/mcp/MCPService";
import { type TracingContext, createAgentExecutionContext, createTracingContext } from "@/tracing";
import { formatAnyError } from "@/utils/error-formatter";
import { logger } from "@/utils/logger";
import type { NDKEvent, NDKPrivateKeySigner, NDKProject } from "@nostr-dev-kit/ndk";
import { Message } from "multi-llm-ts";
import { ReasonActLoop } from "./ReasonActLoop";
import type { ExecutionContext } from "./types";
import "@/prompts/fragments/01-specialist-identity";
import "@/prompts/fragments/25-specialist-tools";
import "@/prompts/fragments/85-specialist-reasoning";
import "@/prompts/fragments/15-specialist-available-agents";
import { startExecutionTime, stopExecutionTime } from "@/conversations/executionTime";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { createExecutionLogger } from "@/logging/UnifiedLogger";

/**
 * Minimal context for standalone agent execution
 */
export interface StandaloneAgentContext {
  agents: Map<string, AgentInstance>;
  pubkey: string;
  signer: NDKPrivateKeySigner;
  project?: NDKProject;
  getLessonsForAgent?: (pubkey: string) => NDKAgentLesson[];
}

export class AgentExecutor {
  constructor(
    private llmService: LLMService,
    private conversationCoordinator: ConversationCoordinator,
    private standaloneContext?: StandaloneAgentContext
  ) {}


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
    const conversation = this.conversationCoordinator.getConversation(context.conversationId);
    const agentState = conversation?.agentStates.get(context.agent.slug);
    const claudeSessionId =
      context.claudeSessionId || agentState?.claudeSessionsByPhase?.[context.phase];

    if (claudeSessionId) {
      logger.info(`[AgentExecutor] Found Claude session ID for agent ${context.agent.slug}`, {
        conversationId: context.conversationId,
        agentSlug: context.agent.slug,
        sessionId: claudeSessionId,
        source: context.claudeSessionId ? "triggering-event" : "agent-context",
      });
    }

    // Create AgentPublisher first so we can include it in context
    const agentPublisher = new AgentPublisher(
      context.agent, 
      context.conversationCoordinator || this.conversationCoordinator
    );

    // Build full context with additional properties
    const fullContext: ExecutionContext = {
      ...context,
      conversationCoordinator: context.conversationCoordinator || this.conversationCoordinator,
      agentPublisher, // Include the shared AgentPublisher instance
      claudeSessionId, // Pass the determined session ID
    };

    try {
      // Get fresh conversation data for execution time tracking
      const conversation = context.conversationCoordinator.getConversation(context.conversationId);
      if (!conversation) {
        throw new Error(`Conversation ${context.conversationId} not found`);
      }

      // Start execution time tracking
      startExecutionTime(conversation);

      // Log execution flow start
      await executionLogger.logEvent(
        "execution_start",
        {
          narrative: `Agent ${context.agent.name} starting execution in ${context.phase} phase`,
        }
      );

      // Publish typing indicator start using AgentPublisher
      const eventContext: EventContext = {
        triggeringEvent: context.triggeringEvent,
        rootEvent: conversation.history[0] ?? context.triggeringEvent, // Use triggering event as fallback
        conversationId: context.conversationId,
      };
      await agentPublisher.typing({ type: "typing", state: "start" }, eventContext);

      await this.executeWithStreaming(fullContext, messages);

      // Log execution flow complete
      await executionLogger.logEvent(
        "execution_complete",
        {
          narrative: `Agent ${context.agent.name} completed execution successfully`,
          success: true,
        }
      );

      // Stop typing indicator after successful execution
      await agentPublisher.typing({ type: "typing", state: "stop" }, eventContext);
    } catch (error) {
      // Log execution flow failure
      await executionLogger.logEvent(
        "execution_complete",
        {
          narrative: `Agent ${context.agent.name} execution failed: ${formatAnyError(error)}`,
          success: false,
        }
      );
      // Stop execution time tracking even on error
      const conversation = context.conversationCoordinator.getConversation(context.conversationId);
      if (conversation) {
        stopExecutionTime(conversation);
      }

      // Ensure typing indicator is stopped even on error
      try {
        const eventContext: EventContext = {
          triggeringEvent: context.triggeringEvent,
          rootEvent: conversation?.history[0] ?? context.triggeringEvent,
          conversationId: context.conversationId,
        };
        await agentPublisher.typing({ type: "typing", state: "stop" }, eventContext);
      } catch (typingError) {
        logger.warn("Failed to stop typing indicator", { error: formatAnyError(typingError) });
      }

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
    const messages: Message[] = [];

    // Get fresh conversation data
    const conversation = context.conversationCoordinator.getConversation(context.conversationId);
    if (!conversation) {
      throw new Error(`Conversation ${context.conversationId} not found`);
    }

    // Get MCP tools for the prompt
    const mcpTools = mcpService.getCachedTools();

    // Check if we're in standalone mode or project mode
    if (this.standaloneContext) {
      // Standalone mode - use minimal context
      const availableAgents = Array.from(this.standaloneContext.agents.values());

      // Get lessons if available
      const agentLessonsMap = new Map<string, NDKAgentLesson[]>();
      if (this.standaloneContext.getLessonsForAgent) {
        const lessons = this.standaloneContext.getLessonsForAgent(context.agent.pubkey);
        if (lessons.length > 0) {
          agentLessonsMap.set(context.agent.pubkey, lessons);
        }
      }

      // Build standalone system prompt
      const systemMessages = buildStandaloneSystemPromptMessages({
        agent: context.agent,
        phase: context.phase,
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
    } else if (isProjectContextInitialized()) {
      // Project mode - use full project context
      const projectCtx = getProjectContext();
      const project = projectCtx.project;

      // Create tag map for efficient lookup
      const tagMap = new Map<string, string>();
      for (const tag of project.tags) {
        if (tag.length >= 2 && tag[0] && tag[1]) {
          tagMap.set(tag[0], tag[1]);
        }
      }

      // Get all available agents for handoffs
      const availableAgents = Array.from(projectCtx.agents.values());

      // Build system prompt using the shared function
      // Only pass the current agent's lessons
      const agentLessonsMap = new Map<string, NDKAgentLesson[]>();
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
    } else {
      // Fallback: No context available - use absolute minimal prompt
      logger.warn("No context available for agent execution, using minimal prompt");
      messages.push(
        new Message("system", `You are ${context.agent.name}. ${context.agent.instructions || ""}`)
      );
    }

    // Add special instruction if this is a reactivation after delegation completion
    if (context.isDelegationCompletion) {
      logger.info("[AgentExecutor] 🔄 DELEGATION COMPLETION: Agent resumed after delegation", {
        agent: context.agent.name,
        triggeringEventId: context.triggeringEvent?.id?.substring(0, 8),
        triggeringEventPubkey: context.triggeringEvent?.pubkey?.substring(0, 8),
        mode: "delegation-completion",
      });

      const delegationCompletionInstruction = `
=== CRITICAL: DELEGATION COMPLETION NOTIFICATION ===

STOP! A delegated task has JUST BEEN COMPLETED. The response is in the conversation above.

YOU MUST:
1. Use ONLY the complete() tool to pass the result back to the user
2. Do NOT use ANY other tools
3. Do NOT delegate again - the task is ALREADY DONE

THE TASK IS COMPLETE. DO NOT REPEAT IT.

Use EXACTLY ONE tool call: complete() with the result from the conversation above.

DO NOT use delegate(), delegate_phase(), or any other tool.
ONLY use complete().

=== END CRITICAL NOTIFICATION ===`;

      messages.push(new Message("system", delegationCompletionInstruction));
      logger.info(`[AgentExecutor] 🔁 Starting delegation completion flow for ${context.agent.name}`, {
        conversationId: context.conversationId,
        agentSlug: context.agent.slug,
        mode: "delegation-completion",
        reason: "delegation-completed",
      });
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
        agentSlug: context.agent.slug,
      });
    }

    // All agents now get conversation transcript
    const { messages: agentMessages } = await context.conversationCoordinator.buildAgentMessages(
      context.conversationId,
      context.agent,
      context.triggeringEvent
    );

    // Add the agent's messages
    messages.push(...agentMessages);

    return messages;
  }

  /**
   * Execute with streaming support
   */
  private async executeWithStreaming(
    context: ExecutionContext,
    messages: Message[]
  ): Promise<void> {
    // Get tools for response processing - use agent's configured tools
    const tools = context.agent.tools || [];

    // Add MCP tools if available and agent has MCP access
    let allTools = tools;
    if (context.agent.mcp !== false) {
      const mcpTools = mcpService.getCachedTools();
      allTools = [...tools, ...mcpTools];
    }

    const ral = new ReasonActLoop(this.llmService);
    await ral.execute(messages, allTools, context);
  }
}
