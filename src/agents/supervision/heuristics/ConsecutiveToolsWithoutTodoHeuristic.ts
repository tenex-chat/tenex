import type {
    CorrectionAction,
    Heuristic,
    HeuristicDetection,
    PostCompletionContext,
    VerificationResult,
} from "../types";

/**
 * Default threshold for consecutive tool calls before nudging
 */
const DEFAULT_THRESHOLD = 5;

/**
 * Heuristic that nudges agents to use todo tracking after many consecutive tool calls
 * without a todo list. This is a low-stakes, one-time nudge that skips LLM verification.
 */
export class ConsecutiveToolsWithoutTodoHeuristic implements Heuristic<PostCompletionContext> {
    id = "consecutive-tools-without-todo";
    name = "Consecutive Tool Uses Without Todo List";
    timing = "post-completion" as const;
    skipVerification = true; // Low-stakes nudge, no LLM verification needed

    private threshold: number;

    constructor(threshold: number = DEFAULT_THRESHOLD) {
        this.threshold = threshold;
    }

    async detect(context: PostCompletionContext): Promise<HeuristicDetection> {
        // Skip if agent already has todos
        if (context.hasTodoList) {
            return { triggered: false };
        }

        // Skip if already nudged in this conversation
        if (context.hasBeenNudgedAboutTodos) {
            return { triggered: false };
        }

        // Check tool call count
        if (context.toolCallsMade.length < this.threshold) {
            return { triggered: false };
        }

        return {
            triggered: true,
            reason: `Agent made ${context.toolCallsMade.length} tool calls without tracking work in a todo list`,
            evidence: {
                toolCount: context.toolCallsMade.length,
                threshold: this.threshold,
            },
        };
    }

    buildVerificationPrompt(_context: PostCompletionContext, _detection: HeuristicDetection): string {
        // Not used since skipVerification is true
        return "";
    }

    buildCorrectionMessage(_context: PostCompletionContext, _verification: VerificationResult): string {
        return `**Task Tracking Suggestion:** You've made several tool calls without tracking your work. Consider using \`todo_add()\` to break down complex tasks into trackable steps - it helps show progress and ensures nothing is missed.

This is a one-time suggestion.`;
    }

    getCorrectionAction(_verification: VerificationResult): CorrectionAction {
        return {
            type: "inject-message",
            reEngage: false, // Don't re-engage, just note for future
        };
    }
}
