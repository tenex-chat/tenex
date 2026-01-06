import * as fileSystem from "@/lib/fs";
import {
    type EmbeddingConfig,
    EmbeddingProviderFactory,
} from "@/services/rag/EmbeddingProviderFactory";
import { config as configService } from "@/services/ConfigService";
import { logger } from "@/utils/logger";
import { Command } from "commander";
import inquirer from "inquirer";

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

            // Prompt for provider selection
            const { provider } = await inquirer.prompt([
                {
                    type: "list",
                    name: "provider",
                    message: "Select embedding provider:",
                    choices: [
                        { name: "Local Transformers (runs on your machine)", value: "local" },
                        { name: "OpenAI (requires API key)", value: "openai" },
                    ],
                    default: existing?.provider || "local",
                },
            ]);

            let model: string;
            let apiKey: string | undefined;

            if (provider === "openai") {
                // OpenAI configuration
                const openaiAnswers = await inquirer.prompt([
                    {
                        type: "list",
                        name: "model",
                        message: "Select OpenAI embedding model:",
                        choices: [
                            {
                                name: "text-embedding-3-small (fast, good quality)",
                                value: "text-embedding-3-small",
                            },
                            {
                                name: "text-embedding-3-large (slower, best quality)",
                                value: "text-embedding-3-large",
                            },
                            {
                                name: "text-embedding-ada-002 (legacy)",
                                value: "text-embedding-ada-002",
                            },
                        ],
                        default: existing?.model || "text-embedding-3-small",
                    },
                    {
                        type: "input",
                        name: "apiKey",
                        message:
                            "Enter OpenAI API key (leave empty to use OPENAI_API_KEY env var):",
                        validate: (input: string) => {
                            if (!input && !process.env.OPENAI_API_KEY) {
                                return "API key required (or set OPENAI_API_KEY environment variable)";
                            }
                            return true;
                        },
                    },
                ]);

                model = openaiAnswers.model;
                apiKey = openaiAnswers.apiKey || undefined;
            } else {
                // Local transformer configuration
                const localAnswers = await inquirer.prompt([
                    {
                        type: "list",
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

            // Save configuration
            const embeddingConfig: EmbeddingConfig = {
                provider: provider as "local" | "openai",
                model,
                apiKey,
            };

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
