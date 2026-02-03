/**
 * Heuristic Rules Registry
 *
 * Exports all available heuristics for registration with the engine.
 */

export { todoBeforeDelegationHeuristic } from "./todoBeforeDelegation";

import type { Heuristic } from "../types";
import { todoBeforeDelegationHeuristic } from "./todoBeforeDelegation";

/**
 * Get all default heuristics
 */
export function getDefaultHeuristics(): Heuristic[] {
  return [
    todoBeforeDelegationHeuristic,
  ];
}
