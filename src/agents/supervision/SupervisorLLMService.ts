import { llmServiceFactory } from "@/llm";
import type { LLMService } from "@/llm/service";
import { config } from "@/services/ConfigService";
import { logger } from "@/utils/logger";
import type { ToolSet } from "ai";
import { z } from "zod";
import type { SupervisionContext, VerificationResult } from "./types";

/**
 * Schema for the structured verification response from the supervisor LLM
 */
const VerificationResponseSchema = z.object({
    verdict: z.enum(["ok", "violation"]).describe("Whether the agent behavior is acceptable or violates guidelines"),
    explanation: z.string().describe("Detailed explanation of why this verdict was reached"),
    correctionMessage: z.string().optional().describe("Message to send to the agent to correct their behavior"),
});

/**
 * Service for LLM-based verification of heuristic detections
 * Follows the pattern from ConversationSummarizer
 */
export class SupervisorLLMService {
    private llmService: LLMService | null = null;
    private initialized = false;

    /**
     * Initialize the LLM service with supervision configuration
     * Prefers llms.supervision config, falls back to llms.default
     */
    async initialize(): Promise<void> {
        if (this.initialized) {
            return;
        }

        try {
            const { llms } = await config.loadConfig();

            // Prefer supervision config, fall back to default
            const configName = llms.supervision || llms.default;

            if (!configName) {
                logger.warn("[SupervisorLLMService] No LLM configuration available for supervision");
                this.initialized = true;
                return;
            }

            // Use getLLMConfig to resolve meta models automatically
            const supervisionConfig = config.getLLMConfig(configName);

            // Create LLM service
            this.llmService = llmServiceFactory.createService(supervisionConfig, {
                agentName: "supervisor",
                sessionId: `supervisor-${Date.now()}`,
            });

            this.initialized = true;
            logger.debug("[SupervisorLLMService] Initialized with config:", configName);
        } catch (error) {
            logger.error("[SupervisorLLMService] Failed to initialize", error);
            this.initialized = true; // Mark as initialized to prevent retry loops
        }
    }

    /**
     * Format conversation history for the verification prompt
     */
    private formatConversationHistory(history: SupervisionContext["conversationHistory"]): string {
        if (!history || history.length === 0) {
            return "(No conversation history)";
        }

        const toolResultMaxLength = 5000;

        return history
            .map((msg, index) => {
                const role = msg.role.toUpperCase();
                let content: string;

                if (typeof msg.content === "string") {
                    content = msg.content;
                } else if (Array.isArray(msg.content)) {
                    // Handle multimodal content with detailed tool interactions
                    content = msg.content
                        .map((part) => {
                            if (typeof part === "string") return part;
                            if ("text" in part) return part.text;
                            if ("type" in part) {
                                // Handle tool-call parts
                                if (part.type === "tool-call") {
                                    const toolCall = part as unknown as {
                                        type: "tool-call";
                                        toolName: string;
                                        args: unknown;
                                    };
                                    const argsStr = JSON.stringify(toolCall.args);
                                    return `[Tool Call] ${toolCall.toolName}(${argsStr})`;
                                }
                                // Handle tool-result parts
                                if (part.type === "tool-result") {
                                    const toolResult = part as unknown as {
                                        type: "tool-result";
                                        toolName: string;
                                        result: unknown;
                                    };
                                    let resultStr = typeof toolResult.result === "string"
                                        ? toolResult.result
                                        : JSON.stringify(toolResult.result);
                                    // Truncate individual tool results if they exceed limit
                                    if (resultStr.length > toolResultMaxLength) {
                                        resultStr = resultStr.slice(0, toolResultMaxLength) + "... [truncated]";
                                    }
                                    return `[Tool Result] ${toolResult.toolName}: ${resultStr}`;
                                }
                                return `[${part.type}]`;
                            }
                            return "[complex content]";
                        })
                        .join("\n");
                } else {
                    content = "[complex content]";
                }

                // Truncate very long messages for the prompt
                const maxLength = 25000;
                if (content.length > maxLength) {
                    content = content.slice(0, maxLength) + "... [truncated]";
                }

                return `[${index + 1}] ${role}:\n${content}`;
            })
            .join("\n\n---\n\n");
    }

    /**
     * Format available tools for the verification prompt
     */
    private formatAvailableTools(tools: ToolSet): string {
        if (!tools || Object.keys(tools).length === 0) {
            return "(No tools available)";
        }

        return Object.entries(tools)
            .map(([name, tool]) => {
                const description = tool.description || "(no description)";
                return `- ${name}: ${description}`;
            })
            .join("\n");
    }

    /**
     * Build the full verification prompt with all context
     */
    private buildFullPrompt(context: SupervisionContext, heuristicPrompt: string): string {
        const toolsList = this.formatAvailableTools(context.availableTools);
        const conversationFormatted = this.formatConversationHistory(context.conversationHistory);

        return `You are a supervisor reviewing an AI agent's behavior to determine if it violates any guidelines.

## Heuristic Detection
Heuristic ID: ${context.triggeringHeuristic}
Triggered: ${context.detection.triggered}
Reason: ${context.detection.reason || "(No reason provided)"}
Evidence: ${context.detection.evidence ? JSON.stringify(context.detection.evidence, null, 2) : "(No evidence provided)"}

## Agent Information
- Agent Slug: ${context.agentSlug}
- Agent Pubkey: ${context.agentPubkey}

## Agent's System Prompt
${context.systemPrompt || "(No system prompt available)"}

## Available Tools
${toolsList}

## Conversation History
${conversationFormatted}

## Your Task
${heuristicPrompt}

Analyze the agent's behavior carefully. Consider:
1. Does the behavior actually violate the guidelines or is it a false positive?
2. Is there context that justifies the agent's actions?
3. If it is a violation, what should the agent do differently?

Respond with your verdict and explanation.`;
    }

    /**
     * Verify a heuristic detection using the supervisor LLM
     * @param context - Full supervision context
     * @param heuristicPrompt - The verification prompt from the heuristic
     * @returns Verification result (defaults to "ok" on error)
     */
    async verify(context: SupervisionContext, heuristicPrompt: string): Promise<VerificationResult> {
        // Ensure initialized
        if (!this.initialized) {
            await this.initialize();
        }

        // If no LLM available, default to ok
        if (!this.llmService) {
            logger.debug("[SupervisorLLMService] No LLM available, defaulting to ok verdict");
            return {
                verdict: "ok",
                explanation: "No supervision LLM configured, allowing action",
            };
        }

        try {
            const fullPrompt = this.buildFullPrompt(context, heuristicPrompt);

            const { object: result } = await this.llmService.generateObject(
                [
                    {
                        role: "system",
                        content: `You are a supervisor AI that evaluates agent behavior for compliance with guidelines.
You must determine if the agent's behavior is acceptable ("ok") or violates guidelines ("violation").
Be thoughtful and consider context - not every flagged behavior is actually problematic.
When you find a violation, provide a clear correction message that helps the agent fix their behavior.`,
                    },
                    {
                        role: "user",
                        content: fullPrompt,
                    },
                ],
                VerificationResponseSchema
            );

            logger.debug(`[SupervisorLLMService] Verification result: ${result.verdict}`, {
                heuristic: context.triggeringHeuristic,
                verdict: result.verdict,
            });

            return {
                verdict: result.verdict,
                explanation: result.explanation,
                correctionMessage: result.correctionMessage,
            };
        } catch (error) {
            logger.error("[SupervisorLLMService] Verification failed, defaulting to ok", error);
            return {
                verdict: "ok",
                explanation: "Verification failed due to error, allowing action as fallback",
            };
        }
    }
}

/**
 * Singleton instance of the supervisor LLM service
 */
export const supervisorLLMService = new SupervisorLLMService();
