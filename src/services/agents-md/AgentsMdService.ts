/**
 * AgentsMdService - Service for discovering and reading AGENTS.md files
 *
 * AGENTS.md files provide contextual guidelines for AI agents working in specific
 * directories. These files are discovered hierarchically and injected as system
 * reminders after relevant tool results (like fs_read).
 *
 * Key behaviors:
 * - Finds all AGENTS.md files from a path up to the project root
 * - Returns them in order from most specific to most general
 * - Caches file contents to avoid repeated reads
 */

import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { trace } from "@opentelemetry/api";

export interface AgentsMdFile {
    /** Absolute path to the AGENTS.md file */
    path: string;
    /** Directory containing the AGENTS.md file */
    directory: string;
    /** Content of the AGENTS.md file */
    content: string;
}

/**
 * Singleton service for AGENTS.md file discovery and caching
 */
class AgentsMdServiceImpl {
    /** Cache of AGENTS.md file contents by absolute path */
    private contentCache = new Map<string, string | null>();

    /** Cache expiry time in milliseconds (5 minutes) */
    private readonly CACHE_TTL = 5 * 60 * 1000;

    /** Timestamps for cache entries */
    private cacheTimestamps = new Map<string, number>();

    /**
     * Find all AGENTS.md files from the given path up to the project root.
     *
     * @param targetPath - The file or directory path being accessed
     * @param projectRoot - The project root directory (stops search here)
     * @returns Array of AGENTS.md files, ordered from most specific to most general
     */
    async findAgentsMdFiles(
        targetPath: string,
        projectRoot: string
    ): Promise<AgentsMdFile[]> {
        const absoluteTargetPath = resolve(targetPath);
        const absoluteProjectRoot = resolve(projectRoot);

        // Start from the directory containing the target
        let currentDir = existsSync(absoluteTargetPath) && !absoluteTargetPath.endsWith("/")
            ? (await this.isDirectory(absoluteTargetPath) ? absoluteTargetPath : dirname(absoluteTargetPath))
            : dirname(absoluteTargetPath);

        const results: AgentsMdFile[] = [];
        const visited = new Set<string>();

        // Walk up the directory tree until we reach the project root (inclusive)
        // Note: startsWith handles equality case, so no need for explicit === check
        while (currentDir.startsWith(absoluteProjectRoot)) {
            // Avoid infinite loop
            if (visited.has(currentDir)) break;
            visited.add(currentDir);

            const agentsMdPath = join(currentDir, "AGENTS.md");
            const content = await this.readAgentsMd(agentsMdPath);

            if (content !== null) {
                results.push({
                    path: agentsMdPath,
                    directory: currentDir,
                    content,
                });
            }

            // Stop at project root
            if (currentDir === absoluteProjectRoot) break;

            // Move up one directory
            const parent = dirname(currentDir);
            if (parent === currentDir) break; // Reached filesystem root
            currentDir = parent;
        }

        return results;
    }

    /**
     * Check if the project root has an AGENTS.md file.
     *
     * @param projectRoot - The project root directory
     * @returns true if AGENTS.md exists at the project root
     */
    async hasRootAgentsMd(projectRoot: string): Promise<boolean> {
        const agentsMdPath = join(resolve(projectRoot), "AGENTS.md");
        const content = await this.readAgentsMd(agentsMdPath);
        return content !== null;
    }

    /**
     * Get the content of the root AGENTS.md file.
     *
     * @param projectRoot - The project root directory
     * @returns The content of the AGENTS.md file, or null if not found
     */
    async getRootAgentsMdContent(projectRoot: string): Promise<string | null> {
        const agentsMdPath = join(resolve(projectRoot), "AGENTS.md");
        return this.readAgentsMd(agentsMdPath);
    }

    /**
     * Read an AGENTS.md file with caching.
     */
    private async readAgentsMd(absolutePath: string): Promise<string | null> {
        const now = Date.now();
        const cachedTimestamp = this.cacheTimestamps.get(absolutePath);

        // Check if cache entry exists and is still valid
        if (cachedTimestamp && now - cachedTimestamp < this.CACHE_TTL) {
            const cached = this.contentCache.get(absolutePath);
            if (cached !== undefined) {
                return cached;
            }
        }

        // Read from disk
        try {
            if (!existsSync(absolutePath)) {
                this.contentCache.set(absolutePath, null);
                this.cacheTimestamps.set(absolutePath, now);
                return null;
            }

            const content = await readFile(absolutePath, "utf-8");
            this.contentCache.set(absolutePath, content);
            this.cacheTimestamps.set(absolutePath, now);
            return content;
        } catch (error) {
            // Trace error for debugging (file not found after existsSync is unexpected)
            trace.getActiveSpan?.()?.addEvent("agents_md.read_error", {
                "agents_md.path": absolutePath,
                "agents_md.error": error instanceof Error ? error.message : String(error),
            });
            this.contentCache.set(absolutePath, null);
            this.cacheTimestamps.set(absolutePath, now);
            return null;
        }
    }

    /**
     * Check if a path is a directory
     */
    private async isDirectory(path: string): Promise<boolean> {
        try {
            const stats = await stat(path);
            return stats.isDirectory();
        } catch {
            return false;
        }
    }

    /**
     * Clear the cache (useful for testing)
     */
    clearCache(): void {
        this.contentCache.clear();
        this.cacheTimestamps.clear();
    }

    /**
     * Invalidate a specific path in the cache
     */
    invalidatePath(absolutePath: string): void {
        this.contentCache.delete(absolutePath);
        this.cacheTimestamps.delete(absolutePath);
    }
}

export const agentsMdService = new AgentsMdServiceImpl();
