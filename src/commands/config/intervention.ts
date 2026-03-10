import { config as configService } from "@/services/ConfigService";
import { inquirerTheme } from "@/utils/cli-theme";
import chalk from "chalk";
import { Command } from "commander";
import inquirer from "inquirer";

export const interventionCommand = new Command("intervention")
    .description("Configure intervention — auto-review when you're idle")
    .action(async () => {
        try {
            const globalPath = configService.getGlobalPath();
            const existingConfig = await configService.loadTenexConfig(globalPath);
            const intervention = existingConfig.intervention || {};

            console.log(`  Enabled: ${intervention.enabled ?? false}`);
            if (intervention.agent) console.log(`  Agent: ${intervention.agent}`);
            console.log(`  Review timeout: ${intervention.timeout ?? 300000}ms`);
            console.log(`  Skip if active within: ${intervention.conversationInactivityTimeoutSeconds ?? 120}s\n`);

            const { enabled } = await inquirer.prompt([{
                type: "confirm",
                name: "enabled",
                message: "Enable intervention?",
                default: intervention.enabled ?? false,
                theme: inquirerTheme,
            }]);

            if (enabled) {
                const answers = await inquirer.prompt([
                    {
                        type: "input",
                        name: "agent",
                        message: "Agent slug:",
                        default: intervention.agent || "",
                        theme: inquirerTheme,
                    },
                    {
                        type: "input",
                        name: "timeout",
                        message: "Review timeout (ms):",
                        default: String(intervention.timeout ?? 300000),
                        theme: inquirerTheme,
                        validate: (input: string) => /^\d+$/.test(input) || "Must be a number",
                    },
                    {
                        type: "input",
                        name: "skipWithin",
                        message: "Skip if active within (seconds):",
                        default: String(intervention.conversationInactivityTimeoutSeconds ?? 120),
                        theme: inquirerTheme,
                        validate: (input: string) => /^\d+$/.test(input) || "Must be a number",
                    },
                ]);

                existingConfig.intervention = {
                    enabled: true,
                    agent: answers.agent || undefined,
                    timeout: parseInt(answers.timeout),
                    conversationInactivityTimeoutSeconds: parseInt(answers.skipWithin),
                };
            } else {
                existingConfig.intervention = {
                    ...intervention,
                    enabled: false,
                };
            }

            await configService.saveGlobalConfig(existingConfig);
            console.log(chalk.green("✓") + chalk.bold(" Intervention config saved."));
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage?.includes("SIGINT") || errorMessage?.includes("force closed")) return;
            console.log(chalk.red(`❌ Failed to configure intervention: ${error}`));
            process.exitCode = 1;
        }
    });
