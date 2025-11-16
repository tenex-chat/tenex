import type { TenexLLMs } from "@/services/config/types";
import chalk from "chalk";
import inquirer from "inquirer";

/**
 * UI utilities for provider configuration
 * Extracted from LLMConfigEditor to separate concerns
 */
export class ProviderConfigUI {
    /**
     * Get provider display names
     */
    static getProviderDisplayName(provider: string): string {
        const names: Record<string, string> = {
            openrouter: "OpenRouter (300+ models)",
            anthropic: "Anthropic (Claude)",
            openai: "OpenAI (GPT)",
            ollama: "Ollama (Local models)",
            claudeCode: "Claude Code",
            "gemini-cli": "Gemini CLI (via GCloud)",
        };
        return names[provider] || provider;
    }

    /**
     * Configure a specific provider interactively
     */
    static async configureProvider(
        provider: string,
        currentConfig?: TenexLLMs
    ): Promise<{ apiKey: string }> {
        if (provider === "claudeCode" || provider === "gemini-cli") {
            // Claude Code and Gemini CLI don't require an API key
            console.log(
                chalk.green(
                    `✓ ${this.getProviderDisplayName(provider)} provider configured (no API key required)`
                )
            );
            return { apiKey: "none" }; // Doesn't use API keys
        } else if (provider === "ollama") {
            // For Ollama, ask for base URL instead of API key
            const currentUrl = currentConfig?.providers[provider]?.apiKey || "local";
            const { ollamaConfig } = await inquirer.prompt([
                {
                    type: "list",
                    name: "ollamaConfig",
                    message: "Ollama configuration:",
                    choices: [
                        { name: "Use local Ollama (http://localhost:11434)", value: "local" },
                        { name: "Use custom Ollama URL", value: "custom" },
                    ],
                    default: currentUrl === "local" ? "local" : "custom",
                },
            ]);

            let baseUrl = "local";
            if (ollamaConfig === "custom") {
                const { customUrl } = await inquirer.prompt([
                    {
                        type: "input",
                        name: "customUrl",
                        message: "Enter Ollama base URL:",
                        default: currentUrl !== "local" ? currentUrl : "http://localhost:11434",
                        validate: (input: string) => {
                            if (!input.trim()) return "URL is required";
                            try {
                                new URL(input);
                                return true;
                            } catch {
                                return "Please enter a valid URL";
                            }
                        },
                    },
                ]);
                baseUrl = customUrl;
            }

            return { apiKey: baseUrl };
        } else {
            // For other providers, ask for API key
            const currentKey = currentConfig?.providers[provider]?.apiKey;
            const { apiKey } = await inquirer.prompt([
                {
                    type: "password",
                    name: "apiKey",
                    message: `Enter API key for ${this.getProviderDisplayName(provider)} (press Enter to keep existing):`,
                    default: currentKey,
                    mask: "*",
                    validate: (input: string) => {
                        // Allow empty input if there's an existing key
                        if (!input.trim() && !currentKey) return "API key is required";
                        return true;
                    },
                },
            ]);

            return { apiKey: apiKey || currentKey || "" };
        }
    }

    /**
     * Display current configuration status
     */
    static displayCurrentConfig(llmsConfig: TenexLLMs): void {
        console.log(chalk.bold("Configured Providers:"));
        const providers = Object.keys(llmsConfig.providers).filter(
            (p) => llmsConfig.providers[p]?.apiKey
        );
        if (providers.length === 0) {
            console.log(chalk.gray("  None configured"));
        } else {
            for (const p of providers) {
                console.log(chalk.green(`  ✓ ${this.getProviderDisplayName(p)}`));
            }
        }

        console.log(chalk.bold("\nConfigurations:"));
        const configNames = Object.keys(llmsConfig.configurations);
        if (configNames.length === 0) {
            console.log(chalk.gray("  None"));
        } else {
            for (const name of configNames) {
                const config = llmsConfig.configurations[name];
                const isDefault = name === llmsConfig.default;
                const marker = isDefault ? chalk.cyan("• ") : "  ";
                const defaultTag = isDefault ? chalk.gray(" (default)") : "";
                console.log(`  ${marker}${name}${defaultTag}: ${config.provider}:${config.model}`);
            }
        }
    }
}
