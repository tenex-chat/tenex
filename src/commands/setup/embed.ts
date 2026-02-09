import * as fileSystem from "@/lib/fs";
import { PROVIDER_IDS } from "@/llm/providers/provider-ids";
import {
    type EmbeddingConfig,
    EmbeddingProviderFactory,
} from "@/services/rag/EmbeddingProviderFactory";
import { config as configService } from "@/services/ConfigService";
import { logger } from "@/utils/logger";
import { Command } from "commander";
import inquirer from "inquirer";

/**
 * Providers that support embeddings (OpenAI-compatible API)
 */
const EMBEDDING_CAPABLE_PROVIDERS = [
    PROVIDER_IDS.OPENAI,
    PROVIDER_IDS.OPENROUTER,
] as const;

/**
 * Display names for providers
 */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
    [PROVIDER_IDS.OPENAI]: "OpenAI",
    [PROVIDER_IDS.OPENROUTER]: "OpenRouter",
};

/**
 * Common embedding models by provider
 */
const EMBEDDING_MODELS: Record<string, Array<{ name: string; value: string }>> = {
    [PROVIDER_IDS.OPENAI]: [
        { name: "text-embedding-3-small (fast, good quality)", value: "text-embedding-3-small" },
        { name: "text-embedding-3-large (slower, best quality)", value: "text-embedding-3-large" },
        { name: "text-embedding-ada-002 (legacy)", value: "text-embedding-ada-002" },
    ],
    [PROVIDER_IDS.OPENROUTER]: [
        { name: "openai/text-embedding-3-small", value: "openai/text-embedding-3-small" },
        { name: "openai/text-embedding-3-large", value: "openai/text-embedding-3-large" },
        { name: "openai/text-embedding-ada-002", value: "openai/text-embedding-ada-002" },
    ],
};

/**
 * Command for configuring embedding provider
 */
export const embedCommand = new Command("embed")
    .description(
        "Configure embedding model for RAG (global by default, --project for current project)"
    )
    .option("--project", "Use project-specific configuration instead of global")
    .action(async (options) => {
        try {
            const scope: "global" | "project" = options.project ? "project" : "global";
            const projectPath = process.cwd();
            const baseDir =
                scope === "project"
                    ? configService.getProjectPath(projectPath)
                    : configService.getGlobalPath();

            if (scope === "project") {
                // Check if we're in a TENEX project
                if (!(await fileSystem.directoryExists(baseDir))) {
                    logger.error(
                        "No .tenex directory found. Make sure you're in a TENEX project directory."
                    );
                    process.exitCode = 1;
                    return;
                }
            } else {
                // Ensure global config directory exists
                await fileSystem.ensureDirectory(baseDir);
            }

            // Load existing configuration
            const existing = await EmbeddingProviderFactory.loadConfiguration({
                scope,
                projectPath: scope === "project" ? projectPath : undefined,
            });

            // Load configured providers from providers.json
            const providersConfig = await configService.loadTenexProviders(configService.getGlobalPath());
            const configuredProviders = Object.keys(providersConfig.providers);

            // Build provider choices: local + any configured embedding-capable providers
            const providerChoices: Array<{ name: string; value: string }> = [
                { name: "Local Transformers (runs on your machine)", value: "local" },
            ];

            for (const providerId of EMBEDDING_CAPABLE_PROVIDERS) {
                if (configuredProviders.includes(providerId)) {
                    const displayName = PROVIDER_DISPLAY_NAMES[providerId] || providerId;
                    providerChoices.push({
                        name: `${displayName} (configured)`,
                        value: providerId,
                    });
                }
            }

            // Prompt for provider selection
            const { provider } = await inquirer.prompt([
                {
                    type: "select",
                    name: "provider",
                    message: "Select embedding provider:",
                    choices: providerChoices,
                    default: existing?.provider || "local",
                },
            ]);

            let model: string;

            if (provider !== "local") {
                // OpenAI-compatible provider configuration
                const displayName = PROVIDER_DISPLAY_NAMES[provider] || provider;
                const modelChoices = EMBEDDING_MODELS[provider] || [
                    { name: "Enter custom model ID", value: "custom" },
                ];

                // Add custom model option if not already present
                if (!modelChoices.some((c) => c.value === "custom")) {
                    modelChoices.push({ name: "Enter custom model ID", value: "custom" });
                }

                const providerAnswers = await inquirer.prompt([
                    {
                        type: "select",
                        name: "model",
                        message: `Select ${displayName} embedding model:`,
                        choices: modelChoices,
                        default: existing?.provider === provider ? existing?.model : modelChoices[0]?.value,
                    },
                ]);

                if (providerAnswers.model === "custom") {
                    const customAnswer = await inquirer.prompt([
                        {
                            type: "input",
                            name: "customModel",
                            message: "Enter model ID:",
                            validate: (input: string) =>
                                input.trim().length > 0 || "Model ID cannot be empty",
                        },
                    ]);
                    model = customAnswer.customModel;
                } else {
                    model = providerAnswers.model;
                }
            } else {
                // Local transformer configuration
                const localAnswers = await inquirer.prompt([
                    {
                        type: "select",
                        name: "model",
                        message: "Select local embedding model:",
                        choices: [
                            {
                                name: "all-MiniLM-L6-v2 (default, fast, good for general use)",
                                value: "Xenova/all-MiniLM-L6-v2",
                            },
                            {
                                name: "all-mpnet-base-v2 (larger, better quality)",
                                value: "Xenova/all-mpnet-base-v2",
                            },
                            {
                                name: "paraphrase-multilingual-MiniLM-L12-v2 (multilingual support)",
                                value: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
                            },
                            {
                                name: "Custom model (enter HuggingFace model ID)",
                                value: "custom",
                            },
                        ],
                        default: existing?.model || "Xenova/all-MiniLM-L6-v2",
                    },
                ]);

                if (localAnswers.model === "custom") {
                    const customAnswer = await inquirer.prompt([
                        {
                            type: "input",
                            name: "customModel",
                            message:
                                "Enter HuggingFace model ID (e.g., sentence-transformers/all-MiniLM-L6-v2):",
                            validate: (input: string) =>
                                input.trim().length > 0 || "Model ID cannot be empty",
                        },
                    ]);
                    model = customAnswer.customModel;
                } else {
                    model = localAnswers.model;
                }
            }

            // Save configuration (API key comes from providers.json, not stored here)
            const embeddingConfig: EmbeddingConfig = {
                provider,
                model,
            };

            // Save model selection to embed.json
            await EmbeddingProviderFactory.saveConfiguration(embeddingConfig, scope, {
                projectPath: scope === "project" ? projectPath : undefined,
            });

            logger.info(
                `✅ Embedding configuration saved to ${scope} config\n` +
                    `   Provider: ${provider}\n` +
                    `   Model: ${model}`
            );
        } catch (error: unknown) {
            // Handle SIGINT (Ctrl+C) gracefully
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage?.includes("SIGINT") || errorMessage?.includes("force closed")) {
                return;
            }

            logger.error(`Failed to configure embedding model: ${error}`);
            process.exitCode = 1;
        }
    });
