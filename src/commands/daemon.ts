import { getDaemon } from "@/daemon";
import { getNDK } from "@/nostr/ndkClient";
import { config } from "@/services/ConfigService";
import { llmOpsRegistry } from "@/services/LLMOperationsRegistry";
import { SchedulerService } from "@/services/scheduling";
import { eventLoopMonitor } from "@/telemetry/EventLoopMonitor";
import { logger } from "@/utils/logger";
import { runInteractiveSetup } from "./setup/interactive";
import chalk from "chalk";
import { Command } from "commander";

/**
 * Daemon command - runs all projects in a single process
 */
export const daemonCommand = new Command("daemon")
    .description("Start the TENEX daemon to manage all projects")
    .option("-w, --whitelist <pubkeys>", "Comma-separated list of whitelisted pubkeys")
    .option("-c, --config <path>", "Path to config file")
    .option("-v, --verbose", "Enable verbose logging")
    .option("-b, --boot <pattern>", "Auto-boot projects whose d-tag contains this pattern (can be used multiple times)", (value: string, prev: string[]) => {
        return prev ? [...prev, value] : [value];
    }, [])
    .action(async (options) => {
        // Enable verbose logging if requested
        if (options.verbose) {
            process.env.LOG_LEVEL = "debug";
        }

        // Load configuration (MCP config will be loaded later per-project with metadataPath)
        const { config: globalConfig, llms: globalLLMs } = await config.loadConfig();

        // Initialize daemon logging
        await logger.initDaemonLogging();

        // Get whitelisted pubkeys
        let whitelistedPubkeys = config.getWhitelistedPubkeys(
            options.whitelist,
            globalConfig
        );

        // Check for required configurations
        const needsSetup =
            whitelistedPubkeys.length === 0 ||
            !globalLLMs.configurations ||
            Object.keys(globalLLMs.configurations).length === 0;

        if (needsSetup) {
            if (whitelistedPubkeys.length === 0) {
                logger.info("No whitelisted pubkeys found. Starting interactive setup...");
            }
            if (!globalLLMs.configurations || Object.keys(globalLLMs.configurations).length === 0) {
                logger.info("No LLM configurations found. Starting interactive setup...");
            }

            // Run interactive setup
            const setupConfig = await runInteractiveSetup();

            // Save the setup configuration and reload
            await config.saveGlobalConfig(setupConfig);
            whitelistedPubkeys = setupConfig.whitelistedPubkeys || [];
        }

        console.log(chalk.cyan("╔════════════════════════════════════════╗"));
        console.log(chalk.cyan("║       TENEX Daemon Starting            ║"));
        console.log(chalk.cyan("╚════════════════════════════════════════╝"));
        console.log();

        // Initialize services that the daemon needs
        const schedulerService = SchedulerService.getInstance();
        await schedulerService.initialize(getNDK(), ".tenex");

        // DIAGNOSTIC: Start event loop monitoring for concurrent streaming bottleneck analysis
        eventLoopMonitor.start(
            () => llmOpsRegistry.getActiveOperationsCount(),
            100, // Sample every 100ms
            50   // Consider >50ms lag as blocked
        );
        console.log(chalk.gray("📊 Event loop monitoring enabled for diagnostics"));

        // Get the daemon instance
        const daemon = getDaemon();

        // Set boot patterns if provided
        const bootPatterns: string[] = options.boot || [];
        if (bootPatterns.length > 0) {
            daemon.setAutoBootPatterns(bootPatterns);
            console.log(chalk.yellow(`🚀 Auto-boot patterns: ${bootPatterns.join(", ")}`));
        }

        // Register scheduler shutdown with daemon's shutdown handlers
        daemon.addShutdownHandler(async () => {
            schedulerService.shutdown();
            // Stop event loop monitor and log final stats
            const stats = eventLoopMonitor.getStats();
            logger.info("[EventLoopMonitor] Final stats on shutdown", {
                peakLagMs: stats.peakLagMs,
                avgLagMs: Math.round(stats.avgLagMs * 100) / 100,
                sampleCount: stats.sampleCount,
                blockedCount: stats.blockedCount,
                blockedPercentage: stats.sampleCount > 0
                    ? Math.round((stats.blockedCount / stats.sampleCount) * 10000) / 100
                    : 0,
            });
            eventLoopMonitor.stop();
        });

        try {
            // Start the daemon
            await daemon.start();

            console.log(chalk.green("✅ Daemon started successfully"));

            // Log initial status
            const status = daemon.getStatus();
            console.log(chalk.blue("📊 Initial Status:"));
            console.log(chalk.gray(`   Known Projects: ${status.knownProjects}`));
            console.log(chalk.gray(`   Active Projects: ${status.activeProjects}`));
            console.log(chalk.gray(`   Total Agents: ${status.totalAgents}`));
            console.log();

            // Keep the process alive
            await new Promise(() => {
                // This promise never resolves, keeping the daemon running
            });
        } catch (error) {
            logger.error("Failed to start daemon", { error });
            console.error(chalk.red("❌ Failed to start daemon:"), error);
            process.exit(1);
        }
    });
