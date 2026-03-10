import * as fileSystem from "@/lib/fs";
import { runProviderSetup } from "@/llm/utils/provider-setup";
import { config } from "@/services/ConfigService";
import chalk from "chalk";
import { Command } from "commander";

export const providersCommand = new Command("providers")
    .description("Configure global provider credentials")
    .action(async () => {
        try {
            const globalPath = config.getGlobalPath();
            await fileSystem.ensureDirectory(globalPath);

            const existingProviders = await config.loadTenexProviders(globalPath);
            const updatedProviders = await runProviderSetup(existingProviders);

            await config.saveGlobalProviders(updatedProviders);
            console.log(chalk.green("✓") + chalk.bold(` Provider credentials saved to ${globalPath}/providers.json`));
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage?.includes("SIGINT") || errorMessage?.includes("force closed")) {
                return;
            }
            console.log(chalk.red(`❌ Failed to configure providers: ${error}`));
            process.exitCode = 1;
        }
    });
