/**
 * Agent-Directed Monitoring Fragment
 *
 * Provides guidance on how agents can monitor delegated work using existing tools.
 * This replaces the automatic pairing infrastructure with agent-controlled monitoring.
 */

import type { PromptFragment } from "../core/types";

const MONITORING_GUIDANCE = `## Monitoring Delegated Work

When you delegate tasks to other agents, you can monitor their progress using existing tools:

1. **Check Progress**: Use \`conversation_get\` with the delegation conversation ID. Optionally pass a \`prompt\` parameter to have the tool summarize the delegatee's progress.

2. **Wait Between Checks**: Use \`shell()\` with \`sleep <seconds>\` to wait between progress checks. Choose intervals based on task complexity:
   - Quick tasks (< 2 min expected): Check every 30 seconds
   - Medium tasks (2-10 min): Check every 1-2 minutes
   - Long tasks (> 10 min): Check every 3-5 minutes

3. **When to Monitor**: You decide whether active monitoring is needed based on:
   - Task criticality and deadline pressure
   - Whether you need intermediate results
   - The delegatee's reliability for the task type

Most delegations complete and return results automatically. Active monitoring is optional and primarily useful for long-running tasks where you want progress visibility.`;

export const agentDirectedMonitoringFragment: PromptFragment = {
    id: "agent-directed-monitoring",
    priority: 28, // After memorized reports (27), before worktree context (30)
    template: () => MONITORING_GUIDANCE,
};
