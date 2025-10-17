import * as os from "node:os";
import * as path from "node:path";
import * as fileSystem from "@/lib/fs";
import { EmbeddingProviderFactory, type EmbeddingConfig } from "@/services/rag/EmbeddingProviderFactory";
import { logger } from "@/utils/logger";
import { Command } from "commander";
import inquirer from "inquirer";

const EMBED_CONFIG_FILE = "embed.json";

/**
 * Raw configuration as it may appear in JSON files
 * Supports both old format (string or partial object) and new format (full object)
 */
type RawEmbedConfig = 
    | string // Old format: just model name
    | { model: string; provider?: never } // Old format: object with just model
    | { provider: "local" | "openai"; model: string; apiKey?: string }; // New format

function isRawEmbedConfig(value: unknown): value is RawEmbedConfig {
    if (typeof value === "string") {
        return true;
    }
    
    if (typeof value !== "object" || value === null) {
        return false;
    }
    
    const obj = value as Record<string, unknown>;
    
    // Must have a model
    if (!("model" in obj) || typeof obj.model !== "string") {
        return false;
    }
    
    // If provider is present, must be valid
    if ("provider" in obj) {
        if (obj.provider !== "local" && obj.provider !== "openai") {
            return false;
        }
    }
    
    // If apiKey is present, must be string
    if ("apiKey" in obj && typeof obj.apiKey !== "string") {
        return false;
    }
    
    return true;
}

/**
 * Load existing embedding configuration
 */
async function loadEmbedConfig(dir: string): Promise<EmbeddingConfig | null> {
    const filePath = path.join(dir, EMBED_CONFIG_FILE);
    if (await fileSystem.fileExists(filePath)) {
        const config = await fileSystem.readJsonFile<unknown>(filePath);
        if (!isRawEmbedConfig(config)) {
            logger.warn(`Invalid embed config at ${filePath}, ignoring`);
            return null;
        }
        return parseEmbedConfig(config);
    }
    return null;
}

/**
 * Parse raw config into EmbeddingConfig
 */
function parseEmbedConfig(raw: RawEmbedConfig): EmbeddingConfig {
    // Support both old format (just model string) and new format
    if (typeof raw === "string") {
        return {
            provider: "local",
            model: raw
        };
    }
    
    if (raw.model && !raw.provider) {
        // Infer provider from model name
        const model = raw.model;
        if (model.includes("text-embedding")) {
            return {
                provider: "openai",
                model: model
            };
        }
        return {
            provider: "local",
            model: model
        };
    }
    
    return {
        provider: raw.provider || "local",
        model: raw.model || "Xenova/all-MiniLM-L6-v2"
    };
}

/**
 * Command for configuring embedding provider
 */
export const embedCommand = new Command("embed")
    .description("Configure embedding model for RAG (global by default, --project for current project)")
    .option("--project", "Use project-specific configuration instead of global")
    .action(async (options) => {
        try {
            let configDir: string;
            let isGlobal: boolean;
            
            if (options.project) {
                // Project-specific configuration
                const projectPath = process.cwd();
                
                // Check if we're in a TENEX project
                if (!(await fileSystem.directoryExists(path.join(projectPath, ".tenex")))) {
                    logger.error("No .tenex directory found. Make sure you're in a TENEX project directory.");
                    process.exit(1);
                }
                
                configDir = path.join(projectPath, ".tenex");
                isGlobal = false;
            } else {
                // Global configuration
                configDir = path.join(os.homedir(), ".tenex");
                
                // Ensure global config directory exists
                await fileSystem.ensureDirectory(configDir);
                isGlobal = true;
            }
            
            // Load existing configuration
            const existing = await loadEmbedConfig(configDir);
            
            // Prompt for provider selection
            const { provider } = await inquirer.prompt([
                {
                    type: "list",
                    name: "provider",
                    message: "Select embedding provider:",
                    choices: [
                        { name: "Local Transformers (runs on your machine)", value: "local" },
                        { name: "OpenAI (requires API key)", value: "openai" }
                    ],
                    default: existing?.provider || "local"
                }
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
                            { name: "text-embedding-3-small (fast, good quality)", value: "text-embedding-3-small" },
                            { name: "text-embedding-3-large (slower, best quality)", value: "text-embedding-3-large" },
                            { name: "text-embedding-ada-002 (legacy)", value: "text-embedding-ada-002" }
                        ],
                        default: existing?.model || "text-embedding-3-small"
                    },
                    {
                        type: "input",
                        name: "apiKey",
                        message: "Enter OpenAI API key (leave empty to use OPENAI_API_KEY env var):",
                        validate: (input: string) => {
                            if (!input && !process.env.OPENAI_API_KEY) {
                                return "API key required (or set OPENAI_API_KEY environment variable)";
                            }
                            return true;
                        }
                    }
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
                                value: "Xenova/all-MiniLM-L6-v2" 
                            },
                            { 
                                name: "all-mpnet-base-v2 (larger, better quality)", 
                                value: "Xenova/all-mpnet-base-v2" 
                            },
                            { 
                                name: "paraphrase-multilingual-MiniLM-L12-v2 (multilingual support)", 
                                value: "Xenova/paraphrase-multilingual-MiniLM-L12-v2" 
                            },
                            {
                                name: "Custom model (enter HuggingFace model ID)",
                                value: "custom"
                            }
                        ],
                        default: existing?.model || "Xenova/all-MiniLM-L6-v2"
                    }
                ]);
                
                if (localAnswers.model === "custom") {
                    const customAnswer = await inquirer.prompt([
                        {
                            type: "input",
                            name: "customModel",
                            message: "Enter HuggingFace model ID (e.g., sentence-transformers/all-MiniLM-L6-v2):",
                            validate: (input: string) => input.trim().length > 0 || "Model ID cannot be empty"
                        }
                    ]);
                    model = customAnswer.customModel;
                } else {
                    model = localAnswers.model;
                }
            }
            
            // Save configuration
            const config: EmbeddingConfig = {
                provider: provider as "local" | "openai",
                model,
                apiKey
            };
            
            await EmbeddingProviderFactory.saveConfiguration(
                config, 
                isGlobal ? "global" : "project"
            );
            
            logger.info(
                `✅ Embedding configuration saved to ${isGlobal ? "global" : "project"} config\n` +
                `   Provider: ${provider}\n` +
                `   Model: ${model}`
            );
            
        } catch (error: unknown) {
            // Handle SIGINT (Ctrl+C) gracefully
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage?.includes("SIGINT") || errorMessage?.includes("force closed")) {
                process.exit(0);
            }
            
            logger.error(`Failed to configure embedding model: ${error}`);
            process.exit(1);
        }
    });