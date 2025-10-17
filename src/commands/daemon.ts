import * as path from "node:path";
import { getUnifiedDaemon } from "@/daemon/unified";
import { configService, dynamicToolService } from "@/services";
import { logger } from "@/utils/logger";
import { setupGracefulShutdown } from "@/utils/process";
import { runInteractiveSetup } from "@/utils/setup";
import { Command } from "commander";
import { SchedulerService } from "@/services/SchedulerService";
import { getNDK } from "@/nostr/ndkClient";
import chalk from "chalk";

/**
 * Unified daemon command - runs all projects in a single process
 */
export const daemonCommand = new Command("daemon")
  .description("Start the unified TENEX daemon to manage all projects")
  .option("-w, --whitelist <pubkeys>", "Comma-separated list of whitelisted pubkeys")
  .option("-c, --config <path>", "Path to config file")
  .option("-v, --verbose", "Enable verbose logging")
  .option("--legacy", "Use legacy multi-process daemon (deprecated)")
  .action(async (options) => {
    // If legacy flag is set, warn the user
    if (options.legacy) {
      console.log(chalk.yellow("⚠️  Legacy multi-process daemon is deprecated."));
      console.log(chalk.yellow("   Please migrate to the unified daemon."));
      console.log();
      // You could keep the old implementation here if needed for transition
      process.exit(1);
    }

    // Enable verbose logging if requested
    if (options.verbose) {
      process.env.LOG_LEVEL = "debug";
    }

    // Load configuration
    const { config: globalConfig, llms: globalLLMs } = await configService.loadConfig(
      options.config ? path.dirname(options.config) : undefined
    );

    // Get whitelisted pubkeys
    let whitelistedPubkeys = configService.getWhitelistedPubkeys(options.whitelist, globalConfig);

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
      await configService.saveGlobalConfig(setupConfig);
      whitelistedPubkeys = setupConfig.whitelistedPubkeys || [];
    }

    console.log(chalk.cyan("╔════════════════════════════════════════╗"));
    console.log(chalk.cyan("║     TENEX Unified Daemon Starting      ║"));
    console.log(chalk.cyan("╚════════════════════════════════════════╝"));
    console.log();

    // Initialize services that the unified daemon needs
    const schedulerService = SchedulerService.getInstance();
    await schedulerService.initialize(getNDK(), ".tenex");

    await dynamicToolService.initialize();

    // Get the unified daemon instance
    const daemon = getUnifiedDaemon();

    // Set up graceful shutdown
    setupGracefulShutdown(async () => {
      logger.info("Shutting down unified daemon...");

      // Stop the unified daemon
      await daemon.stop();

      // Shutdown services
      schedulerService.shutdown();
      dynamicToolService.shutdown();

      logger.info("Unified daemon shutdown complete");
    });

    try {
      // Start the unified daemon
      await daemon.start();

      console.log(chalk.green("✅ Unified daemon started successfully"));
      console.log(chalk.gray("   Managing all projects in a single process"));
      console.log(chalk.gray("   Press Ctrl+C to stop"));
      console.log();

      // Log initial status
      const status = daemon.getStatus();
      console.log(chalk.blue("📊 Initial Status:"));
      console.log(chalk.gray(`   Known Projects: ${status.knownProjects}`));
      console.log(chalk.gray(`   Active Projects: ${status.activeProjects}`));
      console.log(chalk.gray(`   Total Agents: ${status.agents}`));
      console.log(chalk.gray(`   Memory: ${Math.round(status.memory.heapUsed / 1024 / 1024)} MB`));
      console.log();

      logger.info("TENEX unified daemon is running. Press Ctrl+C to stop.");

      // Keep the process alive
      await new Promise(() => {
        // This promise never resolves, keeping the daemon running
      });
    } catch (error) {
      logger.error("Failed to start unified daemon", { error });
      console.error(chalk.red("❌ Failed to start daemon:"), error);
      process.exit(1);
    }
  });
