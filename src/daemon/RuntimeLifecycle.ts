import { logger } from "@/utils/logger";
import type { NDKProject } from "@nostr-dev-kit/ndk";
import chalk from "chalk";
import { ProjectRuntime } from "./ProjectRuntime";

/**
 * Manages the lifecycle of project runtimes.
 * Handles starting, stopping, restarting, and crash recovery for ProjectRuntime instances.
 *
 * This class extracts runtime management logic from the Daemon class,
 * eliminating duplicate code and providing a focused responsibility.
 */
export class RuntimeLifecycle {
    private activeRuntimes = new Map<string, ProjectRuntime>();
    private startingRuntimes = new Map<string, Promise<ProjectRuntime>>();

    constructor(private projectsBase: string) {}

    /**
     * Get all active runtimes
     */
    getActiveRuntimes(): Map<string, ProjectRuntime> {
        return new Map(this.activeRuntimes);
    }

    /**
     * Get a specific runtime by project ID
     */
    getRuntime(projectId: string): ProjectRuntime | undefined {
        return this.activeRuntimes.get(projectId);
    }

    /**
     * Check if a runtime is active
     */
    isRuntimeActive(projectId: string): boolean {
        return this.activeRuntimes.has(projectId);
    }

    /**
     * Start or get an existing runtime for a project.
     * This method prevents duplicate startups by tracking promises.
     *
     * @param projectId - The project ID (format: "31933:authorPubkey:dTag")
     * @param project - The NDKProject instance
     * @returns Promise resolving to the started ProjectRuntime
     */
    async getOrStartRuntime(projectId: string, project: NDKProject): Promise<ProjectRuntime> {
        // Check if already active
        const existingRuntime = this.activeRuntimes.get(projectId);
        if (existingRuntime) {
            logger.debug(`Using existing runtime for project ${projectId}`);
            return existingRuntime;
        }

        // Check if currently being started (prevent duplicate startups)
        const startingPromise = this.startingRuntimes.get(projectId);
        if (startingPromise) {
            logger.debug(`Waiting for in-progress startup for project ${projectId}`);
            return startingPromise;
        }

        // Start new runtime
        return this.startRuntime(projectId, project);
    }

    /**
     * Start a new runtime for a project.
     * This is the single source of truth for runtime startup logic.
     *
     * @param projectId - The project ID
     * @param project - The NDKProject instance
     * @returns Promise resolving to the started ProjectRuntime
     * @throws Error if startup fails
     */
    async startRuntime(projectId: string, project: NDKProject): Promise<ProjectRuntime> {
        // Check if already running
        if (this.activeRuntimes.has(projectId)) {
            throw new Error(`Runtime already running: ${projectId}`);
        }

        // Check if already starting
        const existingPromise = this.startingRuntimes.get(projectId);
        if (existingPromise) {
            return existingPromise;
        }

        const projectTitle = project.tagValue("title") || "Untitled";
        logger.info(`Starting project runtime: ${projectId}`, {
            title: projectTitle,
        });

        // Create startup promise to prevent concurrent startups
        const startupPromise = this.performStartup(project);
        this.startingRuntimes.set(projectId, startupPromise);

        try {
            const runtime = await startupPromise;
            this.activeRuntimes.set(projectId, runtime);

            logger.info(`Project runtime started successfully: ${projectId}`, {
                title: projectTitle,
            });

            return runtime;
        } catch (error) {
            logger.error(`Failed to start project runtime: ${projectId}`, {
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        } finally {
            // Always clean up the starting promise
            this.startingRuntimes.delete(projectId);
        }
    }

    /**
     * Perform the actual runtime startup
     * @param project - The NDKProject instance
     * @returns Promise resolving to the started ProjectRuntime
     */
    private async performStartup(project: NDKProject): Promise<ProjectRuntime> {
        const newRuntime = new ProjectRuntime(project, this.projectsBase);
        await newRuntime.start();
        return newRuntime;
    }

    /**
     * Stop a runtime gracefully
     * @param projectId - The project ID to stop
     * @throws Error if the runtime is not found
     */
    async stopRuntime(projectId: string): Promise<void> {
        const runtime = this.activeRuntimes.get(projectId);
        if (!runtime) {
            throw new Error(`Runtime not found: ${projectId}`);
        }

        logger.info(`Stopping project runtime: ${projectId}`);

        try {
            await runtime.stop();
            this.activeRuntimes.delete(projectId);
            logger.info(`Project runtime stopped: ${projectId}`);
        } catch (error) {
            logger.error(`Error stopping project runtime: ${projectId}`, {
                error: error instanceof Error ? error.message : String(error),
            });
            // Still remove from active runtimes even if stop fails
            this.activeRuntimes.delete(projectId);
            throw error;
        }
    }

    /**
     * Restart a runtime (stop and start again)
     * @param projectId - The project ID to restart
     * @param project - The NDKProject instance (needed for restart)
     * @throws Error if the runtime is not found or restart fails
     */
    async restartRuntime(projectId: string, project: NDKProject): Promise<ProjectRuntime> {
        const runtime = this.activeRuntimes.get(projectId);
        if (!runtime) {
            throw new Error(`Runtime not found: ${projectId}`);
        }

        logger.info(`Restarting project runtime: ${projectId}`);

        try {
            // Stop the runtime
            await runtime.stop();
            this.activeRuntimes.delete(projectId);

            // Start it again
            return await this.startRuntime(projectId, project);
        } catch (error) {
            logger.error(`Failed to restart project runtime: ${projectId}`, {
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }

    /**
     * Handle a crashed runtime by cleaning it up
     * @param projectId - The project ID that crashed
     * @param runtime - The crashed runtime instance
     */
    async handleRuntimeCrash(projectId: string, runtime: ProjectRuntime): Promise<void> {
        logger.error(`Handling crashed runtime: ${projectId}`);

        // Remove from active runtimes
        this.activeRuntimes.delete(projectId);

        // Best effort cleanup
        try {
            await runtime.stop();
        } catch (cleanupError) {
            logger.warn(`Failed to clean up crashed runtime: ${projectId}`, {
                error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
            });
        }
    }

    /**
     * Stop all active runtimes (for shutdown)
     */
    async stopAllRuntimes(): Promise<void> {
        logger.info(`Stopping all runtimes (${this.activeRuntimes.size} active)`);

        const stopPromises = Array.from(this.activeRuntimes.entries()).map(
            async ([projectId, runtime]) => {
                try {
                    await runtime.stop();
                    logger.debug(`Stopped runtime: ${projectId}`);
                } catch (error) {
                    logger.error(`Error stopping runtime during shutdown: ${projectId}`, {
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        );

        await Promise.all(stopPromises);
        this.activeRuntimes.clear();

        logger.info("All runtimes stopped");
    }

    /**
     * Get statistics about managed runtimes
     */
    getStats(): {
        activeCount: number;
        startingCount: number;
        projectIds: string[];
    } {
        return {
            activeCount: this.activeRuntimes.size,
            startingCount: this.startingRuntimes.size,
            projectIds: Array.from(this.activeRuntimes.keys()),
        };
    }

    /**
     * Check if any runtimes are currently starting
     */
    hasStartingRuntimes(): boolean {
        return this.startingRuntimes.size > 0;
    }

    /**
     * Wait for all starting runtimes to complete
     * Useful for graceful shutdown
     */
    async waitForStartingRuntimes(): Promise<void> {
        if (this.startingRuntimes.size === 0) {
            return;
        }

        logger.info(`Waiting for ${this.startingRuntimes.size} starting runtime(s) to complete`);

        const promises = Array.from(this.startingRuntimes.values());
        await Promise.allSettled(promises);
    }
}