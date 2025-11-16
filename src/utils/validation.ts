/**
 * Centralized validation utilities for common patterns
 */

/**
 * Validates if a string is a valid slug format (alphanumeric with hyphens and underscores)
 */
export function isValidSlug(name: string): boolean {
    return /^[a-zA-Z0-9-_]+$/.test(name);
}
