import * as fileSystem from "@/lib/fs";
import { LLMConfigEditor } from "@/llm/LLMConfigEditor";
import { ensureCacheLoaded } from "@/llm/utils/models-dev-cache";
import { config } from "@/services/ConfigService";
import { amber } from "@/utils/cli-theme";
import chalk from "chalk";
import { Command } from "commander";

export const llmCommand = new Command("llm")
    .description("Manage LLM configurations (global only)")
    .option("--advanced", "Show advanced options (temperature, max tokens)")
    .action(async (opts) => {
        try {
            // Preload models.dev cache in background so model lists are ready
            ensureCacheLoaded().catch(() => {});

            // LLM configuration is global only
            const globalConfigDir = config.getGlobalPath();

            // Ensure global config directory exists
            await fileSystem.ensureDirectory(globalConfigDir);

            const providersConfig = await config.loadTenexProviders(globalConfigDir);
            if (Object.keys(providersConfig.providers).length === 0) {
                console.log(chalk.red("❌ No providers configured."));
                console.log(amber("→") + chalk.bold(" Run tenex setup providers first"));
                process.exitCode = 1;
                return;
            }

            const llmManager = new LLMConfigEditor({ advanced: opts.advanced });
            await llmManager.showMainMenu();
        } catch (error: unknown) {
            // Handle SIGINT (Ctrl+C) gracefully - just exit without error
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage?.includes("SIGINT") || errorMessage?.includes("force closed")) {
                return;
            }
            // Only show error for actual problems
            console.log(chalk.red(`❌ Failed to start LLM configuration: ${error}`));
            process.exitCode = 1;
        }
    });
