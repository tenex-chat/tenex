import { mkdirSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { getTenexBasePath } from "@/constants";
import { logger } from "@/utils/logger";

/**
 * Get the short pubkey (first 8 characters) for an agent.
 */
function getShortPubkey(pubkey: string): string {
    return pubkey.slice(0, 8);
}

/**
 * Get the home directory path for an agent.
 * This is the canonical source of truth for agent home directory paths.
 */
export function getAgentHomeDirectory(agentPubkey: string): string {
    const shortPubkey = getShortPubkey(agentPubkey);
    return join(getTenexBasePath(), "home", shortPubkey);
}

/**
 * Normalize and resolve a path to prevent path traversal attacks.
 * Resolves .., ., and normalizes the path to an absolute form.
 * @param inputPath - The path to normalize (should be absolute)
 * @returns The normalized absolute path
 */
export function normalizePath(inputPath: string): string {
    // Resolve handles .., ., and makes the path absolute
    const resolved = resolve(inputPath);
    // Normalize handles redundant separators
    return normalize(resolved);
}

/**
 * Check if a path is within a given directory.
 * Both paths are normalized to prevent path traversal attacks.
 * Uses path.relative for cross-platform separator handling.
 * @param inputPath - The path to check (will be normalized)
 * @param directory - The directory to check against (will be normalized)
 * @returns true if path is within or equal to directory
 */
export function isPathWithinDirectory(inputPath: string, directory: string): boolean {
    const normalizedPath = normalizePath(inputPath);
    const normalizedDir = normalizePath(directory);

    // Use path.relative for cross-platform handling
    // If the relative path starts with ".." or is absolute, the path is outside
    const relativePath = relative(normalizedDir, normalizedPath);

    // Path is within directory if:
    // 1. It doesn't start with ".." (would mean escaping the directory)
    // 2. It's not absolute (would mean completely different path on Windows)
    // 3. Empty string means it's the same directory
    return !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

/**
 * Check if a path is within the agent's home directory.
 * Normalizes the input path to prevent path traversal attacks.
 * Used by filesystem tools to grant automatic access to agent's own home.
 */
export function isWithinAgentHome(inputPath: string, agentPubkey: string): boolean {
    const homeDir = getAgentHomeDirectory(agentPubkey);
    return isPathWithinDirectory(inputPath, homeDir);
}

/**
 * Ensure the agent's home directory exists.
 * Creates it if it doesn't exist.
 * @returns true if directory exists or was created, false if creation failed
 */
export function ensureAgentHomeDirectory(agentPubkey: string): boolean {
    const homeDir = getAgentHomeDirectory(agentPubkey);
    try {
        mkdirSync(homeDir, { recursive: true });
        return true;
    } catch (error) {
        logger.warn("Failed to create agent home dir:", error);
        return false;
    }
}
