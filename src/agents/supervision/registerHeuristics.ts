/**
 * Register all default heuristics with the HeuristicRegistry
 * This should be called during application startup
 */
import { logger } from "@/utils/logger";
import {
    HeuristicRegistry,
    SilentAgentHeuristic,
    DelegationClaimHeuristic,
    PhaseAgentTodoHeuristic,
    ConsecutiveToolsWithoutTodoHeuristic,
    PendingTodosHeuristic,
} from "./heuristics";

let registered = false;

/**
 * Register all default supervision heuristics
 * Safe to call multiple times - will only register once
 */
export function registerDefaultHeuristics(): void {
    if (registered) {
        return;
    }

    const registry = HeuristicRegistry.getInstance();

    // Register post-completion heuristics
    registry.register(new SilentAgentHeuristic());
    registry.register(new DelegationClaimHeuristic());
    registry.register(new ConsecutiveToolsWithoutTodoHeuristic());
    registry.register(new PendingTodosHeuristic());

    // Register pre-tool heuristics
    registry.register(new PhaseAgentTodoHeuristic());

    registered = true;
    logger.debug("[Supervision] Registered default heuristics", {
        count: registry.size,
        ids: registry.getAllIds(),
    });
}

/**
 * Configure the DelegationClaimHeuristic with known agent slugs
 * Should be called when agents are loaded/changed
 */
export function updateKnownAgentSlugs(slugs: string[]): void {
    const registry = HeuristicRegistry.getInstance();
    const heuristic = registry.get("delegation-claim") as DelegationClaimHeuristic | undefined;
    if (heuristic) {
        heuristic.setKnownAgentSlugs(slugs);
        logger.debug("[Supervision] Updated known agent slugs", { count: slugs.length });
    }
}
