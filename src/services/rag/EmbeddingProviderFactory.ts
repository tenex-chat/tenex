import * as path from "node:path";
import { fileExists, readJsonFile } from "@/lib/fs";
import { config } from "@/services/ConfigService";
import { resolveApiKey } from "@/services/config/types";
import { logger } from "@/utils/logger";
import {
    type EmbeddingProvider,
    LocalTransformerEmbeddingProvider,
    OpenAIEmbeddingProvider,
} from "@/services/embedding";

/**
 * Configuration for embedding providers
 */
export interface EmbeddingConfig {
    provider: string; // "local" or any configured provider ID (openai, openrouter, etc.)
    model: string;
    apiKey?: string;
    baseUrl?: string;
}

export interface EmbeddingConfigOptions {
    /**
     * Path to the project metadata directory (e.g., ~/.tenex/projects/<dTag>)
     */
    metadataPath?: string;
    /**
     * Path to the project repository root (used to derive project .tenex path)
     */
    projectPath?: string;
    /**
     * Scope for resolution. "auto" (default) tries project then global.
     * "project" prioritizes project config but will still fall back to global defaults.
     * "global" only reads the global config.
     */
    scope?: "auto" | "project" | "global";
}

/**
 * Raw configuration as it may appear in JSON files
 * Supports both old format (string or partial object) and new format (full object)
 */
type RawEmbeddingConfig =
    | string // Old format: just model name
    | { model: string; provider?: never } // Old format: object with just model
    | { provider: string; model: string; apiKey?: string; baseUrl?: string }; // New format

function isRawEmbeddingConfig(value: unknown): value is RawEmbeddingConfig {
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

    // If provider is present, must be a string
    if ("provider" in obj && typeof obj.provider !== "string") {
        return false;
    }

    // If apiKey is present, must be string
    if ("apiKey" in obj && typeof obj.apiKey !== "string") {
        return false;
    }

    // If baseUrl is present, must be string
    if ("baseUrl" in obj && typeof obj.baseUrl !== "string") {
        return false;
    }

    return true;
}

/**
 * Factory for creating embedding providers based on configuration
 */
export class EmbeddingProviderFactory {
    private static readonly EMBED_CONFIG_FILE = "embed.json";
    private static readonly DEFAULT_CONFIG: EmbeddingConfig = {
        provider: "local",
        model: "Xenova/all-MiniLM-L6-v2",
    };

    /**
     * Base URLs for known OpenAI-compatible providers
     */
    private static readonly PROVIDER_BASE_URLS: Record<string, string> = {
        openai: "https://api.openai.com/v1",
        openrouter: "https://openrouter.ai/api/v1",
    };

    /**
     * Create an embedding provider based on configuration
     */
    static async create(
        customConfig?: EmbeddingConfig,
        options?: EmbeddingConfigOptions
    ): Promise<EmbeddingProvider> {
        const embeddingConfig = customConfig || (await EmbeddingProviderFactory.loadConfiguration(options));

        logger.debug(`Creating embedding provider: ${embeddingConfig.provider}/${embeddingConfig.model}`);

        // Local provider
        if (embeddingConfig.provider === "local") {
            return new LocalTransformerEmbeddingProvider(embeddingConfig.model);
        }

        // All other providers are treated as OpenAI-compatible
        if (!embeddingConfig.apiKey) {
            throw new Error(
                `API key required for ${embeddingConfig.provider}. Configure with 'tenex setup embed'.`
            );
        }

        const baseUrl = embeddingConfig.baseUrl ||
            EmbeddingProviderFactory.PROVIDER_BASE_URLS[embeddingConfig.provider] ||
            "https://api.openai.com/v1";

        return new OpenAIEmbeddingProvider(embeddingConfig.apiKey, embeddingConfig.model, baseUrl);
    }

    /**
     * Load embedding configuration using configured paths.
     * If a project path is provided, project config is tried first, then global.
     * If no paths are provided, falls back to CWD project path (legacy) and then global.
     */
    static async loadConfiguration(options?: EmbeddingConfigOptions): Promise<EmbeddingConfig> {
        try {
            const basePaths = EmbeddingProviderFactory.resolveConfigBases(options);

            for (const basePath of basePaths) {
                const configPath = path.join(basePath, EmbeddingProviderFactory.EMBED_CONFIG_FILE);
                if (!(await fileExists(configPath))) continue;

                const rawConfig = await readJsonFile<unknown>(configPath);
                if (!isRawEmbeddingConfig(rawConfig)) {
                    logger.warn(`Invalid embedding config at ${configPath}, using defaults`);
                    return EmbeddingProviderFactory.DEFAULT_CONFIG;
                }

                logger.debug(`Loaded embedding config from ${configPath}`);
                return await EmbeddingProviderFactory.parseConfig(rawConfig);
            }

            logger.debug("No embedding configuration found, using defaults");
            return EmbeddingProviderFactory.DEFAULT_CONFIG;
        } catch (error) {
            logger.warn("Failed to load embedding configuration, using defaults", { error });
            return EmbeddingProviderFactory.DEFAULT_CONFIG;
        }
    }

    /**
     * Load provider credentials from providers.json
     */
    private static async loadProviderCredentials(providerId: string): Promise<{ apiKey?: string; baseUrl?: string }> {
        try {
            const globalPath = config.getGlobalPath();
            const providersConfig = await config.loadTenexProviders(globalPath);
            const providerCreds = providersConfig.providers[providerId];
            return {
                apiKey: resolveApiKey(providerCreds?.apiKey),
                baseUrl: providerCreds?.baseUrl,
            };
        } catch (error) {
            logger.debug(`Failed to load provider credentials for ${providerId}`, { error });
            return {};
        }
    }

    /**
     * Parse and validate embedding configuration
     */
    private static async parseConfig(raw: RawEmbeddingConfig): Promise<EmbeddingConfig> {
        // Support both old format (just model string) and new format
        if (typeof raw === "string" || (raw?.model && !raw.provider)) {
            // Old format or just model specified
            const modelId = typeof raw === "string" ? raw : raw.model;

            // Infer provider from model name
            if (modelId.includes("text-embedding")) {
                const creds = await EmbeddingProviderFactory.loadProviderCredentials("openai");
                return {
                    provider: "openai",
                    model: modelId,
                    apiKey: creds.apiKey,
                    baseUrl: creds.baseUrl,
                };
            }

            return {
                provider: "local",
                model: modelId,
            };
        }

        // New format with explicit provider
        const rawConfig = raw as { provider?: string; model?: string; apiKey?: string; baseUrl?: string };
        const provider = rawConfig.provider || "local";

        // Load credentials from providers.json if not provided inline
        let apiKey = rawConfig.apiKey;
        let baseUrl = rawConfig.baseUrl;

        if (provider !== "local" && !apiKey) {
            const creds = await EmbeddingProviderFactory.loadProviderCredentials(provider);
            apiKey = creds.apiKey;
            baseUrl = baseUrl || creds.baseUrl;
        }

        return {
            provider,
            model: rawConfig.model || EmbeddingProviderFactory.DEFAULT_CONFIG.model,
            apiKey,
            baseUrl,
        };
    }

    /**
     * Save embedding configuration
     */
    static async saveConfiguration(
        embeddingConfig: EmbeddingConfig,
        scope: "global" | "project" = "global",
        options?: EmbeddingConfigOptions
    ): Promise<void> {
        const basePath =
            scope === "global"
                ? config.getGlobalPath()
                : EmbeddingProviderFactory.resolveProjectBase(options) ||
                  config.getProjectPath(process.cwd());

        const configPath = path.join(basePath, EmbeddingProviderFactory.EMBED_CONFIG_FILE);

        // Don't save API key to file - it's stored in providers.json
        const configToSave: { provider: string; model: string; baseUrl?: string } = {
            provider: embeddingConfig.provider,
            model: embeddingConfig.model,
        };

        // Only save baseUrl if it's a custom one (not the default for the provider)
        const defaultBaseUrl = EmbeddingProviderFactory.PROVIDER_BASE_URLS[embeddingConfig.provider];
        if (embeddingConfig.baseUrl && embeddingConfig.baseUrl !== defaultBaseUrl) {
            configToSave.baseUrl = embeddingConfig.baseUrl;
        }

        const { writeJsonFile, ensureDirectory } = await import("@/lib/fs");
        await ensureDirectory(basePath);
        await writeJsonFile(configPath, configToSave);

        logger.info(
            `Embedding configuration saved to ${scope} config: ${embeddingConfig.provider}/${embeddingConfig.model}`
        );
    }

    private static resolveConfigBases(options?: EmbeddingConfigOptions): string[] {
        const scope = options?.scope ?? "auto";
        const bases: string[] = [];

        if (scope !== "global") {
            const projectBase = EmbeddingProviderFactory.resolveProjectBase(options);
            if (projectBase) {
                bases.push(projectBase);
            } else if (!options) {
                // Legacy fallback to current working directory
                bases.push(config.getProjectPath(process.cwd()));
            }
        }

        // Always append global as fallback/default
        bases.push(config.getGlobalPath());
        return bases;
    }

    private static resolveProjectBase(options?: EmbeddingConfigOptions): string | undefined {
        if (options?.metadataPath) {
            return options.metadataPath;
        }
        if (options?.projectPath) {
            return config.getProjectPath(options.projectPath);
        }
        return undefined;
    }
}
