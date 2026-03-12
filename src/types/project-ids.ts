/**
 * Branded types for project identifiers.
 *
 * Projects have two identifier formats:
 *
 * 1. ProjectDTag — the d-tag value (e.g. "TENEX-ff3ssq")
 *    Used internally for: disk paths, conversation lookups, config keys,
 *    RAL registry entries, all internal state.
 *
 * 2. ProjectAddress — the NIP-33 address (e.g. "31933:<pubkey>:TENEX-ff3ssq")
 *    Used only at Nostr publishing boundaries: constructing ["a", ...] tags,
 *    subscription filters with #a, and receiving a-tag values from events.
 *
 * D-tags are unique within a TENEX instance.
 */

// =============================================================================
// Branded Types
// =============================================================================

/**
 * Project d-tag value — the internal identifier for a project.
 * Example: "TENEX-ff3ssq"
 */
export type ProjectDTag = string & { readonly __brand: "ProjectDTag" };

/**
 * NIP-33 addressable event coordinate.
 * Format: "31933:<pubkey>:<d-tag>"
 * Only used at Nostr event tag construction boundaries.
 */
export type ProjectAddress = string & { readonly __brand: "ProjectAddress" };

// =============================================================================
// Regex Patterns
// =============================================================================

/** NIP-33 address: kind:pubkey:identifier */
const PROJECT_ADDRESS_PATTERN = /^31933:[0-9a-f]{64}:.+$/;

/** D-tag: non-empty string that is NOT a NIP-33 address */
function isDTagFormat(value: string): boolean {
    return value.length > 0 && !PROJECT_ADDRESS_PATTERN.test(value);
}

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Check if a string looks like a project d-tag (not a NIP-33 address).
 */
export function isProjectDTag(value: string): value is ProjectDTag {
    return isDTagFormat(value);
}

/**
 * Check if a string is a valid NIP-33 project address.
 */
export function isProjectAddress(value: string): value is ProjectAddress {
    return PROJECT_ADDRESS_PATTERN.test(value);
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create a ProjectDTag from a string, with validation.
 * @throws Error if the input looks like a NIP-33 address
 */
export function createProjectDTag(value: string): ProjectDTag {
    if (!value) {
        throw new Error("ProjectDTag cannot be empty");
    }
    if (isProjectAddress(value)) {
        throw new Error(
            `Invalid ProjectDTag: "${value}" looks like a NIP-33 address. ` +
            `Use extractDTagFromAddress() to extract the d-tag.`
        );
    }
    return value as ProjectDTag;
}

/**
 * Create a ProjectAddress from a string, with validation.
 * @throws Error if the input is not a valid NIP-33 address
 */
export function createProjectAddress(value: string): ProjectAddress {
    if (!isProjectAddress(value)) {
        throw new Error(
            `Invalid ProjectAddress: expected "31933:<64-char-hex-pubkey>:<d-tag>", got "${value}"`
        );
    }
    return value as ProjectAddress;
}

// =============================================================================
// Conversion Functions
// =============================================================================

/**
 * Extract the d-tag from a NIP-33 project address.
 * "31933:<pubkey>:TENEX-ff3ssq" → "TENEX-ff3ssq"
 *
 * @throws Error if the input is not a valid NIP-33 address
 */
export function extractDTagFromAddress(address: ProjectAddress): ProjectDTag {
    // Format: "kind:pubkey:dTag" — split on first two colons only
    const firstColon = address.indexOf(":");
    const secondColon = address.indexOf(":", firstColon + 1);
    if (secondColon === -1) {
        throw new Error(`Cannot extract d-tag from address: "${address}"`);
    }
    const dTag = address.substring(secondColon + 1);
    return dTag as ProjectDTag;
}

/**
 * Build a NIP-33 project address from its parts.
 * Only use this when you have the parts separately and need to assemble.
 * If you have an NDKProject, use project.tagId() directly.
 */
export function buildProjectAddress(
    kind: number,
    pubkey: string,
    dTag: ProjectDTag
): ProjectAddress {
    return `${kind}:${pubkey}:${dTag}` as ProjectAddress;
}

/**
 * Extract the d-tag from a raw NIP-33 address string.
 * Useful at parsing boundaries where we receive untyped a-tag values.
 * Returns null if the string is not a valid NIP-33 address.
 */
export function tryExtractDTagFromAddress(value: string): ProjectDTag | null {
    if (!isProjectAddress(value)) {
        return null;
    }
    return extractDTagFromAddress(value as ProjectAddress);
}
