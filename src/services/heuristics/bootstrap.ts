import { getHeuristicEngine } from "./HeuristicEngine";
import { getDefaultHeuristics } from "./rules";

let defaultHeuristicsInitialized = false;

export function initializeDefaultHeuristics(): void {
    if (defaultHeuristicsInitialized) {
        return;
    }

    const heuristicEngine = getHeuristicEngine({
        debug: process.env.DEBUG_HEURISTICS === "true",
    });

    for (const heuristic of getDefaultHeuristics()) {
        heuristicEngine.register(heuristic);
    }

    defaultHeuristicsInitialized = true;
}
