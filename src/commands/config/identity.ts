import { config as configService } from "@/services/ConfigService";
import { inquirerTheme } from "@/utils/cli-theme";
import chalk from "chalk";
import { Command } from "commander";
import inquirer from "inquirer";

export const identityCommand = new Command("identity")
    .description("Configure authorized pubkeys")
    .action(async () => {
        try {
            const globalPath = configService.getGlobalPath();
            const existingConfig = await configService.loadTenexConfig(globalPath);
            const pubkeys = existingConfig.whitelistedPubkeys || [];

            if (pubkeys.length === 0) {
                console.log(chalk.dim("  No authorized pubkeys.\n"));
            } else {
                console.log("  Authorized pubkeys:");
                for (const pk of pubkeys) {
                    console.log(`    ${pk}`);
                }
                console.log();
            }

            const { action } = await inquirer.prompt([{
                type: "select",
                name: "action",
                message: "What do you want to do?",
                choices: [
                    { name: "Add a pubkey", value: "add" },
                    { name: "Remove a pubkey", value: "remove" },
                    { name: "Back", value: "back" },
                ],
                theme: inquirerTheme,
            }]);

            if (action === "add") {
                const { pubkey } = await inquirer.prompt([{
                    type: "input",
                    name: "pubkey",
                    message: "Pubkey (hex or npub):",
                    theme: inquirerTheme,
                    validate: (input: string) => input.trim().length > 0 || "Pubkey cannot be empty",
                }]);
                existingConfig.whitelistedPubkeys = [...pubkeys, pubkey.trim()];
                await configService.saveGlobalConfig(existingConfig);
                console.log(chalk.green("✓") + chalk.bold(" Pubkey added."));
            } else if (action === "remove") {
                if (pubkeys.length === 0) {
                    console.log(chalk.dim("  Nothing to remove."));
                } else {
                    const { pubkey } = await inquirer.prompt([{
                        type: "select",
                        name: "pubkey",
                        message: "Remove which pubkey?",
                        choices: pubkeys.map((pk) => ({ name: pk, value: pk })),
                        theme: inquirerTheme,
                    }]);
                    existingConfig.whitelistedPubkeys = pubkeys.filter((pk) => pk !== pubkey);
                    await configService.saveGlobalConfig(existingConfig);
                    console.log(chalk.green("✓") + chalk.bold(" Pubkey removed."));
                }
            }
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage?.includes("SIGINT") || errorMessage?.includes("force closed")) return;
            console.log(chalk.red(`❌ Failed to configure identity: ${error}`));
            process.exitCode = 1;
        }
    });
