import { config } from "@/services/ConfigService";
import chalk from "chalk";
import { Command } from "commander";
import inquirer from "inquirer";
import * as path from "node:path";
import { homedir } from "node:os";

export const pathsCommand = new Command("paths")
    .description("Configure file paths and storage")
    .action(async () => {
        const globalPath = config.getGlobalPath();
        const tenexConfig = await config.loadTenexConfig(globalPath);

        const defaultProjectsBase = path.join(homedir(), "tenex");
        const defaultBlossomServer = "https://blossom.primal.net";
        const defaultBackendName = "tenex backend";

        const answers = await inquirer.prompt([
            {
                type: "input",
                name: "backendName",
                message: "TENEX backend profile name:",
                default: tenexConfig.backendName ?? defaultBackendName,
            },
            {
                type: "input",
                name: "projectsBase",
                message: "Projects base directory:",
                default: tenexConfig.projectsBase ?? defaultProjectsBase,
            },
            {
                type: "input",
                name: "blossomServerUrl",
                message: "Blossom server URL for blob uploads:",
                default: tenexConfig.blossomServerUrl ?? defaultBlossomServer,
                validate: (value) => {
                    if (!value.startsWith("http://") && !value.startsWith("https://")) {
                        return "Please enter a valid HTTP(S) URL";
                    }
                    return true;
                },
            },
        ]);

        tenexConfig.backendName = answers.backendName || undefined;
        tenexConfig.projectsBase = answers.projectsBase || undefined;
        tenexConfig.blossomServerUrl = answers.blossomServerUrl || undefined;

        await config.saveTenexConfig(globalPath, tenexConfig);
        console.log(chalk.green("\n✓ Path settings updated"));
    });
