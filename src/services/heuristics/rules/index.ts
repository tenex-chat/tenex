/**
 * Heuristic Rules Registry
 *
 * Exports all available heuristics for registration with the engine.
 */

export { todoBeforeDelegationHeuristic } from "./todoBeforeDelegation";
export { branchIsolationHeuristic } from "./branchIsolation";
export { verificationBeforeMergeHeuristic } from "./verificationBeforeMerge";
export { gitAgentForCommitsHeuristic } from "./gitAgentForCommits";

import type { Heuristic } from "../types";
import { todoBeforeDelegationHeuristic } from "./todoBeforeDelegation";
import { branchIsolationHeuristic } from "./branchIsolation";
import { verificationBeforeMergeHeuristic } from "./verificationBeforeMerge";
import { gitAgentForCommitsHeuristic } from "./gitAgentForCommits";

/**
 * Get all default heuristics
 */
export function getDefaultHeuristics(): Heuristic[] {
  return [
    todoBeforeDelegationHeuristic,
    branchIsolationHeuristic,
    verificationBeforeMergeHeuristic,
    gitAgentForCommitsHeuristic,
  ];
}
