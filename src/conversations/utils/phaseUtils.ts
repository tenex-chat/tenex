import { logger } from "@/utils/logger";

/**
 * Validates if a phase string is valid
 * @param phase - The phase string to validate
 * @returns true if valid, false otherwise
 */
export function isValidPhase(phase: string | undefined | null): phase is string {
    if (!phase || typeof phase !== "string") {
        return false;
    }

    // Phase must be non-empty and not contain special characters that could break parsing
    return phase.trim().length > 0 && !/[<>"]/.test(phase);
}

/**
 * Normalizes a phase string for consistent comparison
 * @param phase - The phase string to normalize
 * @returns Normalized phase string or undefined if invalid
 */
export function normalizePhase(phase: string | undefined | null): string | undefined {
    if (!isValidPhase(phase)) {
        return undefined;
    }

    return phase.trim().toLowerCase();
}

/**
 * Checks if two phases match (case-insensitive)
 * @param phase1 - First phase to compare
 * @param phase2 - Second phase to compare
 * @returns true if phases match, false otherwise
 */
export function phasesMatch(
    phase1: string | undefined | null,
    phase2: string | undefined | null
): boolean {
    const normalized1 = normalizePhase(phase1);
    const normalized2 = normalizePhase(phase2);

    // Both undefined means no phase restriction - they match
    if (normalized1 === undefined && normalized2 === undefined) {
        return true;
    }

    // One undefined and one defined means they don't match
    if (normalized1 === undefined || normalized2 === undefined) {
        return false;
    }

    return normalized1 === normalized2;
}

/**
 * Extracts phase from a Nostr event's tags
 * @param tags - The event tags array
 * @returns The phase string if found, undefined otherwise
 */
export function extractPhaseFromTags(tags: string[][]): string | undefined {
    const phaseTag = tags.find((tag) => tag[0] === "phase");
    return phaseTag?.[1];
}

/**
 * Creates a phase tag for a Nostr event
 * @param phase - The phase string
 * @returns A tag array or undefined if phase is invalid
 */
export function createPhaseTag(phase: string | undefined | null): string[] | undefined {
    if (!isValidPhase(phase)) {
        return undefined;
    }

    return ["phase", phase.trim()];
}

/**
 * Filters agent definitions by phase
 * @param definitions - Array of agent definitions
 * @param targetPhase - The phase to filter by (undefined means no phase restriction)
 * @returns Filtered array of definitions that match the phase
 */
export function filterDefinitionsByPhase<T extends { phase?: string }>(
    definitions: T[],
    targetPhase: string | undefined
): T[] {
    if (targetPhase === undefined) {
        // No phase specified - return all definitions without a phase
        return definitions.filter((def) => !def.phase);
    }

    const normalizedTarget = normalizePhase(targetPhase);
    if (!normalizedTarget) {
        logger.warn("Invalid target phase provided for filtering", { targetPhase });
        return [];
    }

    return definitions.filter((def) => {
        const defPhase = normalizePhase(def.phase);
        // Match if definition has same phase, or no phase (universal)
        return defPhase === normalizedTarget || defPhase === undefined;
    });
}

/**
 * Determines if an agent definition should be used for a given phase
 * @param definitionPhase - The phase from the agent definition
 * @param requestPhase - The phase from the request/context
 * @returns true if the definition should be used
 */
export function shouldUseDefinitionForPhase(
    definitionPhase: string | undefined,
    requestPhase: string | undefined
): boolean {
    // If definition has no phase, it's universal and can be used
    if (!definitionPhase) {
        return true;
    }

    // If definition has phase but request doesn't, don't use it
    if (definitionPhase && !requestPhase) {
        return false;
    }

    // Both have phases - they must match
    return phasesMatch(definitionPhase, requestPhase);
}

/**
 * Get a cache key that includes phase information
 * @param baseKey - The base cache key
 * @param phase - The phase to include
 * @returns Combined cache key
 */
export function getPhaseCacheKey(baseKey: string, phase: string | undefined): string {
    if (!phase) {
        return baseKey;
    }

    const normalizedPhase = normalizePhase(phase);
    if (!normalizedPhase) {
        return baseKey;
    }

    return `${baseKey}:phase:${normalizedPhase}`;
}
