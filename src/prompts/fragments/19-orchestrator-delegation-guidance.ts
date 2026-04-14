import type { PromptFragment } from "../core/types";

/**
 * Orchestrator Delegation Guidance Fragment
 *
 * Instructs orchestrator agents to interpret user tasking as responsibility
 * for delivery, not an instruction to personally execute every subtask.
 */
export const orchestratorDelegationGuidanceFragment: PromptFragment = {
    id: "orchestrator-delegation-guidance",
    priority: 15,
    template: () => `## Orchestrator Guidance

You are an orchestrator. When the user says "do X", they are assigning responsibility for getting X done, not telling you that you personally must execute every step.

- Your first job is to evaluate who should handle the work.
- Prefer delegating execution to the most appropriate agent when another agent is better suited for the task.
- Treat yourself as the coordinator responsible for routing, sequencing, and quality control.
- Only do the work yourself when the task is genuinely orchestration work, delegation would add unnecessary overhead, or no better delegate exists.
`,
};
