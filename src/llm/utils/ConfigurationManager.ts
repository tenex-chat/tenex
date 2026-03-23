import type { LLMConfiguration, TenexLLMs } from "@/services/config/types";
import { hasApiKey } from "@/llm/providers/key-manager";

/**
 * Extended type for editor use - includes providers
 */
type TenexLLMsWithProviders = TenexLLMs & {
    providers: Record<string, { apiKey: string | string[] }>;
};
import chalk from "chalk";
import inquirer from "inquirer";
import { inquirerTheme } from "@/utils/cli-theme";
import * as display from "@/commands/config/display";
import { PROVIDER_IDS } from "@/llm/providers/provider-ids";
import type { AISdkProvider } from "../types";
import { selectOpenRouterModel, selectOllamaModel, selectModelsDevModel, OllamaNotRunningError } from "./ModelSelector";
import { getProviderDisplayName } from "./ProviderConfigUI";
import { listCodexModels } from "./codex-models";
import { variantListPrompt } from "./variant-list-prompt";

export async function addConfiguration(llmsConfig: TenexLLMsWithProviders, advanced = false): Promise<void> {
    const configuredProviders = Object.keys(llmsConfig.providers).filter(
        (p) => {
            const key = llmsConfig.providers[p]?.apiKey;
            return hasApiKey(key) || key === "none";
        }
    );

    if (configuredProviders.length === 0) {
        display.hint("No providers configured. Please configure API keys first.");
        return;
    }

    // Select provider
    const { provider } = await inquirer.prompt([
        {
            type: "select",
            name: "provider",
            message: "Select provider:",
            choices: configuredProviders.map((p) => ({
                name: getProviderDisplayName(p),
                value: p,
            })),
            theme: inquirerTheme,
        },
    ]);

    // Select model based on provider
    let model: string;
    let modelDisplayName: string | undefined;
    let effort: string | undefined;

    if (provider === "openrouter") {
        model = await selectOpenRouterModel();
    } else if (provider === "ollama") {
        try {
            const ollamaUrl = llmsConfig.providers.ollama?.apiKey;
            const baseUrl = typeof ollamaUrl === "string" ? ollamaUrl : undefined;
            model = await selectOllamaModel(undefined, baseUrl);
        } catch (e) {
            if (e instanceof OllamaNotRunningError) {
                return addConfiguration(llmsConfig, advanced);
            }
            throw e;
        }
    } else if (provider === PROVIDER_IDS.CODEX) {
        const result = await selectCodexModel();
        model = result.model;
        effort = result.effort;
    } else {
        // Use models.dev list for Anthropic, OpenAI, and any other provider with data
        const result = await selectModelsDevModel(
            provider,
            getDefaultModelForProvider(provider as AISdkProvider)
        );
        model = result.id;
        modelDisplayName = result.name;
    }

    // Advanced settings (temperature, maxTokens) only when --advanced
    let temperature: string | undefined;
    let maxTokens: string | undefined;

    if (advanced) {
        const advancedAnswers = await inquirer.prompt([
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
                theme: inquirerTheme,
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
                theme: inquirerTheme,
            },
        ]);
        temperature = advancedAnswers.temperature;
        maxTokens = advancedAnswers.maxTokens;
    }

    // Default config name to provider/humanName (e.g. "anthropic/Claude Sonnet 4.6")
    const defaultName = `${provider}/${modelDisplayName || model}`;

    const { name } = await inquirer.prompt([
        {
            type: "input",
            name: "name",
            message: "Configuration name:",
            default: defaultName,
            validate: (input: string) => {
                if (!input.trim()) return "Name is required";
                if (llmsConfig.configurations[input]) return "Configuration already exists";
                return true;
            },
            theme: inquirerTheme,
        },
    ]);

    // Create configuration
    const config: LLMConfiguration = {
        provider,
        model,
    };

    if (temperature) config.temperature = Number.parseFloat(temperature);
    if (maxTokens) config.maxTokens = Number.parseInt(maxTokens);
    if (effort) config.effort = effort as LLMConfiguration["effort"];

    llmsConfig.configurations[name] = config;

    // Auto-set as default if first config or no default exists
    if (!llmsConfig.default || Object.keys(llmsConfig.configurations).length === 1) {
        llmsConfig.default = name;
        display.success(`Configuration "${name}" created and set as default`);
    } else {
        display.success(`Configuration "${name}" created`);
    }
}

/**
 * Create a multi-modal configuration with multiple variants
 */
export async function addMultiModalConfiguration(llmsConfig: TenexLLMsWithProviders): Promise<void> {
    const standardConfigs = Object.keys(llmsConfig.configurations).filter((name) => {
        const config = llmsConfig.configurations[name];
        return config.provider !== "meta";
    });

    if (standardConfigs.length < 2) {
        display.hint("You need at least 2 standard LLM configurations to create a multi-modal configuration.");
        display.context("Create more configurations first with 'Add new configuration'.");
        return;
    }

    display.blank();
    display.step(0, 0, "Add Multi-Modal Configuration");
    display.context(
        "Multi-modal configurations let you switch between different models using keywords.\n" +
        "For example, starting a message with 'ultrathink' can trigger a more powerful model."
    );
    display.blank();

    const { metaName } = await inquirer.prompt([
        {
            type: "input",
            name: "metaName",
            message: "Multi-modal configuration name:",
            validate: (input: string) => {
                if (!input.trim()) return "Name is required";
                if (llmsConfig.configurations[input]) return "Configuration already exists";
                return true;
            },
            theme: inquirerTheme,
        },
    ]);

    const metaConfig = await variantListPrompt(metaName, standardConfigs);

    llmsConfig.configurations[metaName] = metaConfig;

    if (!llmsConfig.default) {
        llmsConfig.default = metaName;
    }

    const variantCount = Object.keys(metaConfig.variants).length;
    display.blank();
    display.success(`Multi-modal configuration "${metaName}" created with ${variantCount} variants`);
}

/**
 * Select a Codex model and reasoning effort interactively
 */
async function selectCodexModel(): Promise<{ model: string; effort?: string }> {
    display.blank();
    display.context("Fetching available Codex models...");

    try {
        const models = await listCodexModels();

        if (models.length === 0) {
            display.hint("No models found. Using default.");
            return { model: "gpt-5.1-codex-max" };
        }

        const { model } = await inquirer.prompt([
            {
                type: "select",
                name: "model",
                message: "Select model:",
                choices: models.map((m) => {
                    const defaultTag = m.isDefault ? chalk.dim(" (default)") : "";
                    return {
                        name: `${m.id}${defaultTag} ${chalk.dim(m.description)}`,
                        value: m.id,
                    };
                }),
                theme: inquirerTheme,
            },
        ]);

        const { effort } = await inquirer.prompt([
            {
                type: "select",
                name: "effort",
                message: "Select effort:",
                choices: [
                    { name: "Use model default", value: undefined },
                    { name: "low", value: "low" },
                    { name: "medium", value: "medium" },
                    { name: "high", value: "high" },
                    { name: "xhigh", value: "xhigh" },
                ],
                theme: inquirerTheme,
            },
        ]);

        return { model, effort };
    } catch (error) {
        display.hint(`Could not fetch models: ${error}. Using default.`);
        return { model: "gpt-5.1-codex-max" };
    }
}

function getDefaultModelForProvider(provider: AISdkProvider): string {
    const defaults: Record<AISdkProvider, string> = {
        [PROVIDER_IDS.OPENROUTER]: "openai/gpt-4",
        [PROVIDER_IDS.ANTHROPIC]: "claude-3-5-sonnet-latest",
        [PROVIDER_IDS.OPENAI]: "gpt-4",
        [PROVIDER_IDS.OLLAMA]: "llama3.1:8b",
        [PROVIDER_IDS.CODEX]: "gpt-5.1-codex-max",
    };
    return defaults[provider] || "";
}
