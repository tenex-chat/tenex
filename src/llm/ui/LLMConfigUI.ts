import type {
    ApiKeyResult,
    ConfigurationPrompts,
    LLMConfigWithName,
    LLMProvider,
} from "@/llm/types";
import type { TenexLLMs } from "@/services/config/types";
import { logger } from "@/utils/logger";
import chalk from "chalk";
import inquirer from "inquirer";
import { LLM_DEFAULTS } from "../constants";

export type { LLMConfigWithName };

export class LLMConfigUI {
    constructor(private isGlobal: boolean) {}

    displayCurrentConfigurations(configs: LLMConfigWithName[], llmsConfig: TenexLLMs): void {
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
    }

    async promptMainMenuAction(configs: LLMConfigWithName[], llmsConfig: TenexLLMs): Promise<string> {
        const currentAgentDefault = llmsConfig.defaults?.[LLM_DEFAULTS.AGENTS] || "none";
        const currentAnalyzeDefault = llmsConfig.defaults?.[LLM_DEFAULTS.ANALYZE] || "none";
        const currentOrchestratorDefault = llmsConfig.defaults?.[LLM_DEFAULTS.ORCHESTRATOR] || "none";

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
        return action;
    }

    async promptOnboardingAction(
        configs: LLMConfigWithName[], 
        llmsConfig: TenexLLMs, 
        hasAddedConfig: boolean
    ): Promise<string> {
        const currentAgentDefault = llmsConfig.defaults?.[LLM_DEFAULTS.AGENTS] || "none";
        const currentAnalyzeDefault = llmsConfig.defaults?.[LLM_DEFAULTS.ANALYZE] || "none";
        const currentOrchestratorDefault = llmsConfig.defaults?.[LLM_DEFAULTS.ORCHESTRATOR] || "none";

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

        return action;
    }

    async promptProviderSelection(): Promise<LLMProvider> {
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
        return provider;
    }

    async promptApiKey(existingKeys: string[], provider: LLMProvider): Promise<ApiKeyResult> {
        if (provider === "ollama") {
            return { apiKey: "", isNew: false };
        }

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
                return { apiKey: newKey, isNew: true };
            } else {
                return { apiKey: keyChoice, isNew: false };
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
            return { apiKey: newKey, isNew: true };
        }
    }

    async promptConfigurationSettings(
        defaultConfigName: string,
        existingConfigs: Record<string, unknown>,
        supportsCaching: boolean,
        provider: LLMProvider,
        model: string
    ): Promise<ConfigurationPrompts> {
        const basePrompts = [
            {
                type: "input",
                name: "configName",
                message: "Configuration name:",
                default: defaultConfigName,
                validate: (input: string) => {
                    if (!input.trim()) return "Configuration name is required";
                    if (existingConfigs[input])
                        return `Configuration "${input}" already exists`;
                    return true;
                },
            },
            {
                type: "confirm",
                name: "setAsDefault",
                message: "Set as default configuration?",
                default: Object.keys(existingConfigs).length === 0,
            },
        ];

        // Add caching prompt conditionally
        if (
            (provider === "anthropic" && model.includes("claude")) ||
            (provider === "openrouter" && supportsCaching)
        ) {
            basePrompts.splice(1, 0, {
                type: "confirm",
                name: "enableCaching",
                message: "Enable prompt caching? (reduces costs for repeated context)",
                default: true,
            });
        }

        const responses = await inquirer.prompt<{
            configName: string;
            enableCaching?: boolean;
            setAsDefault: boolean;
        }>(basePrompts);

        return {
            configName: responses.configName,
            enableCaching: responses.enableCaching ?? supportsCaching,
            setAsDefault: responses.setAsDefault,
        };
    }

    async promptRetryOnTestFailure(): Promise<boolean> {
        const { retry } = await inquirer.prompt([
            {
                type: "confirm",
                name: "retry",
                message: "Test failed. Would you like to try again with different settings?",
                default: true,
            },
        ]);
        return retry;
    }

    async promptConfigurationToEdit(configs: LLMConfigWithName[]): Promise<string> {
        const { configName } = await inquirer.prompt([
            {
                type: "list",
                name: "configName",
                message: "Select configuration to edit:",
                choices: configs.map((c) => c.name),
            },
        ]);
        return configName;
    }

    async promptFieldToEdit(): Promise<string> {
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
        return field;
    }

    async promptNewApiKey(): Promise<string> {
        const { newKey } = await inquirer.prompt([
            {
                type: "password",
                name: "newKey",
                message: "Enter new API key:",
                mask: "*",
            },
        ]);
        return newKey;
    }

    async promptEnableCaching(currentValue: boolean): Promise<boolean> {
        const { enableCaching } = await inquirer.prompt([
            {
                type: "confirm",
                name: "enableCaching",
                message: "Enable prompt caching?",
                default: currentValue,
            },
        ]);
        return enableCaching;
    }

    async promptNewConfigName(currentName: string, existingConfigs: Record<string, unknown>): Promise<string> {
        const { newName } = await inquirer.prompt([
            {
                type: "input",
                name: "newName",
                message: "Enter new configuration name:",
                default: currentName,
                validate: (input: string) => {
                    if (!input.trim()) return "Configuration name is required";
                    if (input !== currentName && existingConfigs[input])
                        return `Configuration "${input}" already exists`;
                    return true;
                },
            },
        ]);
        return newName;
    }

    async promptConfigurationToRemove(configs: LLMConfigWithName[]): Promise<string> {
        const { configName } = await inquirer.prompt([
            {
                type: "list",
                name: "configName",
                message: "Select configuration to remove:",
                choices: configs.map((c) => c.name),
            },
        ]);
        return configName;
    }

    async promptConfirmRemoval(configName: string): Promise<boolean> {
        const { confirm } = await inquirer.prompt([
            {
                type: "confirm",
                name: "confirm",
                message: `Are you sure you want to remove "${configName}"?`,
                default: false,
            },
        ]);
        return confirm;
    }

    async promptDefaultConfiguration(
        configs: LLMConfigWithName[],
        currentDefault: string,
        typeLabel: string
    ): Promise<string> {
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
        return configName;
    }

    async promptConfigurationToTest(configs: LLMConfigWithName[]): Promise<string> {
        const { configName } = await inquirer.prompt([
            {
                type: "list",
                name: "configName",
                message: "Select configuration to test:",
                choices: configs.map((c) => c.name),
            },
        ]);
        return configName;
    }

    displayMessages = {
        setupStart: () => logger.info(chalk.cyan("\n🤖 LLM Configuration Setup\n")),
        addingConfiguration: () => logger.info(chalk.cyan("\n➕ Add New LLM Configuration\n")),
        fetchingModels: (provider: string) => 
            logger.info(chalk.cyan(`🔍 Fetching available ${provider} models...`)),
        modelsFound: (count: number, provider: string) =>
            logger.info(chalk.green(`✅ Found ${count} ${provider} models`)),
        noModelsAvailable: (provider: string) =>
            logger.error(chalk.red(`❌ No models available for ${provider}`)),
        ollamaNotRunning: () =>
            logger.info(chalk.yellow("💡 Make sure Ollama is running with: ollama serve")),
        fetchModelsFailed: (provider: string, error: unknown) =>
            logger.error(chalk.red(`❌ Failed to fetch ${provider} models: ${error}`)),
        testingConfiguration: () =>
            logger.info(chalk.cyan("\n🧪 Testing configuration before saving...")),
        testSuccessful: () =>
            logger.info(chalk.green("✅ LLM configuration test successful!")),
        testFailed: () =>
            logger.error(chalk.red("❌ LLM configuration test failed")),
        retryPrompt: () =>
            logger.info(chalk.yellow("\n🔄 Let's try again...")),
        testFailureNotSaved: () =>
            logger.info(chalk.red("\n❌ Configuration not saved due to test failure.")),
        configurationAdded: (configName: string) =>
            logger.info(chalk.green(`\n✅ Configuration "${configName}" added and tested successfully!`)),
        editingConfiguration: (configName: string) =>
            logger.info(chalk.cyan(`\n✏️ Editing Configuration: ${configName}\n`)),
        configurationNotFound: (configName: string) =>
            logger.error(chalk.red(`Configuration ${configName} not found`)),
        fetchModelsFailed2: (error: unknown) =>
            logger.error(chalk.red(`Failed to fetch models: ${error}`)),
        ollamaNoApiKey: () =>
            logger.info(chalk.yellow("Ollama doesn't require an API key")),
        configurationUpdated: () =>
            logger.info(chalk.green("\n✅ Configuration updated successfully!")),
        configurationRemoved: (configName: string) =>
            logger.info(chalk.green(`\n✅ Configuration "${configName}" removed!`)),
        settingDefault: (typeLabel: string) =>
            logger.info(chalk.cyan(`\n⚙️  Set Default Configuration for ${typeLabel}`)),
        currentDefault: (currentDefault: string) =>
            logger.info(chalk.gray(`Current default: ${currentDefault}\n`)),
        defaultSet: (configName: string, typeLabel: string) =>
            logger.info(chalk.green(`\n✅ Configuration "${configName}" set as ${typeLabel} default!`)),
        testingExistingConfig: (configName: string) =>
            logger.info(chalk.cyan(`🧪 Testing ${configName} configuration...`)),
        configurationComplete: () =>
            logger.info(chalk.green("\n✅ LLM configuration complete!")),
        configurationSaved: () =>
            logger.info(chalk.green("\n✅ Configuration saved!")),
    };
}
