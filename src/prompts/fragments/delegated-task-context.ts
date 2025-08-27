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
2. Provide your results in your response

### The Task You Must Complete:
${taskDescription}

### Critical Instructions for Delegated Tasks:

1. **Complete Your Work and Stop**: When you've completed the task, simply provide your results. The system will automatically handle completion.

2. **Focus Only on the Task**: Do not engage in conversation. Do not ask questions. Execute the task and report back.

3. **If You Cannot Complete the Task**: Report the issue and what you need to proceed.

4. **Your Response Format**: 
   - Do the work requested
   - Provide a clear summary of what you accomplished
   - Include any relevant details, findings, or results

### Example CORRECT Behavior:
Task: "Analyze the authentication flow"
Your response: "I analyzed the authentication flow. It uses JWT tokens with a 24-hour expiry. The flow is: 1) User submits credentials 2) Server validates against database 3) JWT issued with user claims 4) Client stores in localStorage. Found potential issue: tokens aren't refreshed automatically, and tokens should use httpOnly cookies instead of localStorage for XSS protection."

**REMEMBER**: The delegating agent is waiting for your response. Simply complete your work and provide the results.
`;
  },
};

// Register the fragment
fragmentRegistry.register(delegatedTaskContextFragment);