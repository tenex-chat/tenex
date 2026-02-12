import { mkdirSync, readdirSync, readFileSync, realpathSync, existsSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve, dirname } from "node:path";
import { getTenexBasePath } from "@/constants";
import { logger } from "@/utils/logger";

/**
 * Error thrown when a path escapes the agent's home directory scope.
 */
export class HomeScopeViolationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "HomeScopeViolationError";
    }
}

/**
 * Maximum number of +prefixed files to inject into system prompt.
 * Prevents prompt bloat if an agent creates many files.
 */
const MAX_INJECTED_FILES = 10;

/**
 * Maximum content length for injected files before truncation.
 */
const MAX_INJECTED_FILE_LENGTH = 1500;

/**
 * Represents a file to be injected into the agent's system prompt.
 */
export interface InjectedFile {
    filename: string;
    content: string;
    truncated: boolean;
}

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
 * Resolve the real path of a file or directory, following symlinks.
 * If the path doesn't exist, resolves the parent directory and appends the filename.
 * This ensures symlinks are resolved even for files that will be created.
 * @param inputPath - The path to resolve
 * @returns The resolved real path with symlinks followed
 */
function resolveRealPath(inputPath: string): string {
    const normalized = normalizePath(inputPath);

    // If the path exists, resolve it directly
    if (existsSync(normalized)) {
        return realpathSync(normalized);
    }

    // Path doesn't exist - resolve the parent directory instead
    // This catches symlinks in the parent chain
    const parentDir = dirname(normalized);
    const filename = normalized.slice(parentDir.length + 1); // Get the filename portion

    if (existsSync(parentDir)) {
        const realParent = realpathSync(parentDir);
        return join(realParent, filename);
    }

    // Neither path nor parent exists - walk up until we find an existing ancestor
    let currentPath = parentDir;
    const pathParts: string[] = [filename];

    while (currentPath && currentPath !== dirname(currentPath)) {
        const parent = dirname(currentPath);
        pathParts.unshift(currentPath.slice(parent.length + 1));
        currentPath = parent;

        if (existsSync(currentPath)) {
            const realAncestor = realpathSync(currentPath);
            return join(realAncestor, ...pathParts);
        }
    }

    // No ancestor exists, return normalized path as-is
    return normalized;
}

/**
 * Check if a path is within a given directory.
 * Both paths are normalized and symlinks are resolved to prevent escape attacks.
 * Uses path.relative for cross-platform separator handling.
 * @param inputPath - The path to check (will be normalized, symlinks resolved)
 * @param directory - The directory to check against (will be normalized, symlinks resolved)
 * @returns true if path is within or equal to directory
 */
export function isPathWithinDirectory(inputPath: string, directory: string): boolean {
    // Resolve symlinks to prevent symlink escape attacks
    const realPath = resolveRealPath(inputPath);
    const realDir = resolveRealPath(directory);

    // Use path.relative for cross-platform handling
    // If the relative path starts with ".." or is absolute, the path is outside
    const relativePath = relative(realDir, realPath);

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
        console.error("Failed to create agent home dir:", error);
        return false;
    }
}

/**
 * Get files in the agent's home directory that start with '+' prefix.
 * These files are auto-injected into the agent's system prompt.
 *
 * Security: Only reads regular files (skips symlinks and directories).
 * Limits: Max 10 files, max 1500 chars per file (truncated if longer).
 *
 * @param agentPubkey - The agent's pubkey
 * @returns Array of injected file objects with filename, content, and truncated flag
 */
export function getAgentHomeInjectedFiles(agentPubkey: string): InjectedFile[] {
    const homeDir = getAgentHomeDirectory(agentPubkey);

    // Ensure directory exists
    if (!ensureAgentHomeDirectory(agentPubkey)) {
        return [];
    }

    try {
        const entries = readdirSync(homeDir, { withFileTypes: true });

        // Filter for +prefixed regular files only (skip symlinks and directories for security)
        const plusFiles = entries
            .filter((entry) => entry.name.startsWith("+") && entry.isFile())
            .sort((a, b) => a.name.localeCompare(b.name))
            .slice(0, MAX_INJECTED_FILES);

        const injectedFiles: InjectedFile[] = [];

        for (const entry of plusFiles) {
            try {
                const filePath = join(homeDir, entry.name);
                const rawContent = readFileSync(filePath, "utf-8");
                const truncated = rawContent.length > MAX_INJECTED_FILE_LENGTH;
                const content = truncated
                    ? rawContent.slice(0, MAX_INJECTED_FILE_LENGTH)
                    : rawContent;

                injectedFiles.push({
                    filename: entry.name,
                    content,
                    truncated,
                });
            } catch (error) {
                // Skip files that can't be read (permission issues, etc.)
                logger.warn(`Failed to read injected file ${entry.name}:`, error);
            }
        }

        return injectedFiles;
    } catch (error) {
        logger.warn("Failed to scan agent home for injected files:", error);
        return [];
    }
}

/**
 * Resolve a path that must be within the agent's home directory.
 * Accepts both relative paths (resolved against home) and absolute paths.
 *
 * Security: Uses isPathWithinDirectory() which handles symlinks and path traversal.
 *
 * @param inputPath - Relative or absolute path
 * @param agentPubkey - The agent's pubkey
 * @returns The resolved absolute path within the agent's home
 * @throws HomeScopeViolationError if path escapes home directory
 */
export function resolveHomeScopedPath(inputPath: string, agentPubkey: string): string {
    const homeDir = getAgentHomeDirectory(agentPubkey);

    // Ensure home directory exists
    ensureAgentHomeDirectory(agentPubkey);

    // Resolve path: treat relative paths as relative to home directory
    const resolvedPath = isAbsolute(inputPath)
        ? inputPath
        : join(homeDir, inputPath);

    // Validate the resolved path is within home directory
    if (!isPathWithinDirectory(resolvedPath, homeDir)) {
        throw new HomeScopeViolationError(
            `Path "${inputPath}" is outside your home directory. ` +
            `You can only access files within your home directory.`
        );
    }

    return resolvedPath;
}
