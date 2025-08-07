import type { LLMService } from "@/llm/types";
import type { NostrPublisher } from "@/nostr/NostrPublisher";
import type { Tool } from "@/tools/types";
import { getProjectContext } from "@/services/ProjectContext";
import { createTracingLogger, type TracingLogger, createTracingContext } from "@/tracing";
import { Message } from "multi-llm-ts";
import { z } from "zod";
import type { ConversationManager } from "@/conversations/ConversationManager";
import type { ExecutionBackend } from "./ExecutionBackend";
import type { ExecutionContext } from "./types";
import { formatAnyError } from "@/utils/error-formatter";
import type { Phase } from "@/conversations/phases";
import { createExecutionLogger, type ExecutionLogger } from "@/logging/ExecutionLogger";
import { createNostrPublisher } from "@/nostr/factory";
import { findAgentByName } from "@/agents/utils";

// Schema for routing decisions
const RoutingDecisionSchema = z.object({
    agents: z.array(z.string()).min(1).describe("Agent slugs to route to"),
    phase: z.string().optional().describe("Target phase (optional)"),
    reason: z.string().describe("Reasoning for this routing decision")
});

type RoutingDecision = z.infer<typeof RoutingDecisionSchema>;

export class RoutingBackend implements ExecutionBackend {
    constructor(
        private llmService: LLMService,
        private conversationManager: ConversationManager
    ) {}

    async execute(
        messages: Message[],
        tools: Tool[], // Ignored - routing backend doesn't use tools
        context: ExecutionContext,
        _publisher: NostrPublisher
    ): Promise<void> {
        const tracingContext = context.tracingContext || createTracingContext(context.conversationId);
        const tracingLogger = createTracingLogger(tracingContext, "agent");
        const executionLogger = createExecutionLogger(tracingContext, "agent");

        try {
            // Log routing analysis start (removed - not in new event system)

            // Get routing decision from LLM
            const routingDecision = await this.getRoutingDecision(messages, context, tracingLogger, executionLogger);
            
            // Log routing decision with ExecutionLogger
            executionLogger.routingDecision(
                context.agent.name,
                routingDecision.agents,
                routingDecision.reason,
                {
                    targetPhase: routingDecision.phase as Phase
                }
            );

            // Start a new orchestrator turn to track this routing decision
            const turnId = await this.conversationManager.startOrchestratorTurn(
                context.conversationId,
                (routingDecision.phase || context.phase) as Phase,
                routingDecision.agents,
                routingDecision.reason
            );
            
            tracingLogger.info("Started orchestrator turn", {
                turnId,
                phase: routingDecision.phase || context.phase,
                agents: routingDecision.agents,
                reason: routingDecision.reason
            });

            // Update phase if transitioning
            if (routingDecision.phase && routingDecision.phase !== context.phase) {
                await this.conversationManager.updatePhase(
                    context.conversationId,
                    routingDecision.phase as Phase,
                    `Phase transition: ${routingDecision.reason}`,
                    context.agent.pubkey,
                    context.agent.name,
                    routingDecision.reason
                );
            }

            // Get the AgentExecutor from context
            const agentExecutor = context.agentExecutor;
            if (!agentExecutor) {
                throw new Error("AgentExecutor not available in context");
            }

            // Execute target agents
            const projectContext = getProjectContext();
            for (const agentSlug of routingDecision.agents) {
                // Handle special END agent to cleanly terminate conversation
                if (agentSlug === "END") {
                    tracingLogger.info("🛑 END agent detected - terminating conversation", {
                        reason: routingDecision.reason
                    });
                    // Log the end of conversation
                    executionLogger.logEvent({
                        type: "execution_complete",
                        timestamp: new Date(),
                        conversationId: context.conversationId,
                        agent: context.agent.name,
                        narrative: routingDecision.reason,
                        success: true
                    });
                    // Don't execute any more agents
                    break;
                }

                // Find agent using normalized name matching
                const targetAgent = findAgentByName(projectContext.agents, agentSlug);
                
                if (!targetAgent) {
                    tracingLogger.warning("Target agent not found", { slug: agentSlug });
                    
                    // Provide feedback to orchestrator about invalid agent name
                    const availableAgents = Array.from(projectContext.agents.keys());
                    
                    // Send feedback message back through the orchestrator
                    await this.sendRoutingFeedback(
                        context,
                        agentSlug,
                        availableAgents,
                        routingDecision.reason
                    );
                    
                    continue;
                }

                // Create a new publisher for the target agent
                const targetPublisher = await createNostrPublisher({
                    conversationId: context.conversationId,
                    agent: targetAgent,
                    triggeringEvent: context.triggeringEvent,
                    conversationManager: this.conversationManager,
                });

                const targetContext: ExecutionContext = {
                    ...context,
                    agent: targetAgent,
                    phase: (routingDecision.phase || context.phase) as Phase,
                    publisher: targetPublisher,
                };

                try {
                    await agentExecutor.execute(targetContext);
                } catch (error) {
                    tracingLogger.error("Failed to execute target agent", {
                        agent: targetAgent.name,
                        error: formatAnyError(error),
                    });
                    // Continue with other agents even if one fails
                }
            }
        } catch (error) {
            tracingLogger.error("Routing backend error", {
                error: formatAnyError(error)
            });
            throw error;
        }
    }

    private async sendRoutingFeedback(
        context: ExecutionContext,
        invalidAgentSlug: string,
        availableAgents: string[],
        originalReason: string
    ): Promise<void> {
        const tracingLogger = createTracingLogger(context.tracingContext || createTracingContext(context.conversationId), "agent");
        const executionLogger = createExecutionLogger(context.tracingContext || createTracingContext(context.conversationId), "agent");
        
        // Create a feedback message that will help the orchestrator learn
        const feedbackMessage = new Message("system", `
ROUTING ERROR: The agent "${invalidAgentSlug}" does not exist.

Available agent slugs (use these exact values):
${availableAgents.map(slug => `- ${slug}`).join('\n')}

Common mistakes:
- "Project Manager" should be "project-manager"
- "Human Replica" should be "human-replica"
- Agent names are case-sensitive and use kebab-case

Original routing reason: ${originalReason}

Please re-route using the correct agent slug from the list above.`);

        // Store this as a lesson for future reference
        const lesson = {
            scenario: `Routing to agent "${invalidAgentSlug}"`,
            mistake: `Used incorrect agent slug "${invalidAgentSlug}"`,
            correction: `Should use one of: ${availableAgents.join(', ')}`,
            timestamp: new Date().toISOString()
        };
        
        tracingLogger.info("📚 Routing lesson learned", lesson);
        
        // Log the feedback (removed - not in new event system)
        
        // Build messages with the feedback
        const { messages: agentMessages } = await context.conversationManager.buildAgentMessages(
            context.conversationId,
            context.agent,
            context.triggeringEvent
        );
        
        // Add feedback message after the agent messages
        const messagesWithFeedback = [...agentMessages, feedbackMessage];
        
        // Re-attempt routing with the feedback
        try {
            const correctedDecision = await this.getRoutingDecision(
                messagesWithFeedback,
                context,
                tracingLogger,
                executionLogger
            );
            
            tracingLogger.info("📍 Corrected routing decision", {
                originalTarget: invalidAgentSlug,
                correctedTargets: correctedDecision.agents,
                reason: correctedDecision.reason
            });
            
            // Execute the corrected routing
            const projectContext = getProjectContext();
            for (const agentSlug of correctedDecision.agents) {
                // Use the same normalized finding logic
                const targetAgent = findAgentByName(projectContext.agents, agentSlug);
                    
                if (targetAgent) {
                    const targetPublisher = await createNostrPublisher({
                        conversationId: context.conversationId,
                        agent: targetAgent,
                        triggeringEvent: context.triggeringEvent,
                        conversationManager: this.conversationManager,
                    });

                    const targetContext: ExecutionContext = {
                        ...context,
                        agent: targetAgent,
                        phase: (correctedDecision.phase || context.phase) as Phase,
                        publisher: targetPublisher,
                    };

                    await context.agentExecutor?.execute(targetContext);
                }
            }
        } catch (error) {
            tracingLogger.error("Failed to correct routing after feedback", {
                error: formatAnyError(error)
            });
        }
    }

    private async getRoutingDecision(
        messages: Message[], 
        context: ExecutionContext,
        tracingLogger: TracingLogger,
        executionLogger?: ExecutionLogger
    ): Promise<RoutingDecision> {
        // Add instruction to return JSON only
        const routingMessages = [
            ...messages,
            new Message("system", `
You must respond with ONLY a JSON object in this exact format:
{
    "agents": ["agent-slug"],
    "phase": "phase-name",
    "reason": "Your reasoning here"
}

No other text, only valid JSON.`)
        ];

        // Use regular completion but parse the JSON response
        const response = await this.llmService.complete({
            messages: routingMessages,
            options: {
                configName: context.agent.llmConfig || "orchestrator",
                agentName: context.agent.name,
                temperature: 0.3, // Lower temperature for consistent routing
            }
        });

        if (response.type !== "text") {
            throw new Error("Expected text response from LLM");
        }
        
        // Extract and log reasoning if present in the response
        // (agentThinking removed - not in new event system)

        try {
            // Parse the JSON response
            const content = (response.content || "").trim();
            // Extract JSON if it's wrapped in markdown code blocks
            const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/) || 
                             content.match(/(\{[\s\S]*\})/);
            
            if (!jsonMatch) {
                throw new Error("No JSON found in response");
            }

            const parsed = JSON.parse(jsonMatch[1] || "{}");
            
            // Validate with Zod schema
            const result = RoutingDecisionSchema.safeParse(parsed);
            if (!result.success) {
                throw new Error(`Invalid routing decision: ${result.error.message}`);
            }

            return result.data;
        } catch (error) {
            tracingLogger.error("Failed to parse routing decision", {
                response: response.content,
                error: error instanceof Error ? error.message : String(error)
            });
            throw new Error(`Failed to parse routing decision: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}