import type { AgentInstance } from "@/agents/types";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import type { LanguageModel, StepResult, Tool as CoreTool } from "ai";
import { Experimental_Agent as Agent } from "ai";
import type { ModelMessage } from "ai";
import { EventEmitter } from "tseep";

/**
 * Configuration for AISDKAgentWrapper
 */
export interface AISDKAgentConfig {
    agent: AgentInstance;
    model: LanguageModel;
    tools: Record<string, AISdkTool>;
    maxSteps?: number;
    temperature?: number;
    maxTokens?: number;
}

/**
 * AISDKAgentWrapper - Wraps the Vercel AI SDK Agent class with TENEX-specific features
 *
 * This wrapper provides:
 * - Integration with TENEX's event-based streaming architecture
 * - Compatibility with existing AgentExecutor patterns
 * - Preservation of Nostr integration points
 * - Telemetry and logging hooks
 *
 * Usage:
 * ```typescript
 * const wrapper = new AISDKAgentWrapper({
 *   agent: agentInstance,
 *   model: languageModel,
 *   tools: toolsObject,
 *   maxSteps: 10
 * });
 *
 * // For streaming
 * await wrapper.stream(messages);
 *
 * // For completion
 * const result = await wrapper.generate(messages);
 * ```
 */
export class AISDKAgentWrapper extends EventEmitter<Record<string, any>> {
    private agent: Agent<Record<string, CoreTool>>;
    private agentInstance: AgentInstance;
    private maxSteps: number;

    constructor(config: AISDKAgentConfig) {
        super();
        this.agentInstance = config.agent;
        this.maxSteps = config.maxSteps ?? 10;

        // Build system prompt from agent instance
        const systemPrompt = this.buildSystemPrompt(config.agent);

        // Create the AI SDK Agent with TENEX configuration
        this.agent = new Agent({
            model: config.model,
            system: systemPrompt,
            tools: config.tools as Record<string, CoreTool>,
            temperature: config.temperature,
            maxOutputTokens: config.maxTokens,

            // Configure stop condition based on TENEX's needs
            stopWhen: this.buildStopCondition(),
        });

        logger.debug("[AISDKAgentWrapper] Created wrapper for agent", {
            agentSlug: config.agent.slug,
            maxSteps: this.maxSteps,
            toolCount: Object.keys(config.tools).length,
        });
    }

    /**
     * Build system prompt from agent instance
     * Combines role, description, and any custom instructions
     */
    private buildSystemPrompt(agent: AgentInstance): string {
        const parts: string[] = [];

        // Add role
        if (agent.role) {
            parts.push(`Role: ${agent.role}`);
        }

        // Add description
        if (agent.description) {
            parts.push(`Description: ${agent.description}`);
        }

        // Add custom instructions if present
        if (agent.customInstructions) {
            parts.push(`\nInstructions:\n${agent.customInstructions}`);
        }

        const systemPrompt = parts.join("\n\n");

        logger.debug("[AISDKAgentWrapper] Built system prompt", {
            agentSlug: agent.slug,
            promptLength: systemPrompt.length,
        });

        return systemPrompt;
    }

    /**
     * Build stop condition for the agentic loop
     * Limits steps and can be extended with custom logic
     */
    private buildStopCondition() {
        return ({ steps }: { steps: StepResult<Record<string, CoreTool>>[] }): boolean => {
            // Stop if we've reached max steps
            if (steps.length >= this.maxSteps) {
                logger.debug("[AISDKAgentWrapper] Stopping: max steps reached", {
                    steps: steps.length,
                    maxSteps: this.maxSteps,
                });
                return true;
            }

            // Add custom stop logic here if needed
            // For example: stop on specific tool calls, errors, etc.

            return false;
        };
    }

    /**
     * Generate a completion using the AI SDK Agent
     * Returns the complete result without streaming
     */
    async generate(
        messages: ModelMessage[]
    ): Promise<{ text: string; steps: StepResult<Record<string, CoreTool>>[]; usage: any }> {
        const startTime = Date.now();

        logger.debug("[AISDKAgentWrapper] Starting generation", {
            agentSlug: this.agentInstance.slug,
            messageCount: messages.length,
        });

        try {
            // Use the Agent's generate method
            const result = await this.agent.generate({
                messages,
            });

            const duration = Date.now() - startTime;

            logger.debug("[AISDKAgentWrapper] Generation complete", {
                agentSlug: this.agentInstance.slug,
                duration,
                steps: result.steps?.length || 0,
                textLength: result.text?.length || 0,
            });

            // Emit complete event for compatibility with TENEX event system
            this.emit("complete", {
                message: result.text || "",
                steps: result.steps || [],
                usage: result.usage,
                finishReason: result.finishReason,
            });

            return {
                text: result.text || "",
                steps: result.steps || [],
                usage: result.usage,
            };
        } catch (error) {
            const duration = Date.now() - startTime;

            logger.error("[AISDKAgentWrapper] Generation failed", {
                agentSlug: this.agentInstance.slug,
                duration,
                error: error instanceof Error ? error.message : String(error),
            });

            // Emit error event
            this.emit("stream-error", { error });
            throw error;
        }
    }

    /**
     * Stream a response using the AI SDK Agent
     * Emits events compatible with TENEX's streaming architecture
     */
    async stream(messages: ModelMessage[]): Promise<void> {
        const startTime = Date.now();

        logger.debug("[AISDKAgentWrapper] Starting stream", {
            agentSlug: this.agentInstance.slug,
            messageCount: messages.length,
        });

        try {
            // Use the Agent's stream method
            const { textStream, steps, usage, finishReason } = await this.agent.stream({
                messages,
            });

            // Consume the stream and emit events
            for await (const chunk of textStream) {
                // Emit content delta event
                this.emit("content", { delta: chunk });
            }

            // Wait for final results
            const finalSteps = await steps;
            const finalUsage = await usage;
            const finalFinishReason = await finishReason;

            const duration = Date.now() - startTime;

            logger.debug("[AISDKAgentWrapper] Stream complete", {
                agentSlug: this.agentInstance.slug,
                duration,
                steps: finalSteps?.length || 0,
            });

            // Build final message from steps
            const finalMessage = this.extractFinalMessage(finalSteps);

            // Emit complete event
            this.emit("complete", {
                message: finalMessage,
                steps: finalSteps || [],
                usage: finalUsage,
                finishReason: finalFinishReason,
            });
        } catch (error) {
            const duration = Date.now() - startTime;

            logger.error("[AISDKAgentWrapper] Stream failed", {
                agentSlug: this.agentInstance.slug,
                duration,
                error: error instanceof Error ? error.message : String(error),
            });

            // Emit error event
            this.emit("stream-error", { error });
            throw error;
        }
    }

    /**
     * Extract final message text from steps
     */
    private extractFinalMessage(steps: StepResult<Record<string, CoreTool>>[] | undefined): string {
        if (!steps || steps.length === 0) {
            return "";
        }

        // Get the last step with text
        for (let i = steps.length - 1; i >= 0; i--) {
            if (steps[i].text) {
                return steps[i].text || "";
            }
        }

        return "";
    }

    /**
     * Get the agent instance this wrapper is managing
     */
    getAgentInstance(): AgentInstance {
        return this.agentInstance;
    }

    /**
     * Get the maximum steps configuration
     */
    getMaxSteps(): number {
        return this.maxSteps;
    }

    /**
     * Update the maximum steps dynamically
     */
    setMaxSteps(maxSteps: number): void {
        this.maxSteps = maxSteps;
        logger.debug("[AISDKAgentWrapper] Updated max steps", {
            agentSlug: this.agentInstance.slug,
            maxSteps,
        });
    }
}
