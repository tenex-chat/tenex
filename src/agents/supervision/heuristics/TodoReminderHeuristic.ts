/**
 * TodoReminderHeuristic - Reminds agents about their todo lists
 *
 * This heuristic triggers when an agent is about to complete but has incomplete todos.
 * Unlike PendingTodosHeuristic which blocks completion, this heuristic:
 * 1. Allows the initial completion
 * 2. Triggers a follow-up reminder execution with restricted tools (todo tools only)
 * 3. Only reminds once per agent per conversation
 *
 * This is useful for ensuring agents update their todo status before the conversation
 * is fully closed, without blocking their main work.
 */

import type { ConversationStore } from "@/conversations/ConversationStore";
import type {
    CorrectionAction,
    Heuristic,
    HeuristicDetection,
    PostCompletionContext,
    VerificationResult,
} from "../types";

/**
 * Tool names that are considered "todo tools" for restricted execution.
 */
export const TODO_TOOL_NAMES = ["todo_write"] as const;

/**
 * Heuristic that reminds agents about incomplete todos after completion.
 *
 * Unlike PendingTodosHeuristic (which blocks completion), this heuristic:
 * - Allows the completion to proceed
 * - Queues a follow-up reminder message
 * - Only reminds once per agent per conversation
 *
 * The reminded state is tracked via `hasBeenRemindedAboutTodos` in PostCompletionContext,
 * which is populated from ConversationStore.hasBeenRemindedAboutTodos().
 */
export class TodoReminderHeuristic implements Heuristic<PostCompletionContext> {
    id = "todo-reminder";
    name = "Todo List Reminder";
    timing = "post-completion" as const;
    skipVerification = true; // Objective check - todos are data, not judgment

    /**
     * Check if a reminder should be triggered for this agent.
     * Returns true if:
     * 1. Agent has incomplete todos (pending or in_progress)
     * 2. Agent has NOT been reminded in this conversation
     */
    async detect(context: PostCompletionContext): Promise<HeuristicDetection> {
        // Skip if agent has no todos at all
        if (!context.hasTodoList || context.todos.length === 0) {
            return { triggered: false };
        }

        // Skip if already reminded in this conversation (uses persistent storage)
        if (context.hasBeenRemindedAboutTodos) {
            return { triggered: false };
        }

        // Find todos that are incomplete (pending or in_progress)
        const incompleteTodos = context.todos.filter(
            (t) => t.status === "pending" || t.status === "in_progress"
        );

        // No incomplete todos = no reminder needed
        if (incompleteTodos.length === 0) {
            return { triggered: false };
        }

        return {
            triggered: true,
            reason: `Agent has ${incompleteTodos.length} incomplete todo(s) that may need status updates`,
            evidence: {
                incompleteTodos: incompleteTodos.map((t) => ({
                    id: t.id,
                    title: t.title,
                    status: t.status,
                })),
                totalTodos: context.todos.length,
            },
        };
    }

    buildVerificationPrompt(_context: PostCompletionContext, _detection: HeuristicDetection): string {
        // Not used since skipVerification is true
        return "";
    }

    buildCorrectionMessage(context: PostCompletionContext, _verification: VerificationResult): string {
        const incompleteTodos = context.todos.filter(
            (t) => t.status === "pending" || t.status === "in_progress"
        );

        const todoList = incompleteTodos
            .map((t) => `- [${t.status}] **${t.title}**${t.description ? `: ${t.description}` : ""}`)
            .join("\n");

        return `**Todo Status Reminder:** Before finishing, please update your todo list status:

${todoList}

Use \`todo_write\` to update item statuses:
- \`done\` - if completed
- \`skipped\` (with skip_reason) - if no longer applicable

This ensures accurate progress tracking.`;
    }

    getCorrectionAction(_verification: VerificationResult): CorrectionAction {
        return {
            type: "inject-message",
            reEngage: true, // Re-engage agent to update todos
        };
    }

    // ========== Helper Methods ==========

    /**
     * Check if an agent has existing incomplete todos in a conversation.
     *
     * @param conversation - The conversation store
     * @param agentPubkey - The agent's public key
     */
    hasExistingTodos(conversation: ConversationStore, agentPubkey: string): boolean {
        const todos = conversation.getTodos(agentPubkey);
        return todos.some((t) => t.status === "pending" || t.status === "in_progress");
    }

    /**
     * Get the last tool call from a conversation's messages.
     * Useful for determining if the agent just used a todo tool.
     *
     * @param conversation - The conversation store
     * @param agentPubkey - The agent's public key
     */
    getLastToolCall(conversation: ConversationStore, agentPubkey: string): string | undefined {
        const messages = conversation.getAllMessages();

        // Find the last tool-call message from this agent
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            if (msg.pubkey === agentPubkey && msg.messageType === "tool-call" && msg.toolData) {
                // toolData is ToolCallPart[] for tool-call messages
                const toolCalls = msg.toolData as Array<{ type: string; toolName?: string }>;
                const lastToolCall = toolCalls[toolCalls.length - 1];
                if (lastToolCall?.toolName) {
                    return lastToolCall.toolName;
                }
            }
        }

        return undefined;
    }

    /**
     * Get the list of todo-only tools for restricted agent execution.
     */
    getTodoTools(): readonly string[] {
        return TODO_TOOL_NAMES;
    }
}
