import { config as configService } from "@/services/ConfigService";
import { inquirerTheme } from "@/utils/cli-theme";
import chalk from "chalk";
import { Command } from "commander";
import inquirer from "inquirer";

export const telemetryCommand = new Command("telemetry")
    .description("Configure OpenTelemetry tracing")
    .action(async () => {
        try {
            const globalPath = configService.getGlobalPath();
            const existingConfig = await configService.loadTenexConfig(globalPath);
            const telemetry = existingConfig.telemetry || {};

            console.log(`  Enabled: ${telemetry.enabled ?? true}`);
            console.log(`  Service name: ${telemetry.serviceName ?? "tenex-daemon"}`);
            console.log(`  Endpoint: ${telemetry.endpoint ?? "http://localhost:4318/v1/traces"}\n`);

            const { enabled } = await inquirer.prompt([{
                type: "confirm",
                name: "enabled",
                message: "Enable telemetry?",
                default: telemetry.enabled ?? true,
                theme: inquirerTheme,
            }]);

            existingConfig.telemetry = {
                ...telemetry,
                enabled,
            };

            await configService.saveGlobalConfig(existingConfig);
            console.log(chalk.green("✓") + chalk.bold(" Telemetry config saved."));
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage?.includes("SIGINT") || errorMessage?.includes("force closed")) return;
            console.log(chalk.red(`❌ Failed to configure telemetry: ${error}`));
            process.exitCode = 1;
        }
    });
