import type {
    CorrectionAction,
    Heuristic,
    HeuristicDetection,
    PostCompletionContext,
    VerificationResult,
} from "../types";

/**
 * Heuristic that prevents agents from completing when they have pending or in_progress todos.
 *
 * This ensures agents don't abandon work they've planned. If an agent creates a todo list
 * but tries to finish without completing (or explicitly skipping) all items, this heuristic
 * will block the completion and prompt the agent to address their remaining todos.
 *
 * Uses skipVerification=true because this is an objective check - either todos are incomplete
 * or they aren't. No LLM judgment needed.
 */
export class PendingTodosHeuristic implements Heuristic<PostCompletionContext> {
    id = "pending-todos";
    name = "Agent Completing With Pending Todos";
    timing = "post-completion" as const;
    skipVerification = true; // Objective check - todos are data, not judgment

    async detect(context: PostCompletionContext): Promise<HeuristicDetection> {
        // Skip if agent has no todos at all
        if (context.todos.length === 0) {
            return { triggered: false };
        }

        // Find todos that are incomplete (pending or in_progress)
        const incompleteTodos = context.todos.filter(
            (t) => t.status === "pending" || t.status === "in_progress"
        );

        // No incomplete todos = agent is done
        if (incompleteTodos.length === 0) {
            return { triggered: false };
        }

        return {
            triggered: true,
            reason: `Agent has ${incompleteTodos.length} incomplete todo(s) (pending or in_progress)`,
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

        return `You have incomplete items in your todo list:

${todoList}

Would you like to address these before finishing your turn? If you're intentionally leaving them incomplete (waiting on delegation, user request, or other valid reasons), please confirm your intent.

You can use \`todo_write\` to update item statuses if needed.`;
    }

    getCorrectionAction(_verification: VerificationResult): CorrectionAction {
        return {
            type: "suppress-publish",
            reEngage: true, // Re-engage agent to address todos
        };
    }
}
