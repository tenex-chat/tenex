import chalk from "chalk";
import inquirer from "inquirer";
import { amber, inquirerTheme } from "@/utils/cli-theme";
import { fetchOllamaModels, getPopularOllamaModels } from "../providers/ollama-models";
import { fetchOpenRouterModels, getPopularModels } from "../providers/openrouter-models";
import { ensureCacheLoaded, getProviderModels } from "./models-dev-cache";

/**
 * Utility class for interactive model selection
 * Extracted from LLMConfigEditor to reduce complexity
 */
export class ModelSelector {
    /**
     * Select an Ollama model interactively with fuzzy search
     */
    static async selectOllamaModel(currentModel?: string): Promise<string> {
        console.log(chalk.gray("Fetching available Ollama models..."));

        const ollamaModels = await fetchOllamaModels();

        if (ollamaModels.length > 0) {
            console.log(chalk.green(`✓ Found ${ollamaModels.length} installed models`));

            const allChoices = [
                ...ollamaModels.map((m) => ({
                    name: `${m.name} ${chalk.gray(`(${m.size})`)}`,
                    value: m.name,
                    short: m.name,
                })),
                { name: chalk.cyan("→ Type model name manually"), value: "__manual__", short: "manual" },
            ];

            const { selectedModel } = await inquirer.prompt([
                {
                    type: "search",
                    name: "selectedModel",
                    message: "Select model:",
                    source: (term: string | undefined) => {
                        if (!term) return allChoices;
                        const lower = term.toLowerCase();
                        const filtered = allChoices.filter(
                            (c) =>
                                c.value === "__manual__" ||
                                c.value.toLowerCase().includes(lower)
                        );
                        return filtered;
                    },
                    default: currentModel,
                    theme: {
                        ...inquirerTheme,
                        style: {
                            ...inquirerTheme.style,
                            searchTerm: (text: string) => amber(text || chalk.gray("Search models...")),
                        },
                    },
                },
            ]);

            if (selectedModel === "__manual__") {
                return await ModelSelector.promptManualModel(currentModel || "llama3.1:8b");
            }

            return selectedModel;
        }
        console.log(amber("⚠️  No Ollama models found. Make sure Ollama is running."));
        console.log(chalk.gray("Showing popular models (you'll need to pull them first)."));

        const popular = getPopularOllamaModels();
        const popularChoices: Array<{ name: string; value: string; short: string }> = [];
        for (const [category, models] of Object.entries(popular)) {
            for (const m of models) {
                popularChoices.push({
                    name: `${m} ${chalk.gray(`(${category})`)}`,
                    value: m,
                    short: m,
                });
            }
        }
        popularChoices.push({ name: chalk.cyan("→ Type model name manually"), value: "__manual__", short: "manual" });

        const { selectedModel } = await inquirer.prompt([
            {
                type: "search",
                name: "selectedModel",
                message: "Select model:",
                source: (term: string | undefined) => {
                    if (!term) return popularChoices;
                    const lower = term.toLowerCase();
                    return popularChoices.filter(
                        (c) =>
                            c.value === "__manual__" ||
                            c.value.toLowerCase().includes(lower) ||
                            c.name.toLowerCase().includes(lower)
                    );
                },
                default: currentModel,
                theme: {
                    ...inquirerTheme,
                    style: {
                        ...inquirerTheme.style,
                        searchTerm: (text: string) => amber(text || chalk.gray("Search models...")),
                    },
                },
            },
        ]);

        if (selectedModel === "__manual__") {
            return await ModelSelector.promptManualModel(currentModel || "llama3.1:8b");
        }

        return selectedModel;
    }

    /**
     * Select an OpenRouter model interactively with fuzzy search
     */
    static async selectOpenRouterModel(currentModel?: string): Promise<string> {
        console.log(chalk.gray("Fetching available OpenRouter models..."));

        const openRouterModels = await fetchOpenRouterModels();

        if (openRouterModels.length > 0) {
            console.log(chalk.green(`✓ Found ${openRouterModels.length} available models`));

            const allChoices = openRouterModels.map((model) => {
                const pricing = `$${model.pricing.prompt}/$${model.pricing.completion}/1M`;
                const context = `${Math.round(model.context_length / 1000)}k`;
                const freeTag = model.id.endsWith(":free") ? chalk.green(" [FREE]") : "";

                return {
                    name: `${model.id}${freeTag} ${chalk.gray(`- ${context} ctx, ${pricing}`)}`,
                    value: model.id,
                    short: model.id,
                };
            });

            allChoices.push({ name: chalk.cyan("→ Type model ID manually"), value: "__manual__", short: "manual" });

            const { selectedModel } = await inquirer.prompt([
                {
                    type: "search",
                    name: "selectedModel",
                    message: "Select model:",
                    source: (term: string | undefined) => {
                        if (!term) return allChoices;
                        const lower = term.toLowerCase();
                        return allChoices.filter(
                            (c) =>
                                c.value === "__manual__" ||
                                c.value.toLowerCase().includes(lower)
                        );
                    },
                    default: currentModel,
                    theme: {
                        ...inquirerTheme,
                        style: {
                            ...inquirerTheme.style,
                            searchTerm: (text: string) => amber(text || chalk.gray("Search models...")),
                        },
                    },
                },
            ]);

            if (selectedModel === "__manual__") {
                return await ModelSelector.promptManualModel(currentModel || "openai/gpt-4");
            }

            return selectedModel;
        }
        console.log(amber("⚠️  Failed to fetch models from OpenRouter API"));
        console.log(
            chalk.gray("You can still enter a model ID manually or select from popular models.")
        );

        const { selectionMethod } = await inquirer.prompt([
            {
                type: "select",
                name: "selectionMethod",
                message: "How would you like to select the model?",
                choices: [
                    { name: "Quick select from popular models", value: "quick" },
                    { name: "Type model ID manually", value: "manual" },
                ],
                theme: inquirerTheme,
            },
        ]);

        if (selectionMethod === "quick") {
            const popular = getPopularModels();
            const popularChoices: Array<{ name: string; value: string; short: string }> = [];
            for (const [category, models] of Object.entries(popular)) {
                for (const m of models) {
                    popularChoices.push({
                        name: `${m} ${chalk.gray(`(${category})`)}`,
                        value: m,
                        short: m,
                    });
                }
            }

            const { selectedModel } = await inquirer.prompt([
                {
                    type: "search",
                    name: "selectedModel",
                    message: "Select model:",
                    source: (term: string | undefined) => {
                        if (!term) return popularChoices;
                        const lower = term.toLowerCase();
                        return popularChoices.filter(
                            (c) =>
                                c.value.toLowerCase().includes(lower) ||
                                c.name.toLowerCase().includes(lower)
                        );
                    },
                    theme: {
                        ...inquirerTheme,
                        style: {
                            ...inquirerTheme.style,
                            searchTerm: (text: string) => amber(text || chalk.gray("Search models...")),
                        },
                    },
                },
            ]);
            return selectedModel;
        }
        return await ModelSelector.promptManualModel(currentModel || "openai/gpt-4");
    }

    /**
     * Select a model from models.dev data (for Anthropic, OpenAI, etc.)
     * Returns { id, name } so callers can use the human name for config naming.
     */
    static async selectModelsDevModel(
        provider: string,
        defaultModel?: string
    ): Promise<{ id: string; name: string }> {
        await ensureCacheLoaded();
        const models = getProviderModels(provider);

        if (models.length > 0) {
            const allChoices = [
                ...models.map((m) => {
                    const ctx = m.limit?.context
                        ? `${Math.round(m.limit.context / 1000)}k ctx`
                        : "";
                    const pricing = m.cost
                        ? `$${m.cost.input}/$${m.cost.output}/M`
                        : "";
                    const meta = [ctx, pricing].filter(Boolean).join(", ");

                    return {
                        name: `${m.name} ${chalk.gray(`(${m.id})`)} ${chalk.gray(meta ? `- ${meta}` : "")}`,
                        value: m.id,
                        short: m.id,
                        humanName: m.name,
                    };
                }),
                { name: chalk.cyan("→ Type model ID manually"), value: "__manual__", short: "manual", humanName: "" },
            ];

            const { selectedModel } = await inquirer.prompt([
                {
                    type: "search",
                    name: "selectedModel",
                    message: "Select model:",
                    source: (term: string | undefined) => {
                        if (!term) return allChoices;
                        const lower = term.toLowerCase();
                        return allChoices.filter(
                            (c) =>
                                c.value === "__manual__" ||
                                c.value.toLowerCase().includes(lower) ||
                                c.humanName.toLowerCase().includes(lower)
                        );
                    },
                    default: defaultModel,
                    theme: {
                        ...inquirerTheme,
                        style: {
                            ...inquirerTheme.style,
                            searchTerm: (text: string) => amber(text || chalk.gray("Search models...")),
                        },
                    },
                },
            ]);

            if (selectedModel === "__manual__") {
                const id = await ModelSelector.promptManualModel(defaultModel || "");
                return { id, name: id };
            }

            const selected = allChoices.find((c) => c.value === selectedModel);
            return { id: selectedModel, name: selected?.humanName || selectedModel };
        }

        // No models.dev data available — fall back to manual
        const id = await ModelSelector.promptManualModel(defaultModel || "");
        return { id, name: id };
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
                theme: inquirerTheme,
            },
        ]);
        return inputModel;
    }
}
