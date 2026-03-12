#!/usr/bin/env bun

/**
 * TENEX Daemon Wrapper Process
 *
 * A supervisor process that manages the TENEX daemon lifecycle.
 * Features:
 * - Spawns the daemon as a child process with --supervised flag
 * - Forwards SIGHUP to child to trigger graceful restart
 * - Respawns daemon on clean exit (exit code 0)
 * - Crash loop detection to prevent rapid respawns
 *
 * Usage:
 *   bun src/wrapper.ts [daemon options]
 *
 * The wrapper passes all arguments to the daemon command.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Get __filename and __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Resolve the daemon entry point dynamically.
 * Handles both development (src/index.ts) and production (dist/index.js) scenarios.
 *
 * Resolution order:
 * 1. If running from src/, use src/index.ts (sibling of wrapper.ts)
 * 2. If running from dist/, use dist/index.js
 * 3. Fallback: look for index.ts/index.js in the same directory as wrapper
 */
function resolveEntryPoint(): string {
    // Check if we're in src/ directory (development)
    const srcIndex = path.join(__dirname, "index.ts");
    if (existsSync(srcIndex)) {
        return srcIndex;
    }

    // Check if we're in dist/ directory (production)
    const distIndex = path.join(__dirname, "index.js");
    if (existsSync(distIndex)) {
        return distIndex;
    }

    // Fallback: try parent directories (in case wrapper is in a subdirectory)
    const parentSrcIndex = path.join(path.dirname(__dirname), "src", "index.ts");
    if (existsSync(parentSrcIndex)) {
        return parentSrcIndex;
    }

    const parentDistIndex = path.join(path.dirname(__dirname), "dist", "index.js");
    if (existsSync(parentDistIndex)) {
        return parentDistIndex;
    }

    // Last resort: assume src/index.ts relative to current directory
    // This maintains backward compatibility with existing behavior
    return srcIndex;
}

class DaemonWrapper {
    private child: ChildProcess | null = null;
    private isShuttingDown = false;

    /**
     * Start the daemon wrapper
     */
    async start(args: string[]): Promise<void> {
        console.log("[Wrapper] Starting TENEX daemon supervisor");
        console.log("[Wrapper] Daemon arguments:", args.join(" ") || "(none)");

        // Setup signal handlers
        this.setupSignalHandlers();

        // Start the daemon loop
        await this.runDaemonLoop(args);
    }

    /**
     * Setup signal handlers for the wrapper process
     */
    private setupSignalHandlers(): void {
        // Forward SIGHUP to child process
        process.on("SIGHUP", () => {
            if (this.child && this.child.pid) {
                console.log("[Wrapper] SIGHUP received - forwarding to daemon");
                this.child.kill("SIGHUP");
            }
        });

        // Handle SIGTERM/SIGINT - shutdown gracefully
        const handleTermination = (signal: string) => {
            if (this.isShuttingDown) {
                console.log(`[Wrapper] ${signal} received during shutdown - forcing exit`);
                process.exit(1);
            }

            console.log(`[Wrapper] ${signal} received - shutting down`);
            this.isShuttingDown = true;

            if (this.child && this.child.pid) {
                // Forward the signal to child
                this.child.kill(signal === "SIGTERM" ? "SIGTERM" : "SIGINT");

                // Give child some time to shutdown, then force kill
                setTimeout(() => {
                    if (this.child && this.child.pid) {
                        console.log("[Wrapper] Child still running after timeout - forcing kill");
                        this.child.kill("SIGKILL");
                    }
                    process.exit(1);
                }, 30000);
            } else {
                process.exit(0);
            }
        };

        process.on("SIGTERM", () => handleTermination("SIGTERM"));
        process.on("SIGINT", () => handleTermination("SIGINT"));
    }

    /**
     * Main daemon loop - spawn daemon and exit (daemon backgrounds itself)
     */
    private async runDaemonLoop(args: string[]): Promise<void> {
        // Spawn daemon - it will fork to background on its own
        console.log("[Wrapper] Spawning daemon...");
        this.spawnDaemon(args);

        // Wait for lockfile to appear (with timeout)
        const maxWaitMs = 10000;
        const startTime = Date.now();
        let lockfileExists = false;

        while (Date.now() - startTime < maxWaitMs) {
            lockfileExists = await this.checkLockfileExists();
            if (lockfileExists) {
                break;
            }
            await this.sleep(100);
        }

        if (lockfileExists) {
            console.log("[Wrapper] Daemon started successfully");
        } else {
            console.error("[Wrapper] Error: Daemon failed to start (no lockfile found after 10s)");
            process.exit(1);
        }

        console.log("[Wrapper] Exiting");
        process.exit(0);
    }

    /**
     * Spawn the daemon process and wait for it to exit
     */
    private spawnDaemon(args: string[]): Promise<number> {
        return new Promise((resolve) => {
            const indexPath = resolveEntryPoint();
            const daemonArgs = [indexPath, "daemon", "--supervised", ...args];

            // Use Bun when running TypeScript sources; otherwise run compiled JS via Node.
            const runtimeBinary = indexPath.endsWith(".ts")
                ? (process.env.TENEX_BUN_BIN || "bun")
                : process.execPath;

            console.log(`[Wrapper] Spawning: ${runtimeBinary} ${daemonArgs.join(" ")}`);

            this.child = spawn(runtimeBinary, daemonArgs, {
                stdio: "inherit",
                env: process.env,
            });

            this.child.on("exit", (code) => {
                this.child = null;
                resolve(code ?? 1);
            });

            this.child.on("error", (error) => {
                console.error("[Wrapper] Failed to spawn daemon:", error.message);
                this.child = null;
                resolve(1);
            });
        });
    }

    /**
     * Sleep for a given duration
     */
    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * Get the lockfile path
     */
    private getLockfilePath(): string {
        return path.join(
            process.env.HOME || process.env.USERPROFILE || "/tmp",
            ".tenex",
            "daemon",
            "tenex.lock"
        );
    }

    /**
     * Check if daemon lockfile exists
     */
    private async checkLockfileExists(): Promise<boolean> {
        try {
            await fs.stat(this.getLockfilePath());
            return true;
        } catch (error) {
            const err = error as NodeJS.ErrnoException;
            if (err.code === "ENOENT") {
                return false;
            }
            // Other error - assume it doesn't exist
            return false;
        }
    }
}

// Main entry point
const wrapper = new DaemonWrapper();

// Get arguments after wrapper.ts
// Process args are: ["bun", "wrapper.ts", ...args]
const args = process.argv.slice(2);

wrapper.start(args).catch((error) => {
    console.error("[Wrapper] Fatal error:", error);
    process.exit(1);
});
