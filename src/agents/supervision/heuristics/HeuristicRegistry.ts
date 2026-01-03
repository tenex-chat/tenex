import { logger } from "@/utils/logger";
import type { Heuristic, HeuristicTiming, PostCompletionContext, PreToolContext } from "../types";

/**
 * Singleton registry for managing supervision heuristics
 * Allows registration and retrieval of heuristics by timing and tool filter
 */
export class HeuristicRegistry {
    private static instance: HeuristicRegistry | null = null;

    private heuristics: Map<string, Heuristic<unknown>> = new Map();

    private constructor() {
        // Private constructor for singleton pattern
    }

    /**
     * Get the singleton instance of the registry
     */
    static getInstance(): HeuristicRegistry {
        if (!HeuristicRegistry.instance) {
            HeuristicRegistry.instance = new HeuristicRegistry();
        }
        return HeuristicRegistry.instance;
    }

    /**
     * Register a heuristic with the registry
     * @param heuristic - The heuristic to register
     */
    register<T>(heuristic: Heuristic<T>): void {
        if (this.heuristics.has(heuristic.id)) {
            logger.warn(
                `[HeuristicRegistry] Heuristic with id "${heuristic.id}" already registered, overwriting`
            );
        }
        this.heuristics.set(heuristic.id, heuristic as Heuristic<unknown>);
        logger.debug(`[HeuristicRegistry] Registered heuristic: ${heuristic.id} (${heuristic.timing})`);
    }

    /**
     * Get all heuristics for a specific timing
     * @param timing - The timing to filter by
     * @returns Array of heuristics matching the timing
     */
    getByTiming(timing: HeuristicTiming): Heuristic<unknown>[] {
        const result: Heuristic<unknown>[] = [];
        for (const heuristic of this.heuristics.values()) {
            if (heuristic.timing === timing) {
                result.push(heuristic);
            }
        }
        return result;
    }

    /**
     * Get pre-tool-execution heuristics filtered by tool name
     * Returns heuristics that either have no tool filter or include the given tool
     * @param toolName - The tool name to filter by
     * @returns Array of applicable pre-tool heuristics
     */
    getPreToolHeuristics(toolName: string): Heuristic<PreToolContext>[] {
        const result: Heuristic<PreToolContext>[] = [];
        for (const heuristic of this.heuristics.values()) {
            if (heuristic.timing !== "pre-tool-execution") {
                continue;
            }
            // Include if no tool filter or tool is in the filter list
            if (!heuristic.toolFilter || heuristic.toolFilter.includes(toolName)) {
                result.push(heuristic as Heuristic<PreToolContext>);
            }
        }
        return result;
    }

    /**
     * Get all post-completion heuristics
     * @returns Array of post-completion heuristics
     */
    getPostCompletionHeuristics(): Heuristic<PostCompletionContext>[] {
        return this.getByTiming("post-completion") as Heuristic<PostCompletionContext>[];
    }

    /**
     * Get a specific heuristic by ID
     * @param id - The heuristic ID
     * @returns The heuristic or undefined if not found
     */
    get(id: string): Heuristic<unknown> | undefined {
        return this.heuristics.get(id);
    }

    /**
     * Clear all registered heuristics (mainly for testing)
     */
    clear(): void {
        this.heuristics.clear();
        logger.debug("[HeuristicRegistry] Cleared all heuristics");
    }

    /**
     * Get all registered heuristic IDs (for debugging)
     */
    getAllIds(): string[] {
        return Array.from(this.heuristics.keys());
    }

    /**
     * Get the count of registered heuristics
     */
    get size(): number {
        return this.heuristics.size;
    }
}
