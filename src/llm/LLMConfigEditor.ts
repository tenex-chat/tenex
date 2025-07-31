import os from "node:os";
import path from "node:path";
import type { LLMConfig, LLMProvider } from "@/llm/types";
import { configService } from "@/services";
import type { TenexLLMs } from "@/services/config/types";
import { logger } from "@/utils/logger";
import search from "@inquirer/search";
import chalk from "chalk";
import inquirer from "inquirer";
import type { ModelsList } from "multi-llm-ts";
import { Message, igniteEngine } from "multi-llm-ts";
import { LLM_DEFAULTS } from "./constants";
import { getAllModels, getModelsForProvider } from "./models";

type LLMConfigWithName = LLMConfig & {
    name: string;
};

async function selectModelWithSearch(provider: string, models: string[]): Promise<string> {
    const formattedModels = models.map((model) => ({
        name: model,
        value: model,
    }));

    return search({
        message: `Select ${provider} model:`,
        source: async (input) => {
            if (!input) {
                return formattedModels;
            }

            const filtered = formattedModels.filter((model) =>
                model.name.toLowerCase().includes(input.toLowerCase())
            );

            return filtered.length > 0 ? filtered : formattedModels;
        },
    });
}

async function selectOpenRouterModelWithPricing(
    models: string[]
): Promise<{ model: string; supportsCaching: boolean }> {
    const formatModelChoice = (model: string) => {
        return {
            name: model,
            value: model,
            short: model,
        };
    };

    const formattedModels = models.map(formatModelChoice);

    const model = await search({
        message: "Select OpenRouter model (📦 = supports caching):",
        source: async (input) => {
            if (!input) {
                return formattedModels;
            }

            const filtered = formattedModels.filter((model) =>
                model.value.toLowerCase().includes(input.toLowerCase())
            );

            return filtered.length > 0 ? filtered : formattedModels;
        },
    });

    return {
        model,
        supportsCaching: false, // We don't have this info from multi-llm-ts
    };
}

export class LLMConfigEditor {
    private configPath: string;
    private isGlobal: boolean;

    constructor(configPath: string, isGlobal = true) {
        this.configPath = configPath;
        this.isGlobal = isGlobal;
    }

    async showMainMenu(): Promise<void> {
        const llmsConfig = await this.loadConfig();
        const configs = this.getConfigList(llmsConfig);

        logger.info(
            chalk.cyan(`\n🤖 LLM Configuration Manager (${this.isGlobal ? "global" : "project"})\n`)
        );

        if (configs.length > 0) {
            logger.info(chalk.green("Current configurations:"));
            configs.forEach((config, index) => {
                const isDefault = llmsConfig.defaults?.[LLM_DEFAULTS.AGENTS] === config.name;
                const defaultIndicator = isDefault ? chalk.yellow(" (default)") : "";
                logger.info(`  ${index + 1}. ${chalk.bold(config.name)}${defaultIndicator}`);
                const llmConfig = llmsConfig.configurations[config.name];
                if (llmConfig) {
                    logger.info(`     ${llmConfig.provider} - ${llmConfig.model}`);
                }
            });
            logger.info("");
        }

        const currentAgentDefault = llmsConfig.defaults?.[LLM_DEFAULTS.AGENTS] || "none";
        const currentAnalyzeDefault = llmsConfig.defaults?.[LLM_DEFAULTS.ANALYZE] || "none";
        const currentOrchestratorDefault =
            llmsConfig.defaults?.[LLM_DEFAULTS.ORCHESTRATOR] || "none";

        const { action } = await inquirer.prompt([
            {
                type: "list",
                name: "action",
                message: "What would you like to do?",
                choices: [
                    { name: "Add new LLM configuration", value: "add" },
                    ...(configs.length > 0
                        ? [
                              { name: "Test existing configuration", value: "test" },
                              { name: "Edit existing configuration", value: "edit" },
                              { name: "Remove configuration", value: "remove" },
                              {
                                  name: `Set agent's default [${currentAgentDefault}]`,
                                  value: "default-agents",
                              },
                              {
                                  name: `Set analyze tool's default [${currentAnalyzeDefault}]`,
                                  value: "default-analyze",
                              },
                              {
                                  name: `Set orchestrator's default [${currentOrchestratorDefault}]`,
                                  value: "default-orchestrator",
                              },
                          ]
                        : []),
                    { name: "Exit", value: "exit" },
                ],
            },
        ]);

        switch (action) {
            case "add":
                await this.addConfiguration(llmsConfig);
                break;
            case "test":
                await this.testExistingConfiguration(llmsConfig);
                break;
            case "edit":
                await this.editConfiguration(llmsConfig);
                break;
            case "remove":
                await this.removeConfiguration(llmsConfig);
                break;
            case "default-agents":
                await this.setDefaultConfiguration(llmsConfig, LLM_DEFAULTS.AGENTS);
                break;
            case "default-analyze":
                await this.setDefaultConfiguration(llmsConfig, LLM_DEFAULTS.ANALYZE);
                break;
            case "default-orchestrator":
                await this.setDefaultConfiguration(llmsConfig, LLM_DEFAULTS.ORCHESTRATOR);
                break;
            case "exit":
                logger.info(chalk.green("\n✅ Configuration saved!"));
                return;
        }

        // Show menu again after action
        await this.showMainMenu();
    }

    async runOnboardingFlow(): Promise<void> {
        logger.info(chalk.cyan("\n🤖 LLM Configuration Setup\n"));

        let hasAddedConfig = false;

        while (true) {
            const llmsConfig = await this.loadConfig();
            const configs = this.getConfigList(llmsConfig);

            if (configs.length > 0) {
                logger.info(chalk.green("Current configurations:"));
                configs.forEach((config, index) => {
                    const isDefault = llmsConfig.defaults?.[LLM_DEFAULTS.AGENTS] === config.name;
                    const defaultIndicator = isDefault ? chalk.yellow(" (default)") : "";
                    logger.info(`  ${index + 1}. ${chalk.bold(config.name)}${defaultIndicator}`);
                    const llmConfig = llmsConfig.configurations[config.name];
                    if (llmConfig) {
                        logger.info(`     ${llmConfig.provider} - ${llmConfig.model}`);
                    }
                });
                logger.info("");
            }

            const currentAgentDefault = llmsConfig.defaults?.[LLM_DEFAULTS.AGENTS] || "none";
            const currentAnalyzeDefault = llmsConfig.defaults?.[LLM_DEFAULTS.ANALYZE] || "none";
            const currentOrchestratorDefault =
                llmsConfig.defaults?.[LLM_DEFAULTS.ORCHESTRATOR] || "none";

            const choices = [
                { name: "Add new LLM configuration", value: "add" },
                ...(configs.length > 0
                    ? [
                          { name: "Edit existing configuration", value: "edit" },
                          { name: "Remove configuration", value: "remove" },
                          {
                              name: `Agent's default: [${currentAgentDefault}]`,
                              value: "default-agents",
                          },
                          {
                              name: `Analyze tool's default: [${currentAnalyzeDefault}]`,
                              value: "default-analyze",
                          },
                          {
                              name: `Orchestrator's default: [${currentOrchestratorDefault}]`,
                              value: "default-orchestrator",
                          },
                      ]
                    : []),
            ];

            if (hasAddedConfig) {
                choices.push({ name: "Continue with setup", value: "continue" });
            }

            const { action } = await inquirer.prompt([
                {
                    type: "list",
                    name: "action",
                    message: "What would you like to do?",
                    choices,
                },
            ]);

            switch (action) {
                case "add":
                    await this.addConfiguration(llmsConfig);
                    hasAddedConfig = true;
                    break;
                case "edit":
                    await this.editConfiguration(llmsConfig);
                    break;
                case "remove":
                    await this.removeConfiguration(llmsConfig);
                    break;
                case "default-agents":
                    await this.setDefaultConfiguration(llmsConfig, LLM_DEFAULTS.AGENTS);
                    break;
                case "default-analyze":
                    await this.setDefaultConfiguration(llmsConfig, LLM_DEFAULTS.ANALYZE);
                    break;
                case "default-orchestrator":
                    await this.setDefaultConfiguration(llmsConfig, LLM_DEFAULTS.ORCHESTRATOR);
                    break;
                case "continue":
                    logger.info(chalk.green("\n✅ LLM configuration complete!"));
                    return;
            }
        }
    }

    private async loadConfig(): Promise<TenexLLMs> {
        try {
            let llms: TenexLLMs;
            if (this.isGlobal) {
                llms = await configService.loadTenexLLMs(path.join(os.homedir(), ".tenex"));
            } else {
                const config = await configService.loadConfig(this.configPath);
                llms = config.llms;
            }
            // Ensure defaults exists
            if (!llms.defaults) {
                llms.defaults = {};
            }
            return llms;
        } catch (error) {
            logger.error(`Failed to load LLM configuration: ${error}`);
            return {
                configurations: {},
                defaults: {},
                credentials: {},
            };
        }
    }

    private async saveConfig(config: TenexLLMs): Promise<void> {
        if (this.isGlobal) {
            await configService.saveGlobalLLMs(config);
        } else {
            await configService.saveProjectLLMs(this.configPath, config);
        }
    }

    private getConfigList(llmsConfig: TenexLLMs): LLMConfigWithName[] {
        const configs: LLMConfigWithName[] = [];

        for (const [key, value] of Object.entries(llmsConfig.configurations)) {
            const config: LLMConfigWithName = {
                name: key,
                provider: value.provider,
                model: value.model,
                temperature: value.temperature,
                maxTokens: value.maxTokens,
                enableCaching: value.enableCaching,
            };
            configs.push(config);
        }

        return configs;
    }

    private getExistingApiKeys(llmsConfig: TenexLLMs, provider: LLMProvider): string[] {
        const keys = new Set<string>();

        // Check auth for API keys
        if (llmsConfig.credentials?.[provider]?.apiKey) {
            const apiKey = llmsConfig.credentials[provider]?.apiKey;
            if (apiKey) {
                keys.add(apiKey);
            }
        }

        return Array.from(keys);
    }

    private async addConfiguration(llmsConfig: TenexLLMs): Promise<void> {
        logger.info(chalk.cyan("\n➕ Add New LLM Configuration\n"));

        const { provider } = await inquirer.prompt([
            {
                type: "list",
                name: "provider",
                message: "Select LLM provider:",
                choices: [
                    { name: "Anthropic", value: "anthropic" as LLMProvider },
                    { name: "OpenAI", value: "openai" as LLMProvider },
                    { name: "OpenRouter", value: "openrouter" as LLMProvider },
                    { name: "Google", value: "google" as LLMProvider },
                    { name: "Groq", value: "groq" as LLMProvider },
                    { name: "Deepseek", value: "deepseek" as LLMProvider },
                    { name: "Ollama", value: "ollama" as LLMProvider },
                    { name: "Mistral", value: "mistral" as LLMProvider },
                ],
            },
        ]);

        let availableModels: string[] = [];
        let model: string;
        let supportsCaching = false;

        // Get API key if available for fetching models
        const existingApiKey =
            provider !== "ollama" ? this.getExistingApiKeys(llmsConfig, provider)[0] : undefined;

        // Fetch models dynamically based on provider
        logger.info(chalk.cyan(`🔍 Fetching available ${provider} models...`));

        try {
            const modelsList = await getModelsForProvider(provider, existingApiKey);
            if (!modelsList || modelsList.chat.length === 0) {
                logger.error(chalk.red(`❌ No models available for ${provider}`));
                if (provider === "ollama") {
                    logger.info(chalk.yellow("💡 Make sure Ollama is running with: ollama serve"));
                }
                return;
            }

            availableModels = modelsList.chat.map((m) => (typeof m === "string" ? m : m.id));
            logger.info(chalk.green(`✅ Found ${availableModels.length} ${provider} models`));

            if (provider === "openrouter") {
                const selection = await selectOpenRouterModelWithPricing(availableModels);
                model = selection.model;
                supportsCaching = selection.supportsCaching;
            } else {
                model = await selectModelWithSearch(provider, availableModels);
            }
        } catch (error) {
            logger.error(chalk.red(`❌ Failed to fetch ${provider} models: ${error}`));
            return;
        }

        let apiKey = "";
        if (provider !== "ollama") {
            const existingKeys = this.getExistingApiKeys(llmsConfig, provider);

            if (existingKeys.length > 0) {
                const { keyChoice } = await inquirer.prompt([
                    {
                        type: "list",
                        name: "keyChoice",
                        message: "API Key:",
                        choices: [
                            ...existingKeys.map((key) => ({
                                name: `Reuse existing key: ${key.substring(0, 10)}...`,
                                value: key,
                            })),
                            { name: "Enter new API key", value: "new" },
                        ],
                    },
                ]);

                if (keyChoice === "new") {
                    const { newKey } = await inquirer.prompt([
                        {
                            type: "password",
                            name: "newKey",
                            message: "Enter API key:",
                            mask: "*",
                        },
                    ]);
                    apiKey = newKey;
                } else {
                    apiKey = keyChoice;
                }
            } else {
                const { newKey } = await inquirer.prompt([
                    {
                        type: "password",
                        name: "newKey",
                        message: "Enter API key:",
                        mask: "*",
                    },
                ]);
                apiKey = newKey;
            }
        }

        // Default configuration name based on provider and model
        const defaultConfigName = `${provider}-${model}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");

        // Handle caching based on provider
        const cachingPrompts = [];
        if (
            (provider === "anthropic" && model.includes("claude")) ||
            (provider === "openrouter" && supportsCaching)
        ) {
            cachingPrompts.push({
                type: "confirm",
                name: "enableCaching",
                message: "Enable prompt caching? (reduces costs for repeated context)",
                default: true,
            });
        }

        const prompts: Array<Record<string, unknown>> = [
            {
                type: "input",
                name: "configName",
                message: "Configuration name:",
                default: defaultConfigName,
                validate: (input: string) => {
                    if (!input.trim()) return "Configuration name is required";
                    if (llmsConfig.configurations[input])
                        return `Configuration "${input}" already exists`;
                    return true;
                },
            },
            ...cachingPrompts,
            {
                type: "confirm",
                name: "setAsDefault",
                message: "Set as default configuration?",
                default: Object.keys(llmsConfig.configurations).length === 0,
            },
        ];

        // Type assertion needed due to inquirer's complex prompt type system
        const responses = await inquirer.prompt(
            prompts as unknown as Parameters<typeof inquirer.prompt>[0]
        );

        const configName = responses.configName as string;
        const enableCaching =
            "enableCaching" in responses ? (responses.enableCaching as boolean) : supportsCaching;
        const setAsDefault = responses.setAsDefault as boolean;

        const newConfig: LLMConfig = {
            provider,
            model,
            enableCaching,
        };

        // Add apiKey for testing (if provided)
        if (apiKey?.trim()) {
            newConfig.apiKey = apiKey;
        }

        // Add baseUrl for openrouter
        if (provider === "openrouter") {
            newConfig.baseUrl = "https://openrouter.ai/api/v1";
        }

        // Test the configuration BEFORE saving it
        logger.info(chalk.cyan("\n🧪 Testing configuration before saving..."));

        // Create a temporary llmsConfig with the new credentials for testing
        const testLlmsConfig = JSON.parse(JSON.stringify(llmsConfig)); // Deep copy
        if (apiKey && provider !== "ollama") {
            if (!testLlmsConfig.credentials) {
                testLlmsConfig.credentials = {};
            }
            testLlmsConfig.credentials[provider] = {
                apiKey,
                baseUrl: provider === "openrouter" ? "https://openrouter.ai/api/v1" : undefined,
            };
        }

        // Test the configuration
        logger.info(chalk.cyan(`🧪 Testing ${configName} configuration...`));
        const testSuccessful = await this.testLLMConfig(newConfig);

        if (testSuccessful) {
            logger.info(chalk.green("✅ LLM configuration test successful!"));
        } else {
            logger.error(chalk.red("❌ LLM configuration test failed"));
        }

        if (!testSuccessful) {
            const { retry } = await inquirer.prompt([
                {
                    type: "confirm",
                    name: "retry",
                    message: "Test failed. Would you like to try again with different settings?",
                    default: true,
                },
            ]);

            if (retry) {
                logger.info(chalk.yellow("\n🔄 Let's try again..."));
                await this.addConfiguration(llmsConfig);
                return;
            }
            logger.info(chalk.red("\n❌ Configuration not saved due to test failure."));
            return;
        }

        // Only save if test passes
        llmsConfig.configurations[configName] = newConfig;

        if (setAsDefault) {
            if (!llmsConfig.defaults) {
                llmsConfig.defaults = {};
            }
            llmsConfig.defaults[LLM_DEFAULTS.AGENTS] = configName;
        }

        // If this is global config and a new API key was entered, save it to credentials
        if (this.isGlobal && apiKey && provider !== "ollama") {
            if (!llmsConfig.credentials) {
                llmsConfig.credentials = {};
            }
            llmsConfig.credentials[provider] = {
                apiKey,
                baseUrl: provider === "openrouter" ? "https://openrouter.ai/api/v1" : undefined,
            };

            // Remove API key from individual config in global mode
            // API key is stored in auth, not on config
        }

        await this.saveConfig(llmsConfig);
        logger.info(
            chalk.green(`\n✅ Configuration "${configName}" added and tested successfully!`)
        );
    }

    private async editConfiguration(llmsConfig: TenexLLMs): Promise<void> {
        const configs = this.getConfigList(llmsConfig);

        const { configName } = await inquirer.prompt([
            {
                type: "list",
                name: "configName",
                message: "Select configuration to edit:",
                choices: configs.map((c) => c.name),
            },
        ]);

        const config = llmsConfig.configurations[configName];
        if (!config) {
            logger.error(chalk.red(`Configuration ${configName} not found`));
            return;
        }
        logger.info(chalk.cyan(`\n✏️ Editing Configuration: ${configName}\n`));

        const { field } = await inquirer.prompt([
            {
                type: "list",
                name: "field",
                message: "What would you like to edit?",
                choices: [
                    { name: "Model", value: "model" },
                    { name: "API Key", value: "apiKey" },
                    { name: "Enable Caching", value: "enableCaching" },
                    { name: "Configuration Name", value: "name" },
                ],
            },
        ]);

        switch (field) {
            case "model": {
                let availableModels: string[] = [];
                let newModel: string;
                let newSupportsCaching = false;

                // Get API key if available for fetching models
                const existingApiKey =
                    config.provider !== "ollama"
                        ? llmsConfig.credentials[config.provider]?.apiKey
                        : undefined;

                // Fetch models dynamically based on provider
                logger.info(chalk.cyan(`🔍 Fetching available ${config.provider} models...`));

                try {
                    const modelsList = await getModelsForProvider(
                        config.provider as LLMProvider,
                        existingApiKey
                    );
                    if (!modelsList || modelsList.chat.length === 0) {
                        logger.error(chalk.red(`❌ No models available for ${config.provider}`));
                        if (config.provider === "ollama") {
                            logger.info(
                                chalk.yellow("💡 Make sure Ollama is running with: ollama serve")
                            );
                        }
                        return;
                    }

                    availableModels = modelsList.chat.map((m) =>
                        typeof m === "string" ? m : m.id
                    );
                    logger.info(
                        chalk.green(`✅ Found ${availableModels.length} ${config.provider} models`)
                    );

                    if (config.provider === "openrouter") {
                        const selection = await selectOpenRouterModelWithPricing(availableModels);
                        newModel = selection.model;
                        newSupportsCaching = selection.supportsCaching;
                    } else {
                        newModel = await selectModelWithSearch(config.provider, availableModels);
                    }
                } catch (error) {
                    logger.error(
                        chalk.red(`❌ Failed to fetch ${config.provider} models: ${error}`)
                    );
                    return;
                }

                config.model = newModel;
                if (config.provider === "openrouter") {
                    config.enableCaching = newSupportsCaching;
                }
                break;
            }
            case "apiKey": {
                if (config.provider !== "ollama") {
                    const { apiKey } = await inquirer.prompt([
                        {
                            type: "password",
                            name: "apiKey",
                            message: "Enter new API key:",
                            mask: "*",
                        },
                    ]);
                    // API key is stored in auth, not on config
                }
                break;
            }
            case "enableCaching": {
                const { enableCaching } = await inquirer.prompt([
                    {
                        type: "confirm",
                        name: "enableCaching",
                        message: "Enable prompt caching?",
                        default: config.enableCaching,
                    },
                ]);
                config.enableCaching = enableCaching;
                break;
            }
            case "name": {
                const { newName } = await inquirer.prompt([
                    {
                        type: "input",
                        name: "newName",
                        message: "Enter new configuration name:",
                        default: configName,
                        validate: (input: string) => {
                            if (!input.trim()) return "Configuration name is required";
                            if (input !== configName && llmsConfig.configurations[input])
                                return `Configuration "${input}" already exists`;
                            return true;
                        },
                    },
                ]);

                if (newName !== configName) {
                    llmsConfig.configurations[newName] = config;
                    delete llmsConfig.configurations[configName];

                    // Update defaults if needed
                    if (llmsConfig.defaults) {
                        for (const [key, value] of Object.entries(llmsConfig.defaults)) {
                            if (value === configName) {
                                llmsConfig.defaults[key] = newName;
                            }
                        }
                    }
                }
                break;
            }
        }

        await this.saveConfig(llmsConfig);
        logger.info(chalk.green("\n✅ Configuration updated successfully!"));
    }

    private async removeConfiguration(llmsConfig: TenexLLMs): Promise<void> {
        const configs = this.getConfigList(llmsConfig);

        const { configName } = await inquirer.prompt([
            {
                type: "list",
                name: "configName",
                message: "Select configuration to remove:",
                choices: configs.map((c) => c.name),
            },
        ]);

        const { confirm } = await inquirer.prompt([
            {
                type: "confirm",
                name: "confirm",
                message: `Are you sure you want to remove "${configName}"?`,
                default: false,
            },
        ]);

        if (confirm) {
            delete llmsConfig.configurations[configName];

            // Update defaults if needed
            if (llmsConfig.defaults) {
                for (const [key, value] of Object.entries(llmsConfig.defaults)) {
                    if (value === configName) {
                        delete llmsConfig.defaults[key];
                    }
                }
            }

            await this.saveConfig(llmsConfig);
            logger.info(chalk.green(`\n✅ Configuration "${configName}" removed!`));
        }
    }

    private async setDefaultConfiguration(
        llmsConfig: TenexLLMs,
        defaultType: string
    ): Promise<void> {
        const configs = this.getConfigList(llmsConfig);
        const currentDefault = llmsConfig.defaults?.[defaultType] || "none";
        const typeLabel =
            defaultType === LLM_DEFAULTS.AGENTS
                ? "agent"
                : defaultType === LLM_DEFAULTS.ANALYZE
                  ? "analyze tool"
                  : "orchestrator";

        logger.info(chalk.cyan(`\n⚙️  Set Default Configuration for ${typeLabel}`));
        logger.info(chalk.gray(`Current default: ${currentDefault}\n`));

        const { configName } = await inquirer.prompt([
            {
                type: "list",
                name: "configName",
                message: `Select configuration to set as ${typeLabel} default:`,
                choices: configs.map((c) => ({
                    name: c.name === currentDefault ? `${c.name} (current)` : c.name,
                    value: c.name,
                })),
            },
        ]);

        if (!llmsConfig.defaults) {
            llmsConfig.defaults = {};
        }
        llmsConfig.defaults[defaultType] = configName;
        await this.saveConfig(llmsConfig);
        logger.info(chalk.green(`\n✅ Configuration "${configName}" set as ${typeLabel} default!`));
    }

    private async testExistingConfiguration(llmsConfig: TenexLLMs): Promise<void> {
        const configs = this.getConfigList(llmsConfig);

        const { configName } = await inquirer.prompt([
            {
                type: "list",
                name: "configName",
                message: "Select configuration to test:",
                choices: configs.map((c) => c.name),
            },
        ]);

        const config = llmsConfig.configurations[configName];
        if (!config) {
            logger.error(chalk.red(`Configuration ${configName} not found`));
            return;
        }
        logger.info(chalk.cyan(`🧪 Testing ${configName} configuration...`));
        const success = await this.testLLMConfig(config as LLMConfig);

        if (success) {
            logger.info(chalk.green("✅ LLM configuration test successful!"));
        } else {
            logger.error(chalk.red("❌ LLM configuration test failed"));
        }
    }

    /**
     * Test an LLM configuration by sending a test message
     */
    private async testLLMConfig(config: LLMConfig): Promise<boolean> {
        try {
            const llmConfig = {
                apiKey: config.apiKey,
                baseURL: config.baseUrl,
            };

            // Use the multi-llm-ts v4.0 API
            const llm = igniteEngine(config.provider, llmConfig);
            const models = await getModelsForProvider(
                config.provider as LLMProvider,
                config.apiKey
            );

            if (!models || !models.chat || models.chat.length === 0) {
                throw new Error(`No models available for provider ${config.provider}`);
            }

            // Find the specific model - handle both string and ChatModel types
            const model =
                models.chat.find((m) => {
                    const modelId = typeof m === "string" ? m : m.id;
                    return modelId === config.model;
                }) || models.chat[0];
            if (!model) {
                throw new Error(`Model ${config.model} not found for provider ${config.provider}`);
            }

            const testMessage = new Message(
                "user",
                "Say 'Configuration test successful!' and nothing else."
            );
            const response = await llm.complete(model, [testMessage]);

            return (response.content || "").toLowerCase().includes("configuration test successful");
        } catch (error) {
            logger.error("LLM test failed:", error);
            return false;
        }
    }
}
