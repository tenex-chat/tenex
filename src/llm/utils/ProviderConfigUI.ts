import { PROVIDER_IDS } from "@/llm/providers/provider-ids";
import type { TenexLLMs } from "@/services/config/types";
import chalk from "chalk";
import inquirer from "inquirer";

/**
 * Extended type for editor use - includes providers
 */
type TenexLLMsWithProviders = TenexLLMs & {
    providers: Record<string, { apiKey: string }>;
};

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
            [PROVIDER_IDS.OPENROUTER]: "OpenRouter (300+ models)",
            [PROVIDER_IDS.ANTHROPIC]: "Anthropic (Claude)",
            [PROVIDER_IDS.OPENAI]: "OpenAI (GPT)",
            [PROVIDER_IDS.OLLAMA]: "Ollama (Local models)",
            [PROVIDER_IDS.CLAUDE_CODE]: "Claude Code",
            [PROVIDER_IDS.GEMINI_CLI]: "Gemini CLI (via GCloud)",
            [PROVIDER_IDS.CODEX_APP_SERVER]: "Codex App Server (GPT-5.1/5.2)",
        };
        return names[provider] || provider;
    }

    /**
     * Configure a specific provider interactively
     */
    static async configureProvider(
        provider: string,
        currentConfig?: TenexLLMsWithProviders
    ): Promise<{ apiKey: string }> {
        if (provider === PROVIDER_IDS.CLAUDE_CODE || provider === PROVIDER_IDS.GEMINI_CLI || provider === PROVIDER_IDS.CODEX_APP_SERVER) {
            // Agent providers don't require an API key
            console.log(
                chalk.green(
                    `✓ ${ProviderConfigUI.getProviderDisplayName(provider)} provider configured (no API key required)`
                )
            );
            return { apiKey: "none" }; // Doesn't use API keys
        }
        if (provider === PROVIDER_IDS.OLLAMA) {
            // For Ollama, ask for base URL instead of API key
            const currentUrl = currentConfig?.providers[provider]?.apiKey || "local";
            const { ollamaConfig } = await inquirer.prompt([
                {
                    type: "select",
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
        }
        // For other providers, ask for API key
        const currentKey = currentConfig?.providers[provider]?.apiKey;
        const { apiKey } = await inquirer.prompt([
            {
                type: "password",
                name: "apiKey",
                message: `Enter API key for ${ProviderConfigUI.getProviderDisplayName(provider)} (press Enter to keep existing):`,
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

    /**
     * Display current configuration status
     */
    static displayCurrentConfig(llmsConfig: TenexLLMsWithProviders): void {
        console.log(chalk.bold("Configured Providers:"));
        const providers = Object.keys(llmsConfig.providers).filter(
            (p) => llmsConfig.providers[p]?.apiKey
        );
        if (providers.length === 0) {
            console.log(chalk.gray("  None configured"));
        } else {
            for (const p of providers) {
                console.log(chalk.green(`  ✓ ${ProviderConfigUI.getProviderDisplayName(p)}`));
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
                const isSummarization = name === llmsConfig.summarization;
                const marker = isDefault || isSummarization ? chalk.cyan("• ") : "  ";

                const tags: string[] = [];
                if (isDefault) tags.push("default");
                if (isSummarization) tags.push("summarization");
                const tagStr = tags.length > 0 ? chalk.gray(` (${tags.join(", ")})`) : "";

                // Handle meta models differently - they don't have a single model
                const configDisplay = config.provider === "meta"
                    ? `meta (${Object.keys((config as { variants: Record<string, unknown> }).variants).length} variants)`
                    : `${config.provider}:${"model" in config ? config.model : "unknown"}`;
                console.log(`  ${marker}${name}${tagStr}: ${configDisplay}`);
            }
        }
    }
}
