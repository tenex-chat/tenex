import { logger } from "@/utils/logger";
import type { NDKProject } from "@nostr-dev-kit/ndk";
import { SpanStatusCode, context as otelContext, trace } from "@opentelemetry/api";
import { ProjectAlreadyRunningError } from "@/services/scheduling/errors";
import type { ProjectDTag } from "@/types/project-ids";
import { ProjectRuntime } from "./ProjectRuntime";

/**
 * Manages the lifecycle of project runtimes.
 * Handles starting, stopping, restarting, and crash recovery for ProjectRuntime instances.
 *
 * This class extracts runtime management logic from the Daemon class,
 * eliminating duplicate code and providing a focused responsibility.
 */
export class RuntimeLifecycle {
    private activeRuntimes = new Map<ProjectDTag, ProjectRuntime>();
    private startingRuntimes = new Map<ProjectDTag, Promise<ProjectRuntime>>();

    // Serialization queue: ensures only one project boots at a time.
    // Concurrent startup causes Bun's JSC engine to pre-allocate massive memory
    // pools (~3.5GB) that are never released. Sequential startup with GC pauses
    // between boots keeps RSS under ~300MB for the same workload.
    private bootQueue: Promise<void> = Promise.resolve();

    constructor(private projectsBase: string) {}

    /**
     * Get all active runtimes
     */
    getActiveRuntimes(): Map<ProjectDTag, ProjectRuntime> {
        return new Map(this.activeRuntimes);
    }

    /**
     * Get a specific runtime by project d-tag
     */
    getRuntime(projectId: ProjectDTag): ProjectRuntime | undefined {
        return this.activeRuntimes.get(projectId);
    }

    /**
     * Check if a runtime is active
     */
    isRuntimeActive(projectId: ProjectDTag): boolean {
        return this.activeRuntimes.has(projectId);
    }

    /**
     * Start a new runtime for a project.
     * This is the single source of truth for runtime startup logic.
     *
     * @param projectId - The project d-tag
     * @param project - The NDKProject instance
     * @returns Promise resolving to the started ProjectRuntime
     * @throws Error if startup fails
     */
    async startRuntime(projectId: ProjectDTag, project: NDKProject): Promise<ProjectRuntime> {
        // Check if already running
        const existingRuntime = this.activeRuntimes.get(projectId);
        if (existingRuntime) {
            const status = existingRuntime.getStatus();
            if (status.isRunning) {
                throw new ProjectAlreadyRunningError(projectId);
            }
            // Runtime exists but is not running - remove it and allow restart
            trace.getActiveSpan()?.addEvent("runtime_lifecycle.removing_stale", {
                "project.id": projectId,
            });
            this.activeRuntimes.delete(projectId);
        }

        // Check if already starting
        const existingPromise = this.startingRuntimes.get(projectId);
        if (existingPromise) {
            return existingPromise;
        }

        const projectTitle = project.tagValue("title") || "Untitled";
        const startupContext = otelContext.active();
        const bootEnqueuedAt = Date.now();
        trace.getActiveSpan()?.addEvent("runtime_lifecycle.starting", {
            "project.id": projectId,
            "project.title": projectTitle,
        });

        // Serialize through the boot queue to prevent concurrent startup.
        // Each boot appends to the queue chain so the next waits for the
        // previous one to finish (and its GC cooldown to reclaim transient allocs).
        let resolveRuntime!: (rt: ProjectRuntime) => void;
        let rejectRuntime!: (err: unknown) => void;
        const runtimePromise = new Promise<ProjectRuntime>((resolve, reject) => {
            resolveRuntime = resolve;
            rejectRuntime = reject;
        });
        this.startingRuntimes.set(projectId, runtimePromise);

        this.bootQueue = this.bootQueue.then(async () => {
            try {
                await otelContext.with(startupContext, async () => {
                    const tracer = trace.getTracer("tenex.runtime-lifecycle");

                    await tracer.startActiveSpan("tenex.runtime.startup", async (span) => {
                        span.setAttributes({
                            "project.id": projectId,
                            "project.title": projectTitle,
                            "runtime.boot_queue.wait_ms": Date.now() - bootEnqueuedAt,
                        });

                        try {
                            const runtime = await this.performStartup(project);
                            this.activeRuntimes.set(projectId, runtime);

                            span.addEvent("runtime_lifecycle.started", {
                                "project.id": projectId,
                                "project.title": projectTitle,
                            });
                            span.setStatus({ code: SpanStatusCode.OK });
                            resolveRuntime(runtime);
                        } catch (error) {
                            const errorMessage = error instanceof Error ? error.message : String(error);

                            logger.error(`Failed to start project runtime: ${projectId}`, {
                                error: errorMessage,
                            });
                            span.recordException(error as Error);
                            span.setStatus({
                                code: SpanStatusCode.ERROR,
                                message: errorMessage,
                            });
                            rejectRuntime(error);
                        } finally {
                            this.startingRuntimes.delete(projectId);
                            span.end();
                        }
                    });
                });
            } finally {
                // GC cooldown: reclaim transient allocations before the next boot
                // starts, preventing JSC from accumulating pre-allocated memory pools.
                const gc = (globalThis as { Bun?: { gc: (sync: boolean) => void } }).Bun?.gc;
                gc?.(true);
                await new Promise(r => setTimeout(r, 200));
                gc?.(true);
            }
        });

        return runtimePromise;
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
     * @param projectId - The project d-tag to stop
     * @throws Error if the runtime is not found
     */
    async stopRuntime(projectId: ProjectDTag): Promise<void> {
        const runtime = this.activeRuntimes.get(projectId);
        if (!runtime) {
            throw new Error(`Runtime not found: ${projectId}`);
        }

        trace.getActiveSpan()?.addEvent("runtime_lifecycle.stopping", {
            "project.id": projectId,
        });

        try {
            await runtime.stop();
            this.activeRuntimes.delete(projectId);
            trace.getActiveSpan()?.addEvent("runtime_lifecycle.stopped", {
                "project.id": projectId,
            });
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
     * @param projectId - The project d-tag to restart
     * @param project - The NDKProject instance (needed for restart)
     * @throws Error if the runtime is not found or restart fails
     */
    async restartRuntime(projectId: ProjectDTag, project: NDKProject): Promise<ProjectRuntime> {
        const runtime = this.activeRuntimes.get(projectId);
        if (!runtime) {
            throw new Error(`Runtime not found: ${projectId}`);
        }

        trace.getActiveSpan()?.addEvent("runtime_lifecycle.restarting", {
            "project.id": projectId,
        });

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
     * @param projectId - The project d-tag that crashed
     * @param runtime - The crashed runtime instance
     */
    async handleRuntimeCrash(projectId: ProjectDTag, runtime: ProjectRuntime): Promise<void> {
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
        trace.getActiveSpan()?.addEvent("runtime_lifecycle.stopping_all", {
            "runtimes.active_count": this.activeRuntimes.size,
        });

        const stopPromises = Array.from(this.activeRuntimes.entries()).map(
            async ([projectId, runtime]) => {
                try {
                    await runtime.stop();
                } catch (error) {
                    logger.error(`Error stopping runtime during shutdown: ${projectId}`, {
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        );

        await Promise.all(stopPromises);
        this.activeRuntimes.clear();

        trace.getActiveSpan()?.addEvent("runtime_lifecycle.all_stopped");
    }

    /**
     * Get statistics about managed runtimes
     */
    getStats(): {
        activeCount: number;
        startingCount: number;
        projectIds: ProjectDTag[];
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

        trace.getActiveSpan()?.addEvent("runtime_lifecycle.waiting_for_starting", {
            "runtimes.starting_count": this.startingRuntimes.size,
        });

        const promises = Array.from(this.startingRuntimes.values());
        await Promise.allSettled(promises);
    }

    /**
     * Get list of currently active project d-tags.
     * Used by graceful restart to persist which projects to auto-boot after restart.
     */
    getActiveProjectIds(): ProjectDTag[] {
        return Array.from(this.activeRuntimes.keys());
    }
}
