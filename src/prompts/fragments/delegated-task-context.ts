import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";

/**
 * Context fragment for agents working on delegated tasks.
 * This is added when the triggering event is an NDKTask (kind 1934).
 */
interface DelegatedTaskContextArgs {
    taskDescription: string;
}

export const delegatedTaskContextFragment: PromptFragment<DelegatedTaskContextArgs> = {
    id: "delegated-task-context",
    priority: 2, // Higher priority to appear right after identity
    template: ({ taskDescription }) => {
        return `
## 🚨 CRITICAL: You Are Working on a Delegated Task

**THIS IS NOT A CONVERSATION - THIS IS A DELEGATED TASK THAT REQUIRES COMPLETION**

You have been assigned a specific task by another agent. Your ONLY job is to:
1. Complete the assigned task
2. Use the complete() tool to return your results

### The Task You Must Complete:
${taskDescription}

### Critical Instructions for Delegated Tasks:

1. **YOU MUST USE complete() TO FINISH**: When you've completed the task, you MUST use the complete() tool to return control and results to the delegating agent. Simply responding without using complete() will leave the task hanging.

2. **Focus Only on the Task**: Do not engage in conversation. Do not ask questions. Execute the task and report back using complete().

3. **If You Cannot Complete the Task**: If you encounter blockers or need clarification, still use complete() to report the issue and what you need to proceed.

4. **Your Response Format**: 
   - Do the work requested
   - Use complete() with a clear summary of what you accomplished
   - Include any relevant details, findings, or results in the complete() response

### Example CORRECT Behavior:
Task: "Analyze the authentication flow"
Your response: complete("I analyzed the authentication flow. It uses JWT tokens with a 24-hour expiry. The flow is: 1) User submits credentials 2) Server validates against database 3) JWT issued with user claims 4) Client stores in localStorage. Found potential issue: tokens aren't refreshed automatically, and tokens should use httpOnly cookies instead of localStorage for XSS protection.")

### Example INCORRECT Behavior #1:
Task: "Analyze the authentication flow"
Your response: "I've analyzed the authentication flow. It uses JWT tokens..." [WITHOUT using complete()]
❌ This leaves the task incomplete and the delegating agent waiting forever!

### Example INCORRECT Behavior #2:
Task: "Analyze the authentication flow"
Your response: "Here's my analysis: [detailed analysis of auth flow]" then complete("Analysis complete")
❌ WRONG! The actual analysis is LOST - it's not inside complete()! The delegating agent only sees "Analysis complete" with no details!

**REMEMBER**: The delegating agent is waiting for your complete() call. Without it, the workflow will hang. Always end delegated tasks with complete().
`;
    }
};

// Register the fragment
fragmentRegistry.register(delegatedTaskContextFragment);