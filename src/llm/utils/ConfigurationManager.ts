import type { LLMConfiguration, TenexLLMs } from "@/services/config/types";
import chalk from "chalk";
import inquirer from "inquirer";
import { PROVIDER_IDS } from "@/llm/providers/provider-ids";
import type { AISdkProvider } from "../types";
import { ModelSelector } from "./ModelSelector";
import { ProviderConfigUI } from "./ProviderConfigUI";
import { listCodexModels, formatCodexModel } from "./codex-models";

/**
 * Manages LLM configuration CRUD operations
 */
export class ConfigurationManager {
    static async add(llmsConfig: TenexLLMs, isFirstConfig = false): Promise<void> {
        const configuredProviders = Object.keys(llmsConfig.providers).filter(
            (p) => llmsConfig.providers[p]?.apiKey
        );

        if (configuredProviders.length === 0) {
            console.log(
                chalk.yellow("⚠️  No providers configured. Please configure API keys first.")
            );
            return;
        }

        // Select provider
        const { provider } = await inquirer.prompt([
            {
                type: "list",
                name: "provider",
                message: "Select provider:",
                choices: configuredProviders.map((p) => ({
                    name: ProviderConfigUI.getProviderDisplayName(p),
                    value: p,
                })),
            },
        ]);

        // Select model based on provider
        let model: string;
        let reasoningEffort: string | undefined;

        if (provider === "openrouter") {
            model = await ModelSelector.selectOpenRouterModel();
        } else if (provider === "ollama") {
            model = await ModelSelector.selectOllamaModel();
        } else if (provider === PROVIDER_IDS.CODEX_APP_SERVER) {
            // For Codex, show available models with reasoning efforts
            const result = await ConfigurationManager.selectCodexModel();
            model = result.model;
            reasoningEffort = result.reasoningEffort;
        } else {
            const { inputModel } = await inquirer.prompt([
                {
                    type: "input",
                    name: "inputModel",
                    message: "Enter model name:",
                    default: ConfigurationManager.getDefaultModelForProvider(
                        provider as AISdkProvider
                    ),
                    validate: (input: string) => {
                        if (!input.trim()) return "Model name is required";
                        return true;
                    },
                },
            ]);
            model = inputModel;
        }

        // Optional settings
        const { temperature, maxTokens } = await inquirer.prompt([
            {
                type: "input",
                name: "temperature",
                message: "Temperature (0-2, press enter to skip):",
                validate: (input: string) => {
                    if (!input) return true;
                    const num = Number.parseFloat(input);
                    if (Number.isNaN(num) || num < 0 || num > 2)
                        return "Temperature must be between 0 and 2";
                    return true;
                },
            },
            {
                type: "input",
                name: "maxTokens",
                message: "Max tokens (press enter to skip):",
                validate: (input: string) => {
                    if (!input) return true;
                    const num = Number.parseInt(input);
                    if (Number.isNaN(num) || num <= 0)
                        return "Max tokens must be a positive number";
                    return true;
                },
            },
        ]);

        // Name the configuration
        const { name } = await inquirer.prompt([
            {
                type: "input",
                name: "name",
                message: "Configuration name:",
                default: isFirstConfig ? "default" : undefined,
                validate: (input: string) => {
                    if (!input.trim()) return "Name is required";
                    if (llmsConfig.configurations[input]) return "Configuration already exists";
                    return true;
                },
            },
        ]);

        // Create configuration
        const config: LLMConfiguration = {
            provider,
            model,
        };

        if (temperature) config.temperature = Number.parseFloat(temperature);
        if (maxTokens) config.maxTokens = Number.parseInt(maxTokens);
        if (reasoningEffort) config.reasoningEffort = reasoningEffort as LLMConfiguration["reasoningEffort"];

        llmsConfig.configurations[name] = config;

        // Set as default if first or ask user
        if (isFirstConfig || !llmsConfig.default) {
            llmsConfig.default = name;
            console.log(chalk.green(`✅ Configuration "${name}" created and set as default`));
        } else {
            const { setAsDefault } = await inquirer.prompt([
                {
                    type: "confirm",
                    name: "setAsDefault",
                    message: "Set as default configuration?",
                    default: false,
                },
            ]);

            if (setAsDefault) {
                llmsConfig.default = name;
            }
            console.log(chalk.green(`✅ Configuration "${name}" created`));
        }
    }

    static async delete(llmsConfig: TenexLLMs): Promise<void> {
        const configNames = Object.keys(llmsConfig.configurations);

        if (configNames.length === 0) {
            console.log(chalk.yellow("⚠️  No configurations to delete"));
            return;
        }

        const { name } = await inquirer.prompt([
            {
                type: "list",
                name: "name",
                message: "Select configuration to delete:",
                choices: configNames.map((n) => ({
                    name: n === llmsConfig.default ? `${n} (default)` : n,
                    value: n,
                })),
            },
        ]);

        const { confirm } = await inquirer.prompt([
            {
                type: "confirm",
                name: "confirm",
                message: `Are you sure you want to delete "${name}"?`,
                default: false,
            },
        ]);

        if (confirm) {
            delete llmsConfig.configurations[name];

            // Update default if needed
            if (llmsConfig.default === name) {
                const remaining = Object.keys(llmsConfig.configurations);
                llmsConfig.default = remaining.length > 0 ? remaining[0] : undefined;

                if (llmsConfig.default) {
                    console.log(chalk.yellow(`Default changed to "${llmsConfig.default}"`));
                }
            }

            console.log(chalk.green(`✅ Configuration "${name}" deleted`));
        }
    }

    static async setDefault(llmsConfig: TenexLLMs): Promise<void> {
        const configNames = Object.keys(llmsConfig.configurations);

        if (configNames.length === 0) {
            console.log(chalk.yellow("⚠️  No configurations available"));
            return;
        }

        const { name } = await inquirer.prompt([
            {
                type: "list",
                name: "name",
                message: "Select default configuration:",
                choices: configNames.map((n) => ({
                    name: n === llmsConfig.default ? `${n} (current default)` : n,
                    value: n,
                })),
            },
        ]);

        llmsConfig.default = name;
        console.log(chalk.green(`✅ Default configuration set to "${name}"`));
    }

    static async setSummarizationModel(llmsConfig: TenexLLMs): Promise<void> {
        const configNames = Object.keys(llmsConfig.configurations);

        if (configNames.length === 0) {
            console.log(chalk.yellow("⚠️  No configurations available"));
            return;
        }

        const { name } = await inquirer.prompt([
            {
                type: "list",
                name: "name",
                message: "Select summarization model:",
                choices: configNames.map((n) => ({
                    name: n === llmsConfig.summarization ? `${n} (current)` : n,
                    value: n,
                })),
            },
        ]);

        llmsConfig.summarization = name;
        console.log(chalk.green(`✅ Summarization model set to "${name}"`));

        // Offer to test the configuration
        const { shouldTest } = await inquirer.prompt([
            {
                type: "confirm",
                name: "shouldTest",
                message: "Would you like to test this configuration with generateObject?",
                default: true,
            },
        ]);

        if (shouldTest) {
            const { ConfigurationTester } = await import("./ConfigurationTester");
            await ConfigurationTester.testSummarization(llmsConfig, name);
        }
    }

    static async setSupervisionModel(llmsConfig: TenexLLMs): Promise<void> {
        const configNames = Object.keys(llmsConfig.configurations);

        if (configNames.length === 0) {
            console.log(chalk.yellow("⚠️  No configurations available"));
            return;
        }

        const { name } = await inquirer.prompt([
            {
                type: "list",
                name: "name",
                message: "Select supervision model:",
                choices: configNames.map((n) => ({
                    name: n === llmsConfig.supervision ? `${n} (current)` : n,
                    value: n,
                })),
            },
        ]);

        llmsConfig.supervision = name;
        console.log(chalk.green(`✅ Supervision model set to "${name}"`));
    }

    /**
     * Select a Codex model and reasoning effort interactively
     */
    private static async selectCodexModel(): Promise<{ model: string; reasoningEffort?: string }> {
        console.log(chalk.cyan("\nFetching available Codex models..."));

        try {
            const models = await listCodexModels();

            if (models.length === 0) {
                console.log(chalk.yellow("No models found. Using default."));
                return { model: "gpt-5.1-codex-max" };
            }

            // Show models with details
            console.log(chalk.bold("\nAvailable Codex Models:"));
            for (const model of models) {
                console.log(chalk.gray(formatCodexModel(model)));
            }
            console.log("");

            // Select model
            const { model } = await inquirer.prompt([
                {
                    type: "list",
                    name: "model",
                    message: "Select model:",
                    choices: models.map((m) => ({
                        name: m.isDefault ? `${m.displayName} (default)` : m.displayName,
                        value: m.id,
                    })),
                },
            ]);

            // Find selected model to get its reasoning efforts
            const selectedModel = models.find((m) => m.id === model);
            if (!selectedModel || selectedModel.supportedReasoningEfforts.length === 0) {
                return { model };
            }

            // Select reasoning effort
            const { reasoningEffort } = await inquirer.prompt([
                {
                    type: "list",
                    name: "reasoningEffort",
                    message: "Select reasoning effort:",
                    choices: [
                        { name: "Use model default", value: undefined },
                        ...selectedModel.supportedReasoningEfforts.map((e) => ({
                            name: e === selectedModel.defaultReasoningEffort ? `${e} (default)` : e,
                            value: e,
                        })),
                    ],
                },
            ]);

            return { model, reasoningEffort };
        } catch (error) {
            console.log(chalk.yellow(`Could not fetch models: ${error}. Using default.`));
            return { model: "gpt-5.1-codex-max" };
        }
    }

    private static getDefaultModelForProvider(provider: AISdkProvider): string {
        const defaults: Record<AISdkProvider, string> = {
            openrouter: "openai/gpt-4",
            anthropic: "claude-3-5-sonnet-latest",
            openai: "gpt-4",
            ollama: "llama3.1:8b",
            "claude-code": "claude-3-5-sonnet-20241022",
            "gemini-cli": "gemini-2.0-flash-exp",
            "codex-app-server": "gpt-5.1-codex-max",
        };
        return defaults[provider] || "";
    }
}
