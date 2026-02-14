import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { logger } from "@/utils/logger";

/**
 * State persisted during graceful restart
 */
export interface RestartStateData {
    /** Timestamp when restart was requested */
    requestedAt: number;
    /** List of project IDs that were booted at the time of restart */
    bootedProjects: string[];
    /** PID of the process that requested the restart */
    pid: number;
    /** Hostname for debugging */
    hostname: string;
}

/**
 * Manages restart state persistence for graceful restarts.
 *
 * When the daemon receives SIGHUP in supervised mode, it:
 * 1. Persists the list of currently booted projects
 * 2. Waits for all active RALs to complete
 * 3. Exits cleanly (exit code 0)
 *
 * On startup, the daemon:
 * 1. Checks for restart state file
 * 2. If found, auto-boots the projects listed
 * 3. Clears the restart state file
 */
export class RestartState {
    private static readonly RESTART_STATE_FILE = "restart-state.json";
    private daemonDir: string;

    constructor(daemonDir: string) {
        this.daemonDir = daemonDir;
    }

    /**
     * Get the path to the restart state file
     */
    private getStatePath(): string {
        return path.join(this.daemonDir, RestartState.RESTART_STATE_FILE);
    }

    /**
     * Save restart state before graceful shutdown.
     * Uses atomic write (write to temp file, then rename) to prevent corruption.
     */
    async save(bootedProjects: string[]): Promise<void> {
        const statePath = this.getStatePath();
        const tempPath = `${statePath}.tmp.${process.pid}`;

        const state: RestartStateData = {
            requestedAt: Date.now(),
            bootedProjects,
            pid: process.pid,
            hostname: os.hostname(),
        };

        try {
            // Write to temp file first
            await fs.writeFile(tempPath, JSON.stringify(state, null, 2), "utf-8");

            // Atomic rename
            await fs.rename(tempPath, statePath);

            logger.info("[RestartState] Saved restart state", {
                bootedProjectCount: bootedProjects.length,
                statePath,
            });
        } catch (error) {
            // Clean up temp file on failure
            try {
                await fs.unlink(tempPath);
            } catch {
                // Ignore cleanup errors
            }

            logger.error("[RestartState] Failed to save restart state", {
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }

    /**
     * Load restart state if it exists.
     * Returns null if no restart state file is present.
     */
    async load(): Promise<RestartStateData | null> {
        const statePath = this.getStatePath();

        try {
            const content = await fs.readFile(statePath, "utf-8");
            const state: RestartStateData = JSON.parse(content);

            logger.info("[RestartState] Loaded restart state", {
                requestedAt: new Date(state.requestedAt).toISOString(),
                bootedProjectCount: state.bootedProjects.length,
                originalPid: state.pid,
            });

            return state;
        } catch (error) {
            const err = error as NodeJS.ErrnoException;
            if (err.code === "ENOENT") {
                // No restart state file - normal startup
                return null;
            }

            logger.error("[RestartState] Failed to load restart state", {
                error: error instanceof Error ? error.message : String(error),
            });
            return null;
        }
    }

    /**
     * Clear restart state after successful processing.
     */
    async clear(): Promise<void> {
        const statePath = this.getStatePath();

        try {
            await fs.unlink(statePath);
            logger.debug("[RestartState] Cleared restart state file");
        } catch (error) {
            const err = error as NodeJS.ErrnoException;
            if (err.code !== "ENOENT") {
                logger.warn("[RestartState] Failed to clear restart state", {
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }

    /**
     * Check if a restart state file exists
     */
    async exists(): Promise<boolean> {
        const statePath = this.getStatePath();
        try {
            await fs.stat(statePath);
            return true;
        } catch {
            return false;
        }
    }
}
