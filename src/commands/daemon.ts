import * as path from "node:path";
import { getDaemon } from "@/daemon";
import { TerminalInputManager } from "@/daemon/TerminalInputManager";
import { getNDK } from "@/nostr/ndkClient";
import { config } from "@/services/ConfigService";
import { dynamicToolService } from "@/services/DynamicToolService";
import { SchedulerService } from "@/services/SchedulerService";
import { logger } from "@/utils/logger";
import { setupGracefulShutdown } from "@/utils/process";
import { runInteractiveSetup } from "@/utils/setup";
import chalk from "chalk";
import { Command } from "commander";

/**
 * Alpha mode state - when true, agents get bug reporting tools and alpha warnings
 */
let _alphaMode = false;

export function isAlphaMode(): boolean {
    return _alphaMode;
}

/**
 * Daemon command - runs all projects in a single process
 */
export const daemonCommand = new Command("daemon")
    .description("Start the TENEX daemon to manage all projects")
    .option("-w, --whitelist <pubkeys>", "Comma-separated list of whitelisted pubkeys")
    .option("-c, --config <path>", "Path to config file")
    .option("-v, --verbose", "Enable verbose logging")
    .option("-a, --alpha", "Enable alpha mode with bug reporting tools")
    .action(async (options) => {
        // Enable verbose logging if requested
        if (options.verbose) {
            process.env.LOG_LEVEL = "debug";
        }

        // Set alpha mode state
        _alphaMode = options.alpha || false;

        // Load configuration
        const { config: globalConfig, llms: globalLLMs } = await config.loadConfig(
            options.config ? path.dirname(options.config) : undefined
        );

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
        if (_alphaMode) {
            console.log(chalk.yellow("⚠️  ALPHA MODE ENABLED - Bug reporting tools active"));
        }
        console.log();

        // Initialize services that the daemon needs
        const schedulerService = SchedulerService.getInstance();
        await schedulerService.initialize(getNDK(), ".tenex");

        await dynamicToolService.initialize();

        // Get the daemon instance
        const daemon = getDaemon();

        // Initialize terminal input manager
        const terminalInputManager = new TerminalInputManager(daemon);

        // Set up graceful shutdown
        setupGracefulShutdown(async () => {
            logger.info("Shutting down daemon...");

            // Stop terminal input manager
            terminalInputManager.stop();

            // Stop the daemon
            await daemon.stop();

            // Shutdown services
            schedulerService.shutdown();
            dynamicToolService.shutdown();

            logger.info("Daemon shutdown complete");
        });

        try {
            // Start the daemon
            await daemon.start();

            console.log(chalk.green("✅ Daemon started successfully"));
            console.log(chalk.gray("   Managing all projects in a single process"));
            console.log(chalk.gray("   Press Ctrl+C to stop"));
            console.log(chalk.gray("   Press 'p' to view running projects"));
            console.log();

            // Log initial status
            const status = daemon.getStatus();
            console.log(chalk.blue("📊 Initial Status:"));
            console.log(chalk.gray(`   Known Projects: ${status.knownProjects}`));
            console.log(chalk.gray(`   Active Projects: ${status.activeProjects}`));
            console.log(chalk.gray(`   Total Agents: ${status.totalAgents}`));
            console.log();

            // Start terminal input manager
            terminalInputManager.start();

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
