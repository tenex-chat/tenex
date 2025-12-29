/**
 * ConcurrentRALCoordinator - Manages coordination between concurrent RALs
 *
 * Responsible for:
 * - Building context messages for agents about other active RALs
 * - Determining when paused RALs should be released
 * - Providing tool availability based on RAL state
 */

import type { RALSummary } from "@/services/ral";

export interface StepInfo {
  stepNumber: number;
  toolCalls: Array<{ toolName: string }>;
  text: string;
  reasoningText?: string;
}

/**
 * Read-only tools that don't indicate a decision to proceed.
 * These tools are used for gathering context, not taking action.
 * Paused RALs should NOT be released when only these tools are called.
 */
const READ_ONLY_TOOLS = new Set([
  "conversation_get",
  "read_path",
  "read_file",
  "file_search",
  "grep_search",
  "codebase_search",
  "list_dir",
]);

export interface RALToolAvailability {
  ralNumber: number;
  canAbort: boolean;
  abortReason?: string;
}

export class ConcurrentRALCoordinator {
  /**
   * Determine tool availability for each RAL
   * - ral_abort is only available if RAL has no pending delegations
   */
  getToolAvailability(rals: RALSummary[]): RALToolAvailability[] {
    return rals.map(ral => {
      const hasPendingDelegations = ral.pendingDelegations.length > 0;
      return {
        ralNumber: ral.ralNumber,
        canAbort: !hasPendingDelegations,
        abortReason: hasPendingDelegations
          ? `Has ${ral.pendingDelegations.length} pending delegation(s) - use ral_inject to tell it to stop and cancel its delegations`
          : undefined,
      };
    });
  }

  /**
   * Determine if paused RALs should be released based on completed steps
   *
   * Release when:
   * - At least one step has a "decision" tool call (coordination or action tool)
   *
   * Don't release when:
   * - No steps completed yet
   * - Only reasoning/thinking was produced (no tool calls)
   * - Only read-only tools were called (agent is still gathering context)
   *
   * This ensures the agent has time to gather context before deciding how to coordinate.
   */
  shouldReleasePausedRALs(steps: StepInfo[]): boolean {
    if (steps.length === 0) {
      return false;
    }

    // Check if any step had a "decision" tool call (not just read-only tools)
    return steps.some(step =>
      step.toolCalls.some(tc => !READ_ONLY_TOOLS.has(tc.toolName))
    );
  }

  /**
   * Build the context message for an agent about other active RALs
   * @param otherRALs - Summaries of other active RALs
   * @param currentRALNumber - The RAL number of the agent receiving this context
   */
  buildContext(otherRALs: RALSummary[], currentRALNumber: number): string {
    if (otherRALs.length === 0) return "";

    const toolAvailability = this.getToolAvailability(otherRALs);

    const ralDescriptions = otherRALs.map(ral => {
      const status = ral.isStreaming ? "actively streaming" :
        ral.hasPendingDelegations ? "waiting on delegations" : "idle";

      const ageMinutes = Math.round((Date.now() - ral.createdAt) / 60000);

      let delegationInfo = "";
      if (ral.pendingDelegations.length > 0) {
        const delegationList = ral.pendingDelegations
          .map(d => `${d.recipientSlug || "agent"}: "${d.prompt}" (event_id: ${d.eventId.substring(0, 8)}...)`)
          .join("\n    ");
        delegationInfo = `\n  Pending delegations:\n    ${delegationList}`;
      }

      return `RAL #${ral.ralNumber} (${status}, started ${ageMinutes}m ago):
  Current tool: ${ral.currentTool || "none"}${delegationInfo}`;
    }).join("\n\n");

    // Build tool instructions based on availability
    const abortableRALs = toolAvailability.filter(t => t.canAbort);
    const nonAbortableRALs = toolAvailability.filter(t => !t.canAbort);

    let toolInstructions = `Available tools for coordination:
- ral_inject(ral_number, message): Send an instruction to that RAL (it will see it when it next processes)`;

    if (abortableRALs.length > 0) {
      toolInstructions += `
- ral_abort(ral_number): Immediately stop a RAL (available for: ${abortableRALs.map(t => `#${t.ralNumber}`).join(", ")})`;
    }

    if (nonAbortableRALs.length > 0) {
      const reasons = nonAbortableRALs.map(t => `RAL #${t.ralNumber}: ${t.abortReason}`).join("\n  ");
      toolInstructions += `

Note: Some RALs cannot be aborted directly:
  ${reasons}`;
    }

    return `
CONCURRENT EXECUTION CONTEXT:
YOU ARE RAL #${currentRALNumber} - a NEW execution that just started.
You are NOT any of the other RALs listed below. They are PAUSED waiting for YOUR decision.

IMPORTANT: All RALs in this conversation share the SAME conversation history.
The paused RALs have already seen all prior messages (including any instructions, constraints, or context from earlier in the conversation).
Only inject NEW information that occurred AFTER the paused RAL started - do NOT repeat information from the shared conversation history.

Other active executions in this conversation (currently PAUSED):

${ralDescriptions}

${toolInstructions}

CRITICAL: You must coordinate with paused RALs before proceeding:

1. If the user's NEW request CONFLICTS with or CHANGES what a paused RAL is doing:
   → Use ral_inject to tell that RAL about the NEW user instruction only
   → Do NOT repeat instructions or constraints that were in the original conversation - they already have those
   → Example: User says "write jokes instead" while RAL #1 is writing poems
   → Call: ral_inject(1, "STOP. User changed request: write jokes instead of poems.")

2. If the user wants to CANCEL a paused RAL entirely:
   → Use ral_abort if available, OR ral_inject with stop instruction if it has delegations

3. If the user's request is UNRELATED to the paused RALs:
   → Proceed with your own work (the paused RALs will resume automatically)

The paused RALs will resume after you make your first tool call. Decide NOW.
`;
  }
}

// Singleton instance for convenience
let coordinatorInstance: ConcurrentRALCoordinator | undefined;

export function getConcurrentRALCoordinator(): ConcurrentRALCoordinator {
  if (!coordinatorInstance) {
    coordinatorInstance = new ConcurrentRALCoordinator();
  }
  return coordinatorInstance;
}
