import { config } from "@/services/ConfigService";
import { inquirerTheme } from "@/utils/cli-theme";
import chalk from "chalk";
import { Command } from "commander";
import inquirer from "inquirer";

export const nip46Command = new Command("nip46")
    .description("Configure NIP-46 remote signing")
    .action(async () => {
        const globalPath = config.getGlobalPath();
        const tenexConfig = await config.loadTenexConfig(globalPath);
        const nip46 = tenexConfig.nip46 || {};

        const { action } = await inquirer.prompt([{
            type: "select",
            name: "action",
            message: "NIP-46 Remote Signing Settings",
            choices: [
                { name: "Enable/Disable NIP-46", value: "toggle" },
                { name: "Configure timeout and retries", value: "configure" },
                { name: "Manage owner bunker URIs", value: "owners" },
                { name: chalk.dim("Back"), value: "back" },
            ],
            theme: inquirerTheme,
        }]);

        if (action === "back") return;

        if (action === "toggle") {
            const { enabled } = await inquirer.prompt([{
                type: "confirm",
                name: "enabled",
                message: "Enable NIP-46 remote signing?",
                default: nip46.enabled ?? false,
            }]);

            tenexConfig.nip46 = { ...nip46, enabled };
            await config.saveTenexConfig(globalPath, tenexConfig);
            console.log(chalk.green(`\n✓ NIP-46 ${enabled ? "enabled" : "disabled"}`));
            return;
        }

        if (action === "configure") {
            const answers = await inquirer.prompt([
                {
                    type: "input",
                    name: "signingTimeoutMs",
                    message: "Signing timeout (ms):",
                    default: nip46.signingTimeoutMs ?? 30000,
                    validate: (value) => {
                        const num = Number.parseInt(value, 10);
                        if (Number.isNaN(num) || num <= 0) {
                            return "Please enter a positive number";
                        }
                        return true;
                    },
                },
                {
                    type: "input",
                    name: "maxRetries",
                    message: "Max retries:",
                    default: nip46.maxRetries ?? 2,
                    validate: (value) => {
                        const num = Number.parseInt(value, 10);
                        if (Number.isNaN(num) || num < 0) {
                            return "Please enter a non-negative number";
                        }
                        return true;
                    },
                },
            ]);

            tenexConfig.nip46 = {
                ...nip46,
                signingTimeoutMs: Number.parseInt(answers.signingTimeoutMs, 10),
                maxRetries: Number.parseInt(answers.maxRetries, 10),
            };

            await config.saveTenexConfig(globalPath, tenexConfig);
            console.log(chalk.green("\n✓ NIP-46 settings updated"));
            return;
        }

        if (action === "owners") {
            const owners = nip46.owners || {};
            const ownerPubkeys = Object.keys(owners);

            const { ownerAction } = await inquirer.prompt([{
                type: "select",
                name: "ownerAction",
                message: "Manage Owner Bunker URIs",
                choices: [
                    { name: "Add owner bunker URI", value: "add" },
                    ...(ownerPubkeys.length > 0 ? [{ name: "Remove owner bunker URI", value: "remove" }] : []),
                    { name: chalk.dim("Back"), value: "back" },
                ],
                theme: inquirerTheme,
            }]);

            if (ownerAction === "back") return;

            if (ownerAction === "add") {
                const answers = await inquirer.prompt([
                    {
                        type: "input",
                        name: "pubkey",
                        message: "Owner hex pubkey:",
                        validate: (value) => {
                            if (!/^[0-9a-f]{64}$/i.test(value)) {
                                return "Please enter a valid 64-character hex pubkey";
                            }
                            return true;
                        },
                    },
                    {
                        type: "input",
                        name: "bunkerUri",
                        message: "Bunker URI (bunker://pubkey?relay=wss://...):",
                        validate: (value) => {
                            if (!value.startsWith("bunker://")) {
                                return "Bunker URI must start with bunker://";
                            }
                            return true;
                        },
                    },
                ]);

                tenexConfig.nip46 = {
                    ...nip46,
                    owners: {
                        ...owners,
                        [answers.pubkey]: { bunkerUri: answers.bunkerUri },
                    },
                };

                await config.saveTenexConfig(globalPath, tenexConfig);
                console.log(chalk.green("\n✓ Owner bunker URI added"));
                return;
            }

            if (ownerAction === "remove") {
                const { pubkeyToRemove } = await inquirer.prompt([{
                    type: "select",
                    name: "pubkeyToRemove",
                    message: "Select owner to remove:",
                    choices: ownerPubkeys.map(pk => ({
                        name: `${pk.substring(0, 16)}... (${owners[pk].bunkerUri})`,
                        value: pk,
                    })),
                    theme: inquirerTheme,
                }]);

                delete owners[pubkeyToRemove];
                tenexConfig.nip46 = { ...nip46, owners };
                await config.saveTenexConfig(globalPath, tenexConfig);
                console.log(chalk.green("\n✓ Owner bunker URI removed"));
            }
        }
    });
