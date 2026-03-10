import { config as configService } from "@/services/ConfigService";
import { inquirerTheme } from "@/utils/cli-theme";
import chalk from "chalk";
import { Command } from "commander";
import inquirer from "inquirer";

const LOG_LEVELS = ["silent", "error", "warn", "info", "debug"] as const;

export const loggingCommand = new Command("logging")
    .description("Configure logging — log level and file path")
    .action(async () => {
        try {
            const globalPath = configService.getGlobalPath();
            const existingConfig = await configService.loadTenexConfig(globalPath);
            const logging = existingConfig.logging || {};

            console.log(`  Level: ${logging.level ?? "info"}`);
            console.log(`  Log file: ${logging.logFile ?? "(stdout)"}\n`);

            const { level } = await inquirer.prompt([{
                type: "select",
                name: "level",
                message: "Log level:",
                choices: LOG_LEVELS.map((l) => ({ name: l, value: l })),
                default: logging.level ?? "info",
                theme: inquirerTheme,
            }]);

            const { logFile } = await inquirer.prompt([{
                type: "input",
                name: "logFile",
                message: "Log file path (empty for stdout):",
                default: logging.logFile ?? "",
                theme: inquirerTheme,
            }]);

            existingConfig.logging = {
                level,
                logFile: logFile.trim() || undefined,
            };

            await configService.saveGlobalConfig(existingConfig);
            console.log(chalk.green("✓") + chalk.bold(" Logging config saved."));
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage?.includes("SIGINT") || errorMessage?.includes("force closed")) return;
            console.log(chalk.red(`❌ Failed to configure logging: ${error}`));
            process.exitCode = 1;
        }
    });
