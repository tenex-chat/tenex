/**
 * Register all default heuristics with the HeuristicRegistry
 * This should be called during application startup
 */
import { logger } from "@/utils/logger";
import {
    HeuristicRegistry,
    SilentAgentHeuristic,
    DelegationClaimHeuristic,
    ConsecutiveToolsWithoutTodoHeuristic,
    PendingTodosHeuristic,
    TodoReminderHeuristic,
} from "./heuristics";
import { trace, SpanStatusCode } from "@opentelemetry/api";

const tracer = trace.getTracer("tenex.supervision");

let registered = false;

/**
 * Register all default supervision heuristics
 * Safe to call multiple times - will only register once
 *
 * IMPORTANT: This must be called during startup to enable supervision.
 * Without registered heuristics, the supervision system will throw an error
 * (fail-closed behavior to prevent silent supervision bypass).
 */
export function registerDefaultHeuristics(): void {
    if (registered) {
        // Routine re-registration check - use DEBUG to avoid log spam
        logger.debug("[Supervision] Heuristics already registered, skipping re-registration", {
            count: HeuristicRegistry.getInstance().size,
            ids: HeuristicRegistry.getInstance().getAllIds(),
        });
        return;
    }

    const span = tracer.startSpan("supervision.register_default_heuristics");

    try {
        const registry = HeuristicRegistry.getInstance();
        const sizeBefore = registry.size;

        span.setAttribute("registry.size_before", sizeBefore);

        // Register post-completion heuristics
        registry.register(new SilentAgentHeuristic());
        registry.register(new DelegationClaimHeuristic());
        registry.register(new ConsecutiveToolsWithoutTodoHeuristic());
        registry.register(new PendingTodosHeuristic());
        registry.register(new TodoReminderHeuristic());

        registered = true;
        const sizeAfter = registry.size;
        const registeredIds = registry.getAllIds();

        span.setAttributes({
            "registry.size_after": sizeAfter,
            "registry.heuristics_added": sizeAfter - sizeBefore,
            "registry.ids": registeredIds.join(","),
        });

        span.addEvent("supervision.heuristics_registered", {
            "count": sizeAfter,
            "ids": registeredIds.join(","),
        });

        span.setStatus({ code: SpanStatusCode.OK });

        // Use INFO level to ensure this is always visible in logs
        logger.info("[Supervision] Successfully registered default heuristics", {
            count: sizeAfter,
            ids: registeredIds,
            sizeBefore,
            sizeAfter,
        });
    } catch (error) {
        // Normalize error before recording
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        span.recordException(normalizedError);
        span.setStatus({ code: SpanStatusCode.ERROR, message: "Failed to register heuristics" });
        logger.error("[Supervision] FATAL: Failed to register default heuristics", normalizedError);
        throw error;
    } finally {
        span.end();
    }
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

/**
 * Reset registration state for testing purposes.
 * This allows tests to verify fail-closed behavior by clearing heuristics
 * and ensuring registerDefaultHeuristics() will run fresh.
 *
 * WARNING: Only use in tests. Never call in production code.
 */
export function resetRegistrationForTesting(): void {
    registered = false;
    HeuristicRegistry.getInstance().clear();
}
