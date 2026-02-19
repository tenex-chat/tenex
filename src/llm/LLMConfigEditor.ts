import { config } from "@/services/ConfigService";
import type { TenexLLMs } from "@/services/config/types";
import chalk from "chalk";
import inquirer from "inquirer";
import { llmServiceFactory } from "./LLMServiceFactory";
import { ConfigurationManager } from "./utils/ConfigurationManager";
import { ConfigurationTester } from "./utils/ConfigurationTester";
import { ProviderConfigUI } from "./utils/ProviderConfigUI";
import { runProviderSetup } from "./utils/provider-setup";

/**
 * Internal type used by editor to work with providers
 * Merges providers with llms for internal convenience
 */
type LLMConfigWithProviders = TenexLLMs & {
    providers: Record<string, { apiKey: string }>;
};

/**
 * LLM Configuration Editor - Simple menu orchestrator
 * Note: LLM configs are now global only (no project-level llms.json)
 */
export class LLMConfigEditor {
    constructor() {}

    async showMainMenu(): Promise<void> {
        const llmsConfig = await this.loadConfig();

        console.log(chalk.cyan("\n=== LLM Configuration ===\n"));
        ProviderConfigUI.displayCurrentConfig(llmsConfig);

        const { action } = await inquirer.prompt([
            {
                type: "select",
                name: "action",
                message: "What would you like to do?",
                choices: [
                    { name: "Add new configuration", value: "add" },
                    { name: "Create meta model", value: "addMeta" },
                    { name: "Delete configuration", value: "delete" },
                    {
                        name: `Default agents' model: ${llmsConfig.default || "none"}`,
                        value: "default",
                    },
                    {
                        name: `Summarization model: ${llmsConfig.summarization || "none"}`,
                        value: "summarization",
                    },
                    {
                        name: `Supervision model: ${llmsConfig.supervision || "none"}`,
                        value: "supervision",
                    },
                    {
                        name: `Search model: ${llmsConfig.search || "none"}`,
                        value: "search",
                    },
                    {
                        name: `Prompt compilation model: ${llmsConfig.promptCompilation || "none"}`,
                        value: "promptCompilation",
                    },
                    {
                        name: `Compression model: ${llmsConfig.compression || "none"}`,
                        value: "compression",
                    },
                    { name: "Test configuration", value: "test" },
                    { name: "Exit", value: "exit" },
                ],
            },
        ]);

        if (action === "exit") process.exit(0);

        if (action === "test") {
            await ConfigurationTester.test(llmsConfig);
        } else {
            // All other actions use ConfigurationManager
            if (action === "add") await ConfigurationManager.add(llmsConfig);
            if (action === "addMeta") await ConfigurationManager.addMetaModel(llmsConfig);
            if (action === "delete") await ConfigurationManager.delete(llmsConfig);
            if (action === "default") await ConfigurationManager.setDefault(llmsConfig);
            if (action === "summarization") await ConfigurationManager.setSummarizationModel(llmsConfig);
            if (action === "supervision") await ConfigurationManager.setSupervisionModel(llmsConfig);
            if (action === "search") await ConfigurationManager.setSearchModel(llmsConfig);
            if (action === "promptCompilation") await ConfigurationManager.setPromptCompilationModel(llmsConfig);
            if (action === "compression") await ConfigurationManager.setCompressionModel(llmsConfig);
            await this.saveConfig(llmsConfig);
        }

        await this.showMainMenu();
    }

    async runOnboardingFlow(): Promise<void> {
        console.log(chalk.green("\n🚀 Welcome to TENEX LLM Setup!\n"));

        const llmsConfig = await this.loadConfig();
        const globalPath = config.getGlobalPath();

        // Step 1: Configure providers
        console.log(chalk.cyan("Step 1: Configure Provider API Keys"));
        const existingProviders = await config.loadTenexProviders(globalPath);
        const updatedProviders = await runProviderSetup(existingProviders);
        llmsConfig.providers = updatedProviders.providers;
        await this.saveConfig(llmsConfig);

        // Step 2: Create first configuration
        console.log(chalk.cyan("\nStep 2: Create Your First Configuration"));
        await ConfigurationManager.add(llmsConfig, true);
        await this.saveConfig(llmsConfig);

        // Step 3: Offer to test
        const { shouldTest } = await inquirer.prompt([
            {
                type: "confirm",
                name: "shouldTest",
                message: "Would you like to test your configuration?",
                default: true,
            },
        ]);

        if (shouldTest) {
            await ConfigurationTester.test(llmsConfig);
        }

        console.log(chalk.green("\n✅ LLM configuration complete!"));
    }

    private async loadConfig(): Promise<LLMConfigWithProviders> {
        const globalPath = config.getGlobalPath();

        // Load providers and llms separately
        const providersConfig = await config.loadTenexProviders(globalPath);
        const llmsConfig = await config.loadTenexLLMs(globalPath);

        // Merge for internal editor use
        return {
            ...llmsConfig,
            providers: providersConfig.providers,
        };
    }

    private async saveConfig(llmsConfig: LLMConfigWithProviders): Promise<void> {
        // Split providers and llms for separate storage
        const { providers, ...llmsWithoutProviders } = llmsConfig;

        // Save providers to providers.json
        await config.saveGlobalProviders({ providers });

        // Save llms to llms.json
        await config.saveGlobalLLMs(llmsWithoutProviders as TenexLLMs);

        // Re-initialize factory with updated providers
        await llmServiceFactory.initializeProviders(providers);
    }
}
