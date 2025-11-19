/**
 * Centralized validation utilities for common patterns
 */

import path from "node:path";

/**
 * Validates if a string is a valid slug format (alphanumeric with hyphens and underscores)
 */
export function isValidSlug(name: string): boolean {
    return /^[a-zA-Z0-9-_]+$/.test(name);
}

/**
 * Checks if a path is absolute
 */
export function isAbsolutePath(filePath: string): boolean {
    return path.isAbsolute(filePath);
}
