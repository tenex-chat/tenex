import * as fs from "node:fs/promises";
import { config } from "@/services/ConfigService";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "./logger";

/**
 * Lockfile information
 */
interface LockInfo {
    pid: number;
    hostname: string;
    startedAt: number;
}

/**
 * Lockfile manager for preventing multiple daemon instances
 */
export class Lockfile {
    private lockfilePath: string;
    private currentPid: number;

    constructor(lockfilePath: string) {
        this.lockfilePath = lockfilePath;
        this.currentPid = process.pid;
    }

    /**
     * Acquire the lock. Throws if lock cannot be acquired.
     */
    async acquire(): Promise<void> {
        // Check if lockfile exists using fs.stat
        let lockfileExists = false;
        try {
            await fs.stat(this.lockfilePath);
            lockfileExists = true;
        } catch (error) {
            const err = error as NodeJS.ErrnoException;
            if (err.code !== "ENOENT") {
                // Unexpected error accessing lockfile
                throw error;
            }
            // File doesn't exist - we can proceed to create it
        }

        // If lockfile exists, check if the process is still running
        if (lockfileExists) {
            const content = await fs.readFile(this.lockfilePath, "utf-8");
            const lockInfo: LockInfo = JSON.parse(content);

            if (this.isProcessRunning(lockInfo.pid)) {
                // Process is running - cannot acquire lock
                throw new Error(
                    `Daemon is already running (PID: ${lockInfo.pid}, started at: ${new Date(lockInfo.startedAt).toISOString()})`
                );
            }

            // Stale lockfile - previous process crashed or was killed
            logger.warn("Found stale lockfile, removing it", {
                stalePid: lockInfo.pid,
                startedAt: new Date(lockInfo.startedAt).toISOString(),
            });
            await this.release();
        }

        // Create new lockfile
        const lockInfo: LockInfo = {
            pid: this.currentPid,
            hostname: os.hostname(),
            startedAt: Date.now(),
        };

        await fs.writeFile(this.lockfilePath, JSON.stringify(lockInfo, null, 2), "utf-8");

        logger.debug("Lockfile acquired", {
            lockfilePath: this.lockfilePath,
            pid: this.currentPid,
        });
    }

    /**
     * Release the lock
     */
    async release(): Promise<void> {
        try {
            await fs.unlink(this.lockfilePath);
            logger.debug("Lockfile released", { lockfilePath: this.lockfilePath });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                logger.warn("Failed to remove lockfile", {
                    lockfilePath: this.lockfilePath,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }

    /**
     * Check if a process is running by PID
     */
    private isProcessRunning(pid: number): boolean {
        try {
            // Sending signal 0 doesn't actually send a signal,
            // it just checks if the process exists
            process.kill(pid, 0);
            return true;
        } catch (error) {
            const err = error as NodeJS.ErrnoException;

            // ESRCH means process doesn't exist
            if (err.code === "ESRCH") {
                return false;
            }

            // EPERM means process exists but we lack permission to signal it
            if (err.code === "EPERM") {
                return true;
            }

            // Unexpected error - re-throw
            throw error;
        }
    }

    /**
     * Get the default lockfile path for the daemon
     */
    static getDefaultPath(): string {
        const daemonDir = config.getConfigPath("daemon");
        return path.join(daemonDir, "tenex.lock");
    }
}
