import type {
    CorrectionAction,
    Heuristic,
    HeuristicDetection,
    PreToolContext,
    VerificationResult,
} from "../types";

const PROTECTED_TOOL_NAMES = new Set([
    "fs_read",
    "fs_write",
    "fs_edit",
    "fs_glob",
    "fs_grep",
    "home_fs_read",
    "home_fs_write",
    "home_fs_edit",
    "home_fs_glob",
    "home_fs_grep",
    "shell",
]);

export class WorkerTodoBeforeFileOrShellHeuristic implements Heuristic<PreToolContext> {
    id = "worker-todo-before-file-or-shell";
    name = "Worker File or Shell Tool Use Without Todo List";
    timing = "pre-tool-execution" as const;
    toolFilter = Array.from(PROTECTED_TOOL_NAMES);
    skipVerification = true;
    enforcementMode = "repeat-until-resolved" as const;

    async detect(context: PreToolContext): Promise<HeuristicDetection> {
        if (context.agentCategory !== "worker") {
            return { triggered: false };
        }

        if (!PROTECTED_TOOL_NAMES.has(context.toolName)) {
            return { triggered: false };
        }

        if (context.todos.length > 0) {
            return { triggered: false };
        }

        return {
            triggered: true,
            reason: `Worker attempted to use ${context.toolName} before setting up a todo list`,
            evidence: {
                toolName: context.toolName,
                agentCategory: context.agentCategory,
            },
        };
    }

    buildVerificationPrompt(_context: PreToolContext, _detection: HeuristicDetection): string {
        return "";
    }

    buildCorrectionMessage(context: PreToolContext, _verification: VerificationResult): string {
        return `Workers must set up a todo list before using file or shell tools.

Call \`todo_write()\` with at least one task that tracks the work you are about to do, then retry \`${context.toolName}\`.`;
    }

    getCorrectionAction(_verification: VerificationResult): CorrectionAction {
        return {
            type: "block-tool",
            reEngage: true,
        };
    }
}
