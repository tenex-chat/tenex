import { LLMConfigEditor } from "@/llm/LLMConfigEditor";
import { runProviderSetup } from "@/llm/utils/provider-setup";
import { config } from "@/services/ConfigService";
import type { TenexConfig } from "@/services/config/types";
import { inquirerTheme } from "@/utils/cli-theme";
import * as display from "./display";
import inquirer from "inquirer";

export async function runInteractiveSetup(): Promise<TenexConfig> {
    display.welcome();

    // Load current configuration to check what's missing
    const { config: currentConfig, llms: currentLLMs } = await config.loadConfig();
    const globalPath = config.getGlobalPath();
    const needsPubkeys =
        !currentConfig.whitelistedPubkeys || currentConfig.whitelistedPubkeys.length === 0;
    const needsLLMs =
        !currentLLMs.configurations || Object.keys(currentLLMs.configurations).length === 0;

    let pubkeys = currentConfig.whitelistedPubkeys || [];

    // Step 1: Get whitelisted pubkeys if needed
    if (needsPubkeys) {
        pubkeys = await promptForPubkeys();
    }

    const tenexConfig: TenexConfig = {
        ...currentConfig,
        whitelistedPubkeys: pubkeys,
    };

    // Save basic configuration
    await config.saveGlobalConfig(tenexConfig);

    // Step 2: Providers
    if (needsLLMs) {
        display.step(1, 2, "AI Providers");
        display.context("Connect the AI services your agents will use.");
        display.blank();

        const existingProviders = await config.loadTenexProviders(globalPath);
        const updatedProviders = await runProviderSetup(existingProviders);
        await config.saveGlobalProviders(updatedProviders);
        display.success("Provider credentials saved");

        // Step 3: Models
        if (Object.keys(updatedProviders.providers).length > 0) {
            display.step(2, 2, "Models");
            display.context("Configure which models your agents will use.");
            display.blank();

            const llmEditor = new LLMConfigEditor();
            await llmEditor.showMainMenu();
        }
    }

    display.setupComplete();
    display.context(`Configuration saved to: ${config.getGlobalPath()}/`);
    display.hint("You can now run 'tenex daemon' to start the daemon with your configuration.");
    display.blank();

    return tenexConfig;
}

async function promptForPubkeys(): Promise<string[]> {
    display.step(0, 0, "Whitelist Configuration");
    display.context("Enter the Nostr pubkeys (hex format) that are allowed to control this daemon.");
    display.context("You can add multiple pubkeys, one at a time.");
    display.blank();

    const pubkeys: string[] = [];
    let addMore = true;

    while (addMore) {
        const { pubkey } = await inquirer.prompt([
            {
                type: "input",
                name: "pubkey",
                message: "Enter a pubkey (hex format):",
                theme: inquirerTheme,
                validate: (input) => {
                    if (!input.trim()) {
                        return "Pubkey cannot be empty";
                    }
                    if (!/^[a-f0-9]{64}$/i.test(input.trim())) {
                        return "Invalid pubkey format. Must be 64 hex characters";
                    }
                    return true;
                },
            },
        ]);

        pubkeys.push(pubkey.trim().toLowerCase());

        if (pubkeys.length > 0) {
            const { continueAdding } = await inquirer.prompt([
                {
                    type: "confirm",
                    name: "continueAdding",
                    message: "Add another pubkey?",
                    default: false,
                    theme: inquirerTheme,
                },
            ]);
            addMore = continueAdding;
        }
    }

    display.blank();
    display.success(`Added ${pubkeys.length} whitelisted pubkey(s)`);
    return pubkeys;
}
