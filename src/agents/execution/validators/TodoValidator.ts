/**
 * TodoValidator - Validates todo completion for agent execution
 *
 * This module handles:
 * - Checking for pending todo items
 * - LLM-based validation of intentional todo skipping
 */

import type { AgentInstance } from "@/agents/types";
import { logger } from "@/utils/logger";
import { formatConversationSnapshot } from "@/utils/phase-utils";
import { trace } from "@opentelemetry/api";
import type { ExecutionContext } from "../types";

export interface TodoCheckResult {
    hasPending: boolean;
    pendingItems: string[];
}

/**
 * Check if there are pending todo items (items with status='pending')
 */
export function checkTodoCompletion(
    agent: AgentInstance,
    context: ExecutionContext
): TodoCheckResult {
    const conversation = context.getConversation();
    if (!conversation) {
        return { hasPending: false, pendingItems: [] };
    }

    const todos = conversation.agentTodos.get(agent.pubkey) || [];
    const pendingTodos = todos.filter((t) => t.status === "pending");

    trace.getActiveSpan()?.addEvent("supervisor.todo_check", {
        "todo.pending_count": pendingTodos.length,
        "todo.pending_items": pendingTodos.map((t) => t.title).join(","),
    });

    return {
        hasPending: pendingTodos.length > 0,
        pendingItems: pendingTodos.map((t) => t.title),
    };
}

/**
 * Validate if pending todos were intentionally not addressed
 * @returns continuation instruction if agent should continue, empty string if intentional
 */
export async function validateTodoPending(
    agent: AgentInstance,
    context: ExecutionContext,
    completionContent: string,
    pendingItems: string[],
    getSystemPrompt: () => Promise<string>
): Promise<string> {
    if (pendingItems.length === 0) {
        return ""; // No pending todos
    }

    try {
        const conversationSnapshot = await formatConversationSnapshot(context);
        const systemPrompt = await getSystemPrompt();

        const validationPrompt = buildTodoValidationPrompt(
            pendingItems,
            conversationSnapshot,
            completionContent
        );

        const llmService = context.agent.createLLMService();

        const result = await llmService.complete(
            [
                { role: "system", content: systemPrompt },
                { role: "system", content: validationPrompt.system },
                { role: "user", content: validationPrompt.user },
            ],
            {} // No tools
        );

        const response = result.text?.trim() || "";
        const shouldContinue = response.toLowerCase().includes("continue");

        return shouldContinue ? response : "";
    } catch (error) {
        logger.error("[TodoValidator] Todo validation failed", {
            agent: agent.slug,
            error: error instanceof Error ? error.message : String(error),
        });
        return "";
    }
}

/**
 * Build validation prompt for pending todos
 */
export function buildTodoValidationPrompt(
    pendingItems: string[],
    conversationSnapshot: string,
    agentResponse: string
): { system: string; user: string } {
    const system = `You just completed a response but have pending todo items.

<conversation-history>
${conversationSnapshot}
</conversation-history>

<your-response>
${agentResponse}
</your-response>

<pending-todos>
${pendingItems.join("\n")}
</pending-todos>`;

    const user = `Review the conversation and your pending todos. Consider:
1. Did you fully address what was requested?
2. Are the pending items still relevant to the task?
3. Should you complete them or explicitly skip them (with a reason)?

Respond in one of two formats:
- "I'M DONE: [brief explanation of why pending items are not needed]"
- "CONTINUE: [brief explanation of what you will do next]"`;

    return { system, user };
}
