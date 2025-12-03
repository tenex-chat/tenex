import type { LLMConfiguration, TenexLLMs } from "@/services/config/types";
import chalk from "chalk";
import inquirer from "inquirer";
import type { AISdkProvider } from "../types";
import { ModelSelector } from "./ModelSelector";
import { ProviderConfigUI } from "./ProviderConfigUI";

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
        if (provider === "openrouter") {
            model = await ModelSelector.selectOpenRouterModel();
        } else if (provider === "ollama") {
            model = await ModelSelector.selectOllamaModel();
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

    private static getDefaultModelForProvider(provider: AISdkProvider): string {
        const defaults: Record<AISdkProvider, string> = {
            openrouter: "openai/gpt-4",
            anthropic: "claude-3-5-sonnet-latest",
            openai: "gpt-4",
            ollama: "llama3.1:8b",
            claudeCode: "claude-3-5-sonnet-20241022", // Default model for Claude Code
            "gemini-cli": "gemini-2.0-flash-exp",
        };
        return defaults[provider] || "";
    }
}
