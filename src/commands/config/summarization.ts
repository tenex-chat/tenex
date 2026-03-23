import { config as configService } from "@/services/ConfigService";
import { inquirerTheme } from "@/utils/cli-theme";
import chalk from "chalk";
import { Command } from "commander";
import inquirer from "inquirer";

export const summarizationCommand = new Command("summarization")
    .description("Configure auto-summary timing")
    .action(async () => {
        try {
            const globalPath = configService.getGlobalPath();
            const existingConfig = await configService.loadTenexConfig(globalPath);
            const summ = existingConfig.summarization || {};
            const currentTimeout = summ.inactivityTimeout ?? 300000;

            console.log(`  Inactivity timeout: ${currentTimeout}ms (${Math.round(currentTimeout / 60000)}min)\n`);

            const { timeout } = await inquirer.prompt([{
                type: "input",
                name: "timeout",
                message: "Inactivity timeout (ms):",
                default: String(currentTimeout),
                theme: inquirerTheme,
                validate: (input: string) => /^\d+$/.test(input) || "Must be a number",
            }]);

            existingConfig.summarization = {
                inactivityTimeout: Number.parseInt(timeout),
            };

            await configService.saveGlobalConfig(existingConfig);
            console.log(chalk.green("✓") + chalk.bold(" Summarization config saved."));
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage?.includes("SIGINT") || errorMessage?.includes("force closed")) return;
            console.log(chalk.red(`❌ Failed to configure summarization: ${error}`));
            process.exitCode = 1;
        }
    });
