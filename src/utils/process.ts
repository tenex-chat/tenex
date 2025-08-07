import { logger } from "@/utils/logger";

/**
 * Handler function called during graceful shutdown
 */
export type ShutdownHandler = (signal: string) => Promise<void>;

/**
 * Sets up graceful shutdown handlers for various termination signals
 * @param shutdownHandler - Async function to handle cleanup during shutdown
 * @description Handles SIGTERM, SIGINT, SIGHUP signals and uncaught exceptions/rejections
 */
export function setupGracefulShutdown(shutdownHandler: ShutdownHandler): void {
    let isShuttingDown = false;

    const shutdown = async (signal: string): Promise<void> => {
        if (isShuttingDown) return;
        isShuttingDown = true;

        logger.info(`Received ${signal}, shutting down gracefully...`);

        try {
            await shutdownHandler(signal);
            logger.info("Shutdown complete");
            process.exit(0);
        } catch (error) {
            logger.error("Error during shutdown", { error });
            process.exit(1);
        }
    };

    // Handle various termination signals
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGHUP", () => shutdown("SIGHUP"));

    // Handle uncaught errors
    process.on("uncaughtException", (error) => {
        logger.error("Uncaught exception", { error });
        shutdown("uncaughtException");
    });

    process.on("unhandledRejection", (reason, promise) => {
        logger.error("Unhandled rejection", { reason, promise });
        shutdown("unhandledRejection");
    });
}
