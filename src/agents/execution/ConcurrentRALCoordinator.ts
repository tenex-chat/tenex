/**
 * Concurrent RAL coordination functions
 *
 * Responsible for:
 * - Building context messages for agents about other active RALs
 * - Determining when paused RALs should be released
 * - Providing tool availability based on RAL state
 */

import type { RALSummary } from "@/services/ral";
import {
  concurrentRALContextFragment,
  type RALToolAvailability,
} from "@/prompts/fragments/concurrent-ral-context";
import { toolHasSideEffects } from "@/tools/registry";

export type { RALToolAvailability };

export interface StepInfo {
  stepNumber: number;
  toolCalls: Array<{ toolName: string }>;
  text: string;
  reasoningText?: string;
}

/**
 * Determine tool availability for each RAL
 * - ral_abort is only available if RAL has no pending delegations
 */
export function getToolAvailability(rals: RALSummary[]): RALToolAvailability[] {
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
 * - At least one step has a "decision" tool call (a tool with side effects)
 *
 * Don't release when:
 * - No steps completed yet
 * - Only reasoning/thinking was produced (no tool calls)
 * - Only read-only tools were called (agent is still gathering context)
 *
 * This ensures the agent has time to gather context before deciding how to coordinate.
 */
export function shouldReleasePausedRALs(steps: StepInfo[]): boolean {
  if (steps.length === 0) {
    return false;
  }

  // Check if any step had a tool call with side effects (not just read-only tools)
  return steps.some(step =>
    step.toolCalls.some(tc => toolHasSideEffects(tc.toolName))
  );
}

/**
 * Build the context message for an agent about other active RALs
 * @param otherRALs - Summaries of other active RALs
 * @param currentRALNumber - The RAL number of the agent receiving this context
 * @param actionHistory - Map of RAL number to action history string (tool calls, text output)
 */
export function buildContext(
  otherRALs: RALSummary[],
  currentRALNumber: number,
  actionHistory: Map<number, string>
): string {
  if (otherRALs.length === 0) return "";

  const toolAvailability = getToolAvailability(otherRALs);

  // This fragment template is synchronous, cast to string
  return concurrentRALContextFragment.template({
    otherRALs,
    currentRALNumber,
    toolAvailability,
    actionHistory,
  }) as string;
}
