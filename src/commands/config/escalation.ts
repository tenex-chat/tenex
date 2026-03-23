import { config as configService } from "@/services/ConfigService";
import { inquirerTheme } from "@/utils/cli-theme";
import chalk from "chalk";
import { Command } from "commander";
import inquirer from "inquirer";

export const escalationCommand = new Command("escalation")
    .description("Configure agent escalation — route ask() calls through an agent first")
    .action(async () => {
        try {
            const globalPath = configService.getGlobalPath();
            const existingConfig = await configService.loadTenexConfig(globalPath);

            const current = existingConfig.escalation?.agent || "not configured";
            console.log(`  Current escalation agent: ${chalk.dim(current)}\n`);

            const { agent } = await inquirer.prompt([{
                type: "input",
                name: "agent",
                message: "Agent slug (empty to disable):",
                default: existingConfig.escalation?.agent || "",
                theme: inquirerTheme,
            }]);

            if (agent.trim() === "") {
                existingConfig.escalation = undefined;
            } else {
                existingConfig.escalation = { agent: agent.trim() };
            }

            await configService.saveGlobalConfig(existingConfig);
            console.log(chalk.green("✓") + chalk.bold(" Escalation config saved."));
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage?.includes("SIGINT") || errorMessage?.includes("force closed")) return;
            console.log(chalk.red(`❌ Failed to configure escalation: ${error}`));
            process.exitCode = 1;
        }
    });
