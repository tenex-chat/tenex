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
import type { Phase } from "@/conversations/phases";
import { createExecutionLogger, type ExecutionLogger } from "@/logging/ExecutionLogger";
import { createNostrPublisher } from "@/nostr/factory";

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
            // Log routing analysis start
            executionLogger.logEvent({
                type: "routing_analysis",
                agent: context.agent.name,
                messageAnalysis: "Analyzing message for routing",
                candidateAgents: Array.from(getProjectContext().agents.keys())
            });

            // Get routing decision from LLM
            const routingDecision = await this.getRoutingDecision(messages, context, tracingLogger, executionLogger);
            
            tracingLogger.info("📍 Routing decision made", {
                targetAgents: routingDecision.agents,
                targetPhase: routingDecision.phase,
                reason: routingDecision.reason
            });
            
            // Log routing decision with ExecutionLogger
            executionLogger.routingDecision(
                context.agent.name,
                routingDecision.agents,
                routingDecision.reason,
                {
                    targetPhase: routingDecision.phase as Phase,
                    confidence: 0.9
                }
            );

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
                        type: "execution_flow_complete" as const,
                        conversationId: context.conversationId,
                        narrative: routingDecision.reason,
                        success: true
                    });
                    // Don't execute any more agents
                    break;
                }

                // Find agent by slug (case-insensitive)
                let targetAgent = projectContext.agents.get(agentSlug);
                
                // If not found, try case-insensitive search
                if (!targetAgent) {
                    const lowerCaseSlug = agentSlug.toLowerCase();
                    for (const [key, agent] of projectContext.agents.entries()) {
                        if (key.toLowerCase() === lowerCaseSlug) {
                            targetAgent = agent;
                            break;
                        }
                    }
                }
                
                if (!targetAgent) {
                    tracingLogger.warning("Target agent not found", { slug: agentSlug });
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
                        error: error instanceof Error ? error.message : String(error),
                    });
                    // Continue with other agents even if one fails
                }
            }
        } catch (error) {
            tracingLogger.error("Routing backend error", {
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
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
        if (executionLogger && response.content) {
            const thinkingMatch = response.content.match(/<thinking>([\s\S]*?)<\/thinking>/);
            if (thinkingMatch && thinkingMatch[1]) {
                const thinking = thinkingMatch[1].trim();
                executionLogger.agentThinking(
                    context.agent.name,
                    thinking,
                    {
                        userMessage: messages[messages.length - 1]?.content,
                        confidence: 0.85
                    }
                );
            }
        }

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