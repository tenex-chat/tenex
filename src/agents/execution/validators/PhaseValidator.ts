/**
 * PhaseValidator - Validates phase completion for agent execution
 *
 * This module handles:
 * - Checking if all defined phases were executed
 * - Scanning historical phases from previous turns
 * - LLM-based validation of intentional phase skipping
 */

import type { AgentInstance } from "@/agents/types";
import { logger } from "@/utils/logger";
import { formatConversationSnapshot } from "@/utils/phase-utils";
import { trace } from "@opentelemetry/api";
import type { ToolExecutionTracker } from "../ToolExecutionTracker";
import type { ExecutionContext } from "../types";

export interface PhaseCheckResult {
    skipped: boolean;
    unusedPhases: string[];
}

/**
 * Check if any phases were skipped during execution
 */
export function checkPhaseCompletion(
    agent: AgentInstance,
    toolTracker: ToolExecutionTracker,
    context: ExecutionContext
): PhaseCheckResult {
    if (!agent.phases) {
        logger.info("[PhaseValidator] No phases defined for agent", {
            agent: agent.slug,
        });
        return { skipped: false, unusedPhases: [] };
    }

    // Get all executions from the current tracker
    const allExecutions = toolTracker.getAllExecutions();

    // Find delegate executions with phase from this turn
    const executedPhases = new Set<string>();

    for (const execution of allExecutions.values()) {
        if (execution.toolName === "delegate") {
            // Extract phase name from the args (unified delegate tool)
            const args = execution.input as { delegations?: Array<{ phase?: string }> };
            if (args?.delegations) {
                for (const delegation of args.delegations) {
                    if (delegation.phase) {
                        executedPhases.add(delegation.phase.toLowerCase());
                    }
                }
            }
        }
    }

    // Also check historical phases from previous turns
    const historicalPhases = scanHistoricalPhases(agent, context);
    const allExecutedPhases = new Set([...executedPhases, ...historicalPhases]);

    // Check what's missing
    const definedPhases = Object.keys(agent.phases);
    const unusedPhases = definedPhases.filter((p) => !allExecutedPhases.has(p.toLowerCase()));

    trace.getActiveSpan()?.addEvent("supervisor.phase_check", {
        "phase.defined_count": definedPhases.length,
        "phase.executed_this_turn": executedPhases.size,
        "phase.skipped": unusedPhases.length > 0,
    });

    return {
        skipped: unusedPhases.length > 0,
        unusedPhases,
    };
}

/**
 * Scan historical phases (from previous turns)
 */
export function scanHistoricalPhases(
    agent: AgentInstance,
    context: ExecutionContext
): Set<string> {
    const historicalPhases = new Set<string>();
    const conversation = context.getConversation();

    if (!conversation) return historicalPhases;

    // Only scan events BEFORE this execution started
    for (const event of conversation.history) {
        if (event.pubkey !== agent.pubkey) continue;
        if (event.id === context.triggeringEvent.id) break; // Stop at current trigger

        const toolTag = event.tags.find((t) => t[0] === "tool" && t[1] === "delegate");
        if (toolTag) {
            // Check if this delegation had a phase
            const phaseTag = event.tags.find((t) => t[0] === "phase");
            if (phaseTag?.[1]) {
                historicalPhases.add(phaseTag[1].toLowerCase());
            }
        }
    }

    return historicalPhases;
}

/**
 * Validate if phase skipping was intentional using conversation snapshot
 * @returns continuation instruction if agent should continue with phases, empty string if skipping was intentional
 */
export async function validatePhaseSkipping(
    agent: AgentInstance,
    context: ExecutionContext,
    toolTracker: ToolExecutionTracker,
    completionContent: string,
    getSystemPrompt: () => Promise<string>
): Promise<string> {
    const phaseCheck = checkPhaseCompletion(agent, toolTracker, context);
    if (!phaseCheck.skipped) {
        return ""; // No phases skipped, no need to continue
    }

    try {
        // Format the conversation as a readable snapshot
        const conversationSnapshot = await formatConversationSnapshot(context);

        // Get the agent's system prompt to understand its behavior and phase definitions
        const systemPrompt = await getSystemPrompt();

        // Build validation messages with system context + snapshot
        const validationPrompt = buildValidationPrompt(
            phaseCheck.unusedPhases,
            conversationSnapshot,
            completionContent
        );

        // Create LLM service with NO TOOLS to force text response
        const llmService = context.agent.createLLMService();

        // Make the validation call with system prompt + validation question
        const result = await llmService.complete(
            [
                {
                    role: "system",
                    content: systemPrompt,
                },
                {
                    role: "system",
                    content: validationPrompt.system,
                },
                {
                    role: "user",
                    content: validationPrompt.user,
                },
            ],
            {} // No tools
        );

        const response = result.text?.trim() || "";
        const responseLower = response.toLowerCase();
        const shouldContinue = responseLower.includes("continue");

        return shouldContinue ? response : "";
    } catch (error) {
        logger.error("[PhaseValidator] Phase validation failed", {
            agent: agent.slug,
            error: error instanceof Error ? error.message : String(error),
            defaulting: "Assuming phases were intentionally skipped",
        });
        // On error, assume phases were intentional
        return "";
    }
}

/**
 * Build a contextual validation prompt that speaks directly to the agent
 */
export function buildValidationPrompt(
    unusedPhases: string[],
    conversationSnapshot: string,
    agentResponse: string
): { system: string; user: string } {
    const system = `You just completed a response without executing all your defined phases.

<conversation-history>
${conversationSnapshot}
</conversation-history>

<your-response>
${agentResponse}
</your-response>

<phases not executed>
${unusedPhases.join(", ")}
</phases not executed>`;

    const user = `Review the conversation flow and your response. Consider:
1. Did you fully address what was requested in the conversation?
2. Would executing your unused phases provide additional value or complete the task?
3. Was skipping these phases appropriate given the specific request?

Respond in one of two formats:
- "I'M DONE: [brief explanation of why you intentionally skipped the phases]"
- "CONTINUE: [brief explanation of what you will do next]" if you should execute your phases for a more complete response. Be specific about which phase you'll execute and why.`;

    return { system, user };
}
