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
