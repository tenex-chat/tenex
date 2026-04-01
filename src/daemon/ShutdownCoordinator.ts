import { logger } from "@/utils/logger";
import { getConversationSpanManager } from "@/telemetry/ConversationSpanManager";
import { shutdownTelemetry } from "@/telemetry/setup";
import { getConversationIndexingJob } from "@/conversations/search/embeddings";
import { RAGService } from "@/services/rag/RAGService";
import { InterventionService } from "@/services/intervention";
import { OwnerAgentListService } from "@/services/OwnerAgentListService";
import { Nip46SigningService } from "@/services/nip46";
import { RALRegistry } from "@/services/ral/RALRegistry";
import { prefixKVStore } from "@/services/storage";
import type { Lockfile } from "@/utils/lockfile";
import type { AgentDefinitionMonitor } from "@/services/AgentDefinitionMonitor";
import type { InstalledAgentListService } from "@/services/status/InstalledAgentListService";
import type { RuntimeLifecycle } from "./RuntimeLifecycle";
import type { SubscriptionManager } from "./SubscriptionManager";
import type { RestartState } from "./RestartState";

export interface ShutdownCoordinatorDeps {
    getIsRunning: () => boolean;
    setIsRunning: (running: boolean) => void;
    getRestartState: () => RestartState | null;
    getRuntimeLifecycle: () => RuntimeLifecycle | null;
    getAgentDefinitionMonitor: () => AgentDefinitionMonitor | null;
    setAgentDefinitionMonitor: (monitor: AgentDefinitionMonitor | null) => void;
    getInstalledAgentListPublisher: () => InstalledAgentListService | null;
    setInstalledAgentListPublisher: (publisher: InstalledAgentListService | null) => void;
    getSubscriptionManager: () => SubscriptionManager | null;
    getShutdownHandlers: () => Array<() => Promise<void>>;
    getLockfile: () => Lockfile | null;
    getSupervisedMode: () => boolean;
    getPendingRestart: () => boolean;
    setPendingRestart: (pending: boolean) => void;
    getRestartInProgress: () => boolean;
    setRestartInProgress: (inProgress: boolean) => void;
}

/**
 * Manages daemon lifecycle — shutdown signals, restart state, graceful drain.
 *
 * Responsibilities:
 * - setupShutdownHandlers: register SIGTERM/SIGINT/SIGHUP handlers
 * - setupRALCompletionListener: deferred-restart trigger for supervised mode
 * - triggerGracefulRestart: persist booted projects, then exit cleanly
 * - shutdown: full teardown sequence
 */
export class ShutdownCoordinator {
    private shutdownFn:
        | ((exitCode?: number, isGracefulRestart?: boolean) => Promise<void>)
        | null = null;

    constructor(private readonly deps: ShutdownCoordinatorDeps) {}

    /**
     * Setup graceful shutdown handlers (SIGTERM, SIGINT, SIGHUP, uncaughtException, unhandledRejection).
     * Must be called after all daemon services are initialized.
     */
    setupShutdownHandlers(): void {
        // Prevent EPIPE from crashing the daemon when stdout/stderr pipe breaks
        process.stdout.on("error", (err) => {
            if ((err as NodeJS.ErrnoException).code === "EPIPE") return;
            throw err;
        });
        process.stderr.on("error", (err) => {
            if ((err as NodeJS.ErrnoException).code === "EPIPE") return;
            throw err;
        });

        const shutdown = async (exitCode = 0, isGracefulRestart = false): Promise<void> => {
            if (isGracefulRestart) {
                console.log("\n[Daemon] Triggering graceful restart...");
            } else {
                console.log("\nShutting down gracefully...");
            }

            if (!this.deps.getIsRunning()) {
                process.exit(exitCode);
            }

            this.deps.setIsRunning(false);

            try {
                // Persist booted projects for auto-boot on restart (only for graceful restart)
                const runtimeLifecycle = this.deps.getRuntimeLifecycle();
                const restartState = this.deps.getRestartState();
                if (isGracefulRestart && restartState && runtimeLifecycle) {
                    const bootedProjects = runtimeLifecycle.getActiveProjectIds();
                    await restartState.save(bootedProjects);
                    console.log(`[Daemon] Saved ${bootedProjects.length} booted project(s) for restart`);
                }

                // Stop conversation indexing job
                logger.info("Stopping conversation indexing job...");
                getConversationIndexingJob().stop();

                // Close RAG service (stops maintenance timer)
                logger.info("Closing RAG service...");
                await RAGService.closeInstance();

                // Stop agent definition monitor
                const agentDefinitionMonitor = this.deps.getAgentDefinitionMonitor();
                if (agentDefinitionMonitor) {
                    logger.info("Stopping agent definition monitor...");
                    agentDefinitionMonitor.stop();
                    this.deps.setAgentDefinitionMonitor(null);
                }

                // Stop intervention service
                logger.info("Stopping intervention service...");
                InterventionService.getInstance().shutdown();

                // Stop owner agent list service
                logger.info("Stopping owner agent list service...");
                OwnerAgentListService.getInstance().shutdown();

                const installedAgentListPublisher = this.deps.getInstalledAgentListPublisher();
                if (installedAgentListPublisher) {
                    logger.info("Stopping installed-agent inventory publisher...");
                    installedAgentListPublisher.stopPublishing();
                    this.deps.setInstalledAgentListPublisher(null);
                }

                // Stop NIP-46 signing service
                logger.info("Stopping NIP-46 signing service...");
                await Nip46SigningService.getInstance().shutdown();

                const subscriptionManager = this.deps.getSubscriptionManager();
                if (subscriptionManager) {
                    logger.info("Stopping subscriptions...");
                    subscriptionManager.stop();
                }

                if (runtimeLifecycle) {
                    const stats = runtimeLifecycle.getStats();
                    if (stats.activeCount > 0) {
                        logger.info(`Stopping ${stats.activeCount} project runtime(s)...`);
                    }
                    await runtimeLifecycle.stopAllRuntimes();
                }

                // Close the global prefix KV store (after all runtimes are stopped)
                logger.info("Closing storage...");
                await prefixKVStore.forceClose();

                const shutdownHandlers = this.deps.getShutdownHandlers();
                if (shutdownHandlers.length > 0) {
                    logger.info("Running shutdown handlers...");
                    for (const handler of shutdownHandlers) {
                        await handler();
                    }
                }

                const lockfile = this.deps.getLockfile();
                if (lockfile) {
                    await lockfile.release();
                }

                logger.info("Flushing telemetry...");
                const conversationSpanManager = getConversationSpanManager();
                conversationSpanManager.shutdown();
                await shutdownTelemetry();

                if (isGracefulRestart) {
                    logger.info("[Daemon] Graceful restart complete - exiting with code 0");
                } else {
                    logger.info("Shutdown complete.");
                }
                process.exit(exitCode);
            } catch (error) {
                logger.error("Error during shutdown", { error });
                process.exit(1);
            }
        };

        // Store shutdown function for use by triggerGracefulRestart
        this.shutdownFn = shutdown;

        // SIGHUP handler - deferred restart in supervised mode, immediate shutdown otherwise
        const handleSighup = async (): Promise<void> => {
            if (this.deps.getSupervisedMode()) {
                // Ignore duplicate SIGHUP if restart is already pending or in progress
                if (this.deps.getPendingRestart() || this.deps.getRestartInProgress()) {
                    logger.info("[Daemon] SIGHUP received but restart already pending/in progress, ignoring");
                    console.log("Restart already pending, ignoring duplicate SIGHUP");
                    return;
                }

                this.deps.setPendingRestart(true);
                const activeRalCount = RALRegistry.getInstance().getTotalActiveCount();

                console.log("\n[Daemon] SIGHUP received - initiating deferred restart");
                logger.info("[Daemon] SIGHUP received - initiating deferred restart", {
                    activeRalCount,
                });

                // If no active RALs, trigger restart immediately
                if (activeRalCount === 0) {
                    console.log("[Daemon] No active RALs, triggering immediate graceful restart");
                    await this.triggerGracefulRestart();
                } else {
                    console.log(`[Daemon] Waiting for ${activeRalCount} active RAL(s) to complete before restart...`);
                    // The RAL completion listener will trigger restart when count hits 0
                }
            } else {
                // Non-supervised mode: immediate shutdown
                shutdown();
            }
        };

        process.on("SIGTERM", () => shutdown());
        process.on("SIGINT", () => shutdown());
        process.on("SIGHUP", () => handleSighup());

        // Handle uncaught exceptions - exit with code 1 to trigger crash counter
        process.on("uncaughtException", (error) => {
            logger.error("Uncaught exception", {
                error: error.message,
                stack: error.stack,
            });
            shutdown(1);
        });

        process.on("unhandledRejection", (reason, promise) => {
            logger.error("Unhandled rejection", {
                reason: String(reason),
                promise: String(promise),
            });
            // Don't shutdown - most unhandled rejections are not critical
        });
    }

    /**
     * Setup listener for RAL completion events to trigger deferred restart.
     * Called when supervised mode is enabled.
     */
    setupRALCompletionListener(): void {
        const ralRegistry = RALRegistry.getInstance();

        ralRegistry.on("updated", (_projectId: string, _conversationId: string) => {
            if (!this.deps.getPendingRestart()) {
                return;
            }

            const activeRalCount = ralRegistry.getTotalActiveCount();
            logger.debug("[Daemon] RAL update received during pending restart", {
                activeRalCount,
            });

            if (activeRalCount === 0) {
                console.log("[Daemon] All RALs completed, triggering graceful restart");
                this.triggerGracefulRestart().catch((error) => {
                    logger.error("[Daemon] Failed to trigger graceful restart", {
                        error: error instanceof Error ? error.message : String(error),
                    });
                    process.exit(1);
                });
            }
        });

        logger.debug("[Daemon] RAL completion listener registered for supervised mode");
    }

    /**
     * Trigger graceful restart: persist state and exit cleanly.
     * The wrapper process will respawn the daemon.
     */
    async triggerGracefulRestart(): Promise<void> {
        if (this.deps.getRestartInProgress()) {
            logger.debug("[Daemon] Graceful restart already in progress, ignoring duplicate trigger");
            return;
        }
        this.deps.setRestartInProgress(true);

        if (this.shutdownFn) {
            await this.shutdownFn(0, true);
        } else {
            logger.error("[Daemon] Shutdown function not initialized, exiting with code 0");
            process.exit(0);
        }
    }
}
