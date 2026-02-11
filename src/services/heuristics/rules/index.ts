/**
 * Heuristic Rules Registry
 *
 * Exports all available heuristics for registration with the engine.
 */

export { todoReminderOnToolUseHeuristic } from "./todoReminderOnToolUse";

// Note: todoBeforeDelegationHeuristic is deprecated - delegation now has hard enforcement
// at the tool level (delegate.ts, delegate_crossproject.ts) which blocks before heuristics run.
// Keeping the export for backward compatibility but not registering it.
export { todoBeforeDelegationHeuristic } from "./todoBeforeDelegation";

import type { Heuristic } from "../types";
import { todoReminderOnToolUseHeuristic } from "./todoReminderOnToolUse";

/**
 * Get all default heuristics
 */
export function getDefaultHeuristics(): Heuristic[] {
  return [
    // todoBeforeDelegationHeuristic removed - delegation is now hard-blocked at tool level
    todoReminderOnToolUseHeuristic,
  ];
}
