import { config } from "@/services/ConfigService";
import { inquirerTheme } from "@/utils/cli-theme";
import chalk from "chalk";
import { Command } from "commander";
import inquirer from "inquirer";

export const apnsCommand = new Command("apns")
    .description("Configure Apple Push Notification Service")
    .action(async () => {
        const globalPath = config.getGlobalPath();
        const tenexConfig = await config.loadTenexConfig(globalPath);
        const apns = tenexConfig.apns || {};

        const { action } = await inquirer.prompt([{
            type: "select",
            name: "action",
            message: "APNs Settings",
            choices: [
                { name: "Configure APNs", value: "configure" },
                { name: "Disable APNs", value: "disable" },
                { name: chalk.dim("Back"), value: "back" },
            ],
            theme: inquirerTheme,
        }]);

        if (action === "back") return;

        if (action === "disable") {
            tenexConfig.apns = { ...apns, enabled: false };
            await config.saveTenexConfig(globalPath, tenexConfig);
            console.log(chalk.green("\n✓ APNs disabled"));
            return;
        }

        const answers = await inquirer.prompt([
            {
                type: "confirm",
                name: "enabled",
                message: "Enable APNs?",
                default: apns.enabled ?? false,
            },
            {
                type: "input",
                name: "keyPath",
                message: "Path to .p8 key file:",
                default: apns.keyPath ?? "",
                when: (answers) => answers.enabled,
            },
            {
                type: "input",
                name: "keyId",
                message: "Apple Key ID:",
                default: apns.keyId ?? "",
                when: (answers) => answers.enabled,
            },
            {
                type: "input",
                name: "teamId",
                message: "Apple Team ID:",
                default: apns.teamId ?? "",
                when: (answers) => answers.enabled,
            },
            {
                type: "input",
                name: "bundleId",
                message: "App Bundle ID (e.g., com.example.tenex):",
                default: apns.bundleId ?? "",
                when: (answers) => answers.enabled,
            },
            {
                type: "confirm",
                name: "production",
                message: "Use production environment?",
                default: apns.production ?? false,
                when: (answers) => answers.enabled,
            },
        ]);

        tenexConfig.apns = {
            enabled: answers.enabled,
            ...(answers.enabled && {
                keyPath: answers.keyPath || undefined,
                keyId: answers.keyId || undefined,
                teamId: answers.teamId || undefined,
                bundleId: answers.bundleId || undefined,
                production: answers.production,
            }),
        };

        await config.saveTenexConfig(globalPath, tenexConfig);
        console.log(chalk.green("\n✓ APNs settings updated"));
    });
