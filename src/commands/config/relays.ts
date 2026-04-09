import { config as configService } from "@/services/ConfigService";
import { inquirerTheme } from "@/utils/cli-theme";
import chalk from "chalk";
import { Command } from "commander";
import inquirer from "inquirer";

const DEFAULT_IDENTITY_RELAY = "wss://purplepag.es";

export const relaysCommand = new Command("relays")
    .description("Configure Nostr relay connections")
    .action(async () => {
        try {
            const globalPath = configService.getGlobalPath();
            const existingConfig = await configService.loadTenexConfig(globalPath);
            const relays = existingConfig.relays || [];
            const identityRelays = existingConfig.identityRelays || [];

            console.log(chalk.dim("\n  Relays:"));
            if (relays.length === 0) {
                console.log(chalk.dim("    No relays configured."));
            } else {
                for (const relay of relays) {
                    console.log(`    ${chalk.cyan("●")} ${relay}`);
                }
            }

            console.log(chalk.dim("\n  Identity relays (for kind:0 events):"));
            if (identityRelays.length === 0) {
                console.log(chalk.dim(`    ${DEFAULT_IDENTITY_RELAY} (default)`));
            } else {
                for (const relay of identityRelays) {
                    console.log(`    ${chalk.cyan("●")} ${relay}`);
                }
            }
            console.log();

            const { action } = await inquirer.prompt([{
                type: "select",
                name: "action",
                message: "What do you want to do?",
                choices: [
                    { name: "Add a relay", value: "add" },
                    { name: "Remove a relay", value: "remove" },
                    { name: "Add an identity relay", value: "add-identity" },
                    { name: "Remove an identity relay", value: "remove-identity" },
                    { name: "Back", value: "back" },
                ],
                theme: inquirerTheme,
            }]);

            if (action === "add") {
                const { url } = await inquirer.prompt([{
                    type: "input",
                    name: "url",
                    message: "Relay URL (ws:// or wss://):",
                    theme: inquirerTheme,
                    validate: (input: string) => {
                        const trimmed = input.trim();
                        if (!trimmed.startsWith("ws://") && !trimmed.startsWith("wss://")) {
                            return "URL must start with ws:// or wss://";
                        }
                        return true;
                    },
                }]);
                existingConfig.relays = [...relays, url.trim()];
                await configService.saveGlobalConfig(existingConfig);
                console.log(chalk.green("✓") + chalk.bold(" Relay added."));
            } else if (action === "remove") {
                if (relays.length === 0) {
                    console.log(chalk.dim("  Nothing to remove."));
                } else {
                    const { relay } = await inquirer.prompt([{
                        type: "select",
                        name: "relay",
                        message: "Remove which relay?",
                        choices: relays.map((r) => ({ name: r, value: r })),
                        theme: inquirerTheme,
                    }]);
                    existingConfig.relays = relays.filter((r) => r !== relay);
                    await configService.saveGlobalConfig(existingConfig);
                    console.log(chalk.green("✓") + chalk.bold(" Relay removed."));
                }
            } else if (action === "add-identity") {
                const { url } = await inquirer.prompt([{
                    type: "input",
                    name: "url",
                    message: "Identity relay URL (ws:// or wss://):",
                    theme: inquirerTheme,
                    validate: (input: string) => {
                        const trimmed = input.trim();
                        if (!trimmed.startsWith("ws://") && !trimmed.startsWith("wss://")) {
                            return "URL must start with ws:// or wss://";
                        }
                        return true;
                    },
                }]);
                existingConfig.identityRelays = [...identityRelays, url.trim()];
                await configService.saveGlobalConfig(existingConfig);
                console.log(chalk.green("✓") + chalk.bold(" Identity relay added."));
            } else if (action === "remove-identity") {
                if (identityRelays.length === 0) {
                    console.log(chalk.dim(`  No custom identity relays configured (using default: ${DEFAULT_IDENTITY_RELAY}).`));
                } else {
                    const { relay } = await inquirer.prompt([{
                        type: "select",
                        name: "relay",
                        message: "Remove which identity relay?",
                        choices: identityRelays.map((r) => ({ name: r, value: r })),
                        theme: inquirerTheme,
                    }]);
                    existingConfig.identityRelays = identityRelays.filter((r) => r !== relay);
                    await configService.saveGlobalConfig(existingConfig);
                    console.log(chalk.green("✓") + chalk.bold(" Identity relay removed."));
                }
            }
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage?.includes("SIGINT") || errorMessage?.includes("force closed")) return;
            console.log(chalk.red(`❌ Failed to configure relays: ${error}`));
            process.exitCode = 1;
        }
    });
