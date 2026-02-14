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

// Configuration
const MIN_UPTIME_MS = 5000; // Minimum uptime to reset crash counter
const MAX_CRASHES = 5; // Maximum crashes before giving up
const CRASH_WINDOW_MS = 60000; // Time window for crash counting

interface CrashRecord {
    timestamp: number;
}

class DaemonWrapper {
    private child: ChildProcess | null = null;
    private crashHistory: CrashRecord[] = [];
    private startTime: number = 0;
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
     * Main daemon loop - spawn daemon and respawn on clean exit
     */
    private async runDaemonLoop(args: string[]): Promise<void> {
        while (!this.isShuttingDown) {
            // Check crash loop
            if (this.isInCrashLoop()) {
                console.error("[Wrapper] Crash loop detected - too many crashes in short period");
                console.error(`[Wrapper] ${this.crashHistory.length} crashes in last ${CRASH_WINDOW_MS / 1000}s`);
                console.error("[Wrapper] Giving up - please check daemon logs");
                process.exit(1);
            }

            // Spawn daemon
            this.startTime = Date.now();
            const exitCode = await this.spawnDaemon(args);
            const uptime = Date.now() - this.startTime;

            console.log(`[Wrapper] Daemon exited with code ${exitCode} after ${Math.round(uptime / 1000)}s`);

            if (this.isShuttingDown) {
                // Wrapper is shutting down, don't respawn
                console.log("[Wrapper] Wrapper shutting down, not respawning");
                break;
            }

            if (exitCode === 0) {
                // Clean exit - this is a graceful restart
                console.log("[Wrapper] Daemon exited cleanly - respawning for graceful restart");

                // Reset crash counter on clean exit after sufficient uptime
                if (uptime >= MIN_UPTIME_MS) {
                    this.crashHistory = [];
                }

                // Small delay to prevent tight loop in edge cases
                await this.sleep(100);
            } else {
                // Non-zero exit - this is a crash
                console.error(`[Wrapper] Daemon crashed with exit code ${exitCode}`);
                this.recordCrash();

                // Exponential backoff on crashes
                const backoffMs = Math.min(1000 * Math.pow(2, this.crashHistory.length - 1), 30000);
                console.log(`[Wrapper] Waiting ${backoffMs / 1000}s before respawn...`);
                await this.sleep(backoffMs);
            }
        }

        console.log("[Wrapper] Exiting");
        process.exit(0);
    }

    /**
     * Spawn the daemon process and wait for it to exit
     */
    private spawnDaemon(args: string[]): Promise<number> {
        return new Promise((resolve) => {
            // Build command: bun <entry-point> daemon --supervised [args]
            const indexPath = resolveEntryPoint();
            const daemonArgs = [indexPath, "daemon", "--supervised", ...args];

            console.log(`[Wrapper] Spawning: bun ${daemonArgs.join(" ")}`);

            this.child = spawn("bun", daemonArgs, {
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
     * Record a crash for crash loop detection
     */
    private recordCrash(): void {
        const now = Date.now();
        this.crashHistory.push({ timestamp: now });

        // Prune old crashes outside the window
        this.crashHistory = this.crashHistory.filter(
            (c) => now - c.timestamp < CRASH_WINDOW_MS
        );
    }

    /**
     * Check if we're in a crash loop
     */
    private isInCrashLoop(): boolean {
        const now = Date.now();
        const recentCrashes = this.crashHistory.filter(
            (c) => now - c.timestamp < CRASH_WINDOW_MS
        );
        return recentCrashes.length >= MAX_CRASHES;
    }

    /**
     * Sleep for a given duration
     */
    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
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
