/**
 * Centralized supervision health check utility.
 * Ensures consistent fail-closed validation across all supervision entry points.
 *
 * The supervision system uses a fail-closed approach: if heuristics aren't properly
 * registered, the system should refuse to proceed rather than silently bypassing supervision.
 */

import { HeuristicRegistry } from "./heuristics/HeuristicRegistry";
import { registerDefaultHeuristics } from "./registerHeuristics";
import { logger } from "@/utils/logger";

/**
 * Result of a supervision health check.
 */
export interface SupervisionHealthCheckResult {
    /** Whether the health check passed */
    healthy: boolean;
    /** Total number of registered heuristics */
    registrySize: number;
    /** Number of post-completion heuristics */
    postCompletionCount: number;
    /** IDs of all registered heuristics */
    heuristicIds: string[];
    /** Error message if unhealthy */
    errorMessage?: string;
}

/**
 * Perform a comprehensive supervision health check.
 *
 * This validates the CURRENT state of the registry:
 * 1. Registry is not empty (CRITICAL - fail-closed)
 * 2. Post-completion heuristics exist (CRITICAL - fail-closed)
 *
 * NOTE: This function does NOT register heuristics - callers should ensure
 * registerDefaultHeuristics() has been called before checking health.
 * This separation allows proper testing of fail-closed behavior.
 *
 * FAIL-CLOSED SEMANTICS:
 * - Returns healthy=false if ANY critical condition is not met
 * - Caller is responsible for acting on the result (throwing, logging, etc.)
 *
 * @returns Health check result with diagnostic information
 */
export function checkSupervisionHealth(): SupervisionHealthCheckResult {
    const registry = HeuristicRegistry.getInstance();
    const registrySize = registry.size;
    const heuristicIds = registry.getAllIds();
    const postCompletionCount = registry.getPostCompletionHeuristics().length;

    // FAIL-CLOSED: Both conditions must be met
    if (registrySize === 0) {
        const errorMessage =
            `FATAL: Supervision system has no heuristics registered! ` +
            `This indicates a critical configuration error. ` +
            `The system cannot proceed without supervision.`;

        return {
            healthy: false,
            registrySize,
            postCompletionCount,
            heuristicIds,
            errorMessage,
        };
    }

    if (postCompletionCount === 0) {
        const errorMessage =
            `FATAL: No post-completion heuristics registered! ` +
            `Registry has ${registrySize} total heuristics: [${heuristicIds.join(", ")}], ` +
            `but none are post-completion type. ` +
            `Supervision system is misconfigured - refusing to proceed without post-completion checks.`;

        return {
            healthy: false,
            registrySize,
            postCompletionCount,
            heuristicIds,
            errorMessage,
        };
    }

    return {
        healthy: true,
        registrySize,
        postCompletionCount,
        heuristicIds,
    };
}

/**
 * Assert supervision health, throwing if unhealthy.
 *
 * This function:
 * 1. Ensures heuristics are registered (calls registerDefaultHeuristics)
 * 2. Performs health check
 * 3. Throws if unhealthy
 *
 * Use this at startup or before executing completions to ensure
 * fail-closed behavior is enforced consistently.
 *
 * @param context - Context string for error messages (e.g., "AgentExecutor", "ProjectRuntime")
 * @throws Error if supervision health check fails
 */
export function assertSupervisionHealth(context: string): void {
    // Ensure heuristics are registered before checking health
    registerDefaultHeuristics();

    const result = checkSupervisionHealth();

    if (!result.healthy) {
        const fullMessage = `[${context}] ${result.errorMessage}`;
        logger.error(fullMessage);
        throw new Error(fullMessage);
    }

    logger.debug(`[${context}] Supervision health check passed`, {
        registrySize: result.registrySize,
        postCompletionCount: result.postCompletionCount,
        heuristicIds: result.heuristicIds,
    });
}
