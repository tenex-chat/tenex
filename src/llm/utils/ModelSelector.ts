import chalk from "chalk";
import inquirer from "inquirer";
import { fetchOllamaModels, getPopularOllamaModels } from "../providers/ollama-models";
import { fetchOpenRouterModels, getPopularModels } from "../providers/openrouter-models";

/**
 * Utility class for interactive model selection
 * Extracted from LLMConfigEditor to reduce complexity
 */
export class ModelSelector {
    /**
     * Select an Ollama model interactively
     */
    static async selectOllamaModel(currentModel?: string): Promise<string> {
        console.log(chalk.gray("Fetching available Ollama models..."));

        const ollamaModels = await fetchOllamaModels();

        if (ollamaModels.length > 0) {
            console.log(chalk.green(`✓ Found ${ollamaModels.length} installed models`));

            const choices = [
                ...ollamaModels.map((m) => ({
                    name: `${m.name} ${chalk.gray(`(${m.size})`)}`,
                    value: m.name,
                })),
                new inquirer.Separator(),
                { name: chalk.cyan("→ Type model name manually"), value: "__manual__" },
            ];

            const { selectedModel } = await inquirer.prompt([
                {
                    type: "list",
                    name: "selectedModel",
                    message: "Select model:",
                    choices,
                    default: currentModel,
                    pageSize: 15,
                },
            ]);

            if (selectedModel === "__manual__") {
                return await this.promptManualModel(currentModel || "llama3.1:8b");
            }

            return selectedModel;
        } else {
            console.log(chalk.yellow("⚠️  No Ollama models found. Make sure Ollama is running."));
            console.log(chalk.gray("Showing popular models (you'll need to pull them first)."));

            const popular = getPopularOllamaModels();
            const choices = [];
            for (const [category, models] of Object.entries(popular)) {
                choices.push(new inquirer.Separator(`--- ${category} ---`));
                choices.push(
                    ...models.map((m) => ({
                        name: m,
                        value: m,
                    }))
                );
            }

            choices.push(new inquirer.Separator());
            choices.push({ name: chalk.cyan("→ Type model name manually"), value: "__manual__" });

            const { selectedModel } = await inquirer.prompt([
                {
                    type: "list",
                    name: "selectedModel",
                    message: "Select model:",
                    default: currentModel,
                    choices,
                    pageSize: 15,
                },
            ]);

            if (selectedModel === "__manual__") {
                return await this.promptManualModel(currentModel || "llama3.1:8b");
            }

            return selectedModel;
        }
    }

    /**
     * Select an OpenRouter model interactively
     */
    static async selectOpenRouterModel(currentModel?: string): Promise<string> {
        console.log(chalk.gray("Fetching available OpenRouter models..."));

        const openRouterModels = await fetchOpenRouterModels();

        if (openRouterModels.length > 0) {
            console.log(chalk.green(`✓ Found ${openRouterModels.length} available models`));

            // Group models by provider
            const modelsByProvider: Record<string, typeof openRouterModels> = {};
            for (const model of openRouterModels) {
                const provider = model.id.split("/")[0] || "other";
                if (!modelsByProvider[provider]) {
                    modelsByProvider[provider] = [];
                }
                modelsByProvider[provider].push(model);
            }

            // Build choices
            const choices = [];
            const sortedProviders = Object.keys(modelsByProvider).sort();

            for (const provider of sortedProviders) {
                choices.push(
                    new inquirer.Separator(chalk.yellow(`--- ${provider.toUpperCase()} ---`))
                );
                const providerModels = modelsByProvider[provider];

                for (const model of providerModels) {
                    const pricing = `$${model.pricing.prompt}/$${model.pricing.completion}/1M`;
                    const context = `${Math.round(model.context_length / 1000)}k`;
                    const freeTag = model.id.endsWith(":free") ? chalk.green(" [FREE]") : "";

                    choices.push({
                        name: `${model.id}${freeTag} ${chalk.gray(`- ${context} context, ${pricing}`)}`,
                        value: model.id,
                        short: model.id,
                    });
                }
            }

            choices.push(new inquirer.Separator());
            choices.push({ name: chalk.cyan("→ Type model ID manually"), value: "__manual__" });

            const { selectedModel } = await inquirer.prompt([
                {
                    type: "list",
                    name: "selectedModel",
                    message: "Select model:",
                    choices,
                    default: currentModel,
                    pageSize: 20,
                    loop: false,
                },
            ]);

            if (selectedModel === "__manual__") {
                return await this.promptManualModel(currentModel || "openai/gpt-4");
            }

            return selectedModel;
        } else {
            console.log(chalk.yellow("⚠️  Failed to fetch models from OpenRouter API"));
            console.log(
                chalk.gray("You can still enter a model ID manually or select from popular models.")
            );

            const { selectionMethod } = await inquirer.prompt([
                {
                    type: "list",
                    name: "selectionMethod",
                    message: "How would you like to select the model?",
                    choices: [
                        { name: "Quick select from popular models", value: "quick" },
                        { name: "Type model ID manually", value: "manual" },
                    ],
                },
            ]);

            if (selectionMethod === "quick") {
                const popular = getPopularModels();
                const choices = [];
                for (const [category, models] of Object.entries(popular)) {
                    choices.push(new inquirer.Separator(`--- ${category} ---`));
                    choices.push(
                        ...models.map((m) => ({
                            name: m,
                            value: m,
                        }))
                    );
                }

                const { selectedModel } = await inquirer.prompt([
                    {
                        type: "list",
                        name: "selectedModel",
                        message: "Select model:",
                        default: currentModel,
                        choices,
                        pageSize: 15,
                    },
                ]);
                return selectedModel;
            } else {
                return await this.promptManualModel(currentModel || "openai/gpt-4");
            }
        }
    }

    /**
     * Prompt for manual model entry
     */
    private static async promptManualModel(defaultValue: string): Promise<string> {
        const { inputModel } = await inquirer.prompt([
            {
                type: "input",
                name: "inputModel",
                message: "Enter model name/ID:",
                default: defaultValue,
                validate: (input: string) => {
                    if (!input.trim()) return "Model name is required";
                    return true;
                },
            },
        ]);
        return inputModel;
    }
}
