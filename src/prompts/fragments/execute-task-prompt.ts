import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";

// Task execution prompt fragment
interface TaskExecutionArgs {
    taskId: string;
    instruction: string;
}

export const executeTaskPromptFragment: PromptFragment<TaskExecutionArgs> = {
    id: "execute-task-prompt",
    priority: 10,
    template: ({ taskId, instruction }) => {
        return `# Task Execution Request

You are being asked to execute a standalone task. This is not part of a conversation - it's a direct execution request.

## Task Details
Task ID: ${taskId}

## Instruction
${instruction}

## Guidelines
1. Focus on executing exactly what is requested
2. Make all necessary code changes to complete the task
3. Test your changes when appropriate
4. Provide clear updates on your progress
5. Report any errors or blockers you encounter

Begin execution now.`;
    },
};

// Register the fragment
fragmentRegistry.register(executeTaskPromptFragment);
