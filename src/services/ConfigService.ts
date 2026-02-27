import { homedir } from "node:os";
import * as path from "node:path";
import { CONFIG_FILE, LLMS_FILE, MCP_CONFIG_FILE, PROVIDERS_FILE, TENEX_DIR, getTenexBasePath } from "@/constants";
import { ensureDirectory, fileExists, readJsonFile, writeJsonFile } from "@/lib/fs";
import { llmServiceFactory } from "@/llm/LLMServiceFactory";
import { MetaModelResolver } from "@/llm/meta";
import { ensureCacheLoaded as ensureModelsDevCacheLoaded } from "@/llm/utils/models-dev-cache";
import type { MCPConfig } from "@/llm/providers/types";
import type { LLMService } from "@/llm/service";
import type { OnStreamStartCallback } from "@/llm/types";
import type {
    ConfigFile,
    LLMConfiguration,
    LoadedConfig,
    MetaModelConfiguration,
    TenexConfig,
    TenexLLMs,
    TenexMCP,
    TenexProviders,
} from "@/services/config/types";
import { isMetaModelConfiguration, TenexConfigSchema, TenexLLMsSchema, TenexMCPSchema, TenexProvidersSchema } from "@/services/config/types";
import { formatAnyError } from "@/lib/error-formatter";
import { logger } from "@/utils/logger";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import type { z } from "zod";

/**
 * Result of resolving a meta model configuration
 */
export interface MetaModelResolutionResult {
    /** The resolved LLM configuration to use */
    config: LLMConfiguration;
    /** The resolved configuration name */
    configName: string;
    /** The message with keywords stripped (if applicable) */
    strippedMessage?: string;
    /** Additional system prompt to inject from the variant */
    variantSystemPrompt?: string;
    /** System prompt fragment describing available variants */
    metaModelSystemPrompt?: string;
    /** Whether this was a meta model resolution */
    isMetaModel: boolean;
    /** The variant name that was selected (if meta model) */
    variantName?: string;
}

/**
 * Subdirectory paths under ~/.tenex
 */
export type TenexSubdir =
    | "agents"
    | "daemon"
    | "conversations"
    | "data"
    | "projects"
    | "tool-messages";

/**
 * Centralized configuration service for TENEX
 * Handles loading and saving of all configuration files
 * All configurations are stored in ~/.tenex
 */
export class ConfigService {
    private cache = new Map<string, { data: unknown; timestamp: number }>();
    private loadedConfig?: LoadedConfig;

    // =====================================================================================
    // PATH UTILITIES
    // =====================================================================================

    /**
     * Get a path under the global TENEX directory (defaults to ~/.tenex)
     * Respects TENEX_BASE_DIR environment variable for instance isolation.
     * @param subdir Optional subdirectory (e.g., "agents", "daemon")
     * @returns Full path to the directory or subdirectory
     */
    getConfigPath(subdir?: TenexSubdir | string): string {
        const basePath = getTenexBasePath();
        return subdir ? path.join(basePath, subdir) : basePath;
    }

    getGlobalPath(): string {
        return this.getConfigPath();
    }

    getProjectPath(projectPath: string): string {
        return path.join(projectPath, TENEX_DIR);
    }

    /**
     * Get the base directory for all projects
     * Defaults to ~/tenex if not configured
     */
    getProjectsBase(): string {
        const config = this.loadedConfig?.config;
        return config?.projectsBase
            ? path.resolve(config.projectsBase)
            : path.join(homedir(), "tenex");
    }

    private getConfigFilePath(basePath: string, configFile: ConfigFile): string {
        return path.join(basePath, configFile);
    }

    // =====================================================================================
    // COMPLETE CONFIGURATION LOADING
    // =====================================================================================

    /**
     * Get the currently loaded config
     */
    getConfig(): TenexConfig {
        if (!this.loadedConfig) {
            throw new Error("Config not loaded. Call loadConfig() first.");
        }
        return this.loadedConfig.config;
    }

    getMCP(): TenexMCP {
        if (!this.loadedConfig) {
            throw new Error("Config not loaded. Call loadConfig() first.");
        }
        return this.loadedConfig.mcp;
    }

    /**
     * Load all TENEX configuration
     * @param metadataPath Optional project metadata path (~/.tenex/projects/{dTag}) for project MCP config
     */
    async loadConfig(metadataPath?: string): Promise<LoadedConfig> {
        const globalPath = this.getGlobalPath();

        // Load global config only (no project-level config.json)
        const config = await this.loadTenexConfig(globalPath);

        // Load providers from providers.json
        const providers = await this.loadTenexProviders(globalPath);

        // Load global LLMs only (no project-level llms.json)
        const llms = await this.loadTenexLLMs(globalPath);

        // Validate provider references
        this.validateProviderReferences(llms, providers);

        // Load MCP (merge global and project metadata path)
        const globalMCP = await this.loadTenexMCP(globalPath);
        const projectMCP = metadataPath
            ? await this.loadTenexMCP(metadataPath)
            : { servers: {}, enabled: true };
        const mcp: TenexMCP = {
            servers: { ...globalMCP.servers, ...projectMCP.servers },
            enabled: projectMCP.enabled !== undefined ? projectMCP.enabled : globalMCP.enabled,
        };

        const loadedConfig = { config, llms, mcp, providers };
        this.loadedConfig = loadedConfig;

        // Initialize the LLM factory with provider configs and global settings
        await llmServiceFactory.initializeProviders(providers.providers);

        // Load models.dev cache for model metadata (context windows, output limits)
        await ensureModelsDevCacheLoaded();

        return loadedConfig;
    }

    // =====================================================================================
    // INDIVIDUAL FILE LOADING
    // =====================================================================================

    async loadTenexConfig(basePath: string): Promise<TenexConfig> {
        return this.loadConfigFile(
            this.getConfigFilePath(basePath, CONFIG_FILE),
            TenexConfigSchema,
            {}
        );
    }

    async loadTenexLLMs(basePath: string): Promise<TenexLLMs> {
        return this.loadConfigFile(this.getConfigFilePath(basePath, LLMS_FILE), TenexLLMsSchema, {
            configurations: {},
            default: undefined,
        });
    }

    async loadTenexMCP(basePath: string): Promise<TenexMCP> {
        const result = await this.loadConfigFile(
            this.getConfigFilePath(basePath, MCP_CONFIG_FILE),
            TenexMCPSchema,
            {
                servers: {},
                enabled: true,
            }
        );
        // Ensure servers is always defined
        return {
            servers: result.servers || {},
            enabled: result.enabled ?? true,
        };
    }

    async loadTenexProviders(basePath: string): Promise<TenexProviders> {
        return this.loadConfigFile(
            this.getConfigFilePath(basePath, PROVIDERS_FILE),
            TenexProvidersSchema,
            { providers: {} }
        );
    }

    // =====================================================================================
    // INDIVIDUAL FILE SAVING
    // =====================================================================================

    async saveTenexConfig(basePath: string, config: TenexConfig): Promise<void> {
        await this.saveConfigFile(
            this.getConfigFilePath(basePath, CONFIG_FILE),
            config,
            TenexConfigSchema
        );
    }

    async saveTenexLLMs(basePath: string, llms: TenexLLMs): Promise<void> {
        await this.saveConfigFile(
            this.getConfigFilePath(basePath, LLMS_FILE),
            llms,
            TenexLLMsSchema
        );
    }

    async saveTenexMCP(basePath: string, mcp: TenexMCP): Promise<void> {
        await this.saveConfigFile(
            this.getConfigFilePath(basePath, MCP_CONFIG_FILE),
            mcp,
            TenexMCPSchema
        );
    }

    async saveTenexProviders(basePath: string, providers: TenexProviders): Promise<void> {
        await this.saveConfigFile(
            this.getConfigFilePath(basePath, PROVIDERS_FILE),
            providers,
            TenexProvidersSchema
        );
    }

    // =====================================================================================
    // LLM SERVICE CREATION
    // =====================================================================================

    /**
     * Resolve a configuration name to an actual name, handling defaults and fallbacks.
     * This is the single source of truth for config name resolution logic.
     *
     * @param configName - The requested configuration name (may be undefined or "default")
     * @param options - Resolution options
     * @returns Object with resolved name and optional warning message
     */
    private resolveConfigName(
        configName: string | undefined,
        options: { allowFallback?: boolean; warnOnFallback?: boolean } = {}
    ): { name: string; warning?: string } {
        const { allowFallback = true, warnOnFallback = true } = options;

        if (!this.loadedConfig) {
            throw new Error("Config not loaded. Call loadConfig() first.");
        }

        const llms = this.loadedConfig.llms;
        const available = Object.keys(llms.configurations);

        // If configName is "default" or not provided, use the actual default from config
        let name = configName;
        if (!name || name === "default") {
            name = llms.default;
            if (!name) {
                if (available.length > 0) {
                    name = available[0];
                    if (warnOnFallback) {
                        return { name, warning: `No default LLM configured, using first available: ${name}` };
                    }
                    return { name };
                }
                throw new Error("No LLM configurations available");
            }
        }

        // Check if the requested config exists
        if (llms.configurations[name]) {
            return { name };
        }

        // Config not found - try fallback if allowed
        if (!allowFallback) {
            throw new Error(`LLM configuration "${name}" not found`);
        }

        // Try default
        const defaultName = llms.default;
        if (defaultName && llms.configurations[defaultName]) {
            const warning = warnOnFallback
                ? `LLM configuration "${name}" not found, falling back to default: ${defaultName}`
                : undefined;
            return { name: defaultName, warning };
        }

        // Try first available
        if (available.length > 0) {
            const fallbackName = available[0];
            const warning = warnOnFallback
                ? `LLM configuration "${name}" not found, using first available: ${fallbackName}`
                : undefined;
            return { name: fallbackName, warning };
        }

        throw new Error(
            `No valid LLM configuration found. Requested: "${configName || "default"}". ` +
                `Available: ${available.length > 0 ? available.join(", ") : "none"}`
        );
    }

    /**
     * Get LLM configuration by name.
     * If the configuration is a meta model, automatically resolves to the default variant.
     * Use resolveMetaModel() for keyword-based variant selection.
     */
    getLLMConfig(configName?: string): LLMConfiguration {
        const { name, warning } = this.resolveConfigName(configName, {
            allowFallback: true,
            warnOnFallback: true,
        });

        if (warning) {
            logger.warn(warning);
        }

        const loadedConfig = this.loadedConfig;
        if (!loadedConfig) {
            throw new Error("Config not loaded. Call loadConfig() first.");
        }
        const config = loadedConfig.llms.configurations[name];

        // If it's a meta model, resolve to the default variant
        if (isMetaModelConfiguration(config)) {
            const resolution = MetaModelResolver.resolve(config);
            // Recursively get the underlying config
            return this.getLLMConfig(resolution.configName);
        }

        return config;
    }

    /**
     * Get raw LLM configuration by name without type coercion.
     * Returns the configuration as stored, which may be either a standard
     * LLMConfiguration or a MetaModelConfiguration.
     */
    getRawLLMConfig(configName?: string): LLMConfiguration | MetaModelConfiguration {
        const { name } = this.resolveConfigName(configName, {
            allowFallback: false,
            warnOnFallback: false,
        });

        const loadedConfig = this.loadedConfig;
        if (!loadedConfig) {
            throw new Error("Config not loaded. Call loadConfig() first.");
        }
        return loadedConfig.llms.configurations[name];
    }

    /**
     * Get all resolved LLM configurations, skipping meta models.
     * Returns the default config first, followed by the rest in declaration order.
     */
    getAllLLMConfigs(): LLMConfiguration[] {
        if (!this.loadedConfig) {
            throw new Error("Config not loaded. Call loadConfig() first.");
        }

        const llms = this.loadedConfig.llms;
        const configs: LLMConfiguration[] = [];
        const seen = new Set<string>();

        // Default first
        if (llms.default && llms.configurations[llms.default]) {
            const config = llms.configurations[llms.default];
            if (!isMetaModelConfiguration(config)) {
                configs.push(config);
                seen.add(`${config.provider}:${config.model}`);
            }
        }

        // Then the rest, deduplicating by provider:model
        for (const config of Object.values(llms.configurations)) {
            if (isMetaModelConfiguration(config)) continue;
            const key = `${config.provider}:${config.model}`;
            if (seen.has(key)) continue;
            seen.add(key);
            configs.push(config);
        }

        return configs;
    }

    /**
     * Check if a configuration name refers to a meta model.
     */
    isMetaModelConfig(configName?: string): boolean {
        try {
            const config = this.getRawLLMConfig(configName);
            return isMetaModelConfiguration(config);
        } catch {
            return false;
        }
    }

    /**
     * Resolve a meta model configuration based on the first message or variant override.
     * If the configuration is not a meta model, returns the configuration directly.
     *
     * @param configName The configuration name to resolve
     * @param firstMessage Optional first user message for keyword detection
     * @param variantOverride Optional variant name to use (bypasses keyword detection)
     * @returns Resolution result with the actual configuration to use
     */
    resolveMetaModel(configName?: string, firstMessage?: string, variantOverride?: string): MetaModelResolutionResult {
        const rawConfig = this.getRawLLMConfig(configName);

        // If not a meta model, return as-is
        if (!isMetaModelConfiguration(rawConfig)) {
            return {
                config: rawConfig,
                configName: configName || "default",
                isMetaModel: false,
            };
        }

        // It's a meta model - resolve based on override or keywords
        const metaConfig = rawConfig as MetaModelConfiguration;

        let resolution;
        if (variantOverride) {
            // Use the override variant directly (from change_model tool)
            resolution = MetaModelResolver.resolveToVariant(metaConfig, variantOverride);
        } else {
            // Resolve based on keywords in the message
            resolution = MetaModelResolver.resolve(metaConfig, firstMessage, {
                stripKeywords: true,
            });
        }

        // Get the resolved underlying configuration
        const resolvedConfig = this.getLLMConfig(resolution.configName);

        // Generate the system prompt fragment for model descriptions
        const metaModelSystemPrompt = MetaModelResolver.generateSystemPromptFragment(metaConfig);

        logger.info("[ConfigService] Resolved meta model", {
            originalConfig: configName,
            resolvedVariant: resolution.variantName,
            resolvedConfig: resolution.configName,
            matchedKeywords: resolution.matchedKeywords,
            usedOverride: !!variantOverride,
        });

        return {
            config: resolvedConfig,
            configName: resolution.configName,
            strippedMessage: resolution.strippedMessage,
            variantSystemPrompt: resolution.systemPrompt,
            metaModelSystemPrompt,
            isMetaModel: true,
            variantName: resolution.variantName,
        };
    }

    /**
     * Create an LLM service for a named configuration
     */
    createLLMService(
        configName?: string,
        context?: {
            tools?: Record<string, unknown>;
            agentName?: string;
            /** Working directory path for Claude Code execution */
            workingDirectory?: string;
            sessionId?: string;
            /** Agent-specific MCP configuration to merge with project/global config */
            mcpConfig?: MCPConfig;
            /** Conversation ID for OpenRouter correlation */
            conversationId?: string;
            /** Callback invoked when Claude Code stream starts, providing the message injector */
            onStreamStart?: OnStreamStartCallback;
        }
    ): LLMService {
        const llmConfig = this.getLLMConfig(configName);

        // Merge agent MCP config with project/global MCP config
        // Agent config overrides project config for the same server names
        let finalMcpConfig: MCPConfig | undefined;

        if (this.loadedConfig?.mcp && context?.mcpConfig) {
            // Merge: agent config overrides project config
            finalMcpConfig = {
                enabled: context.mcpConfig.enabled ?? this.loadedConfig.mcp.enabled,
                servers: {
                    ...this.loadedConfig.mcp.servers,
                    ...context.mcpConfig.servers,
                },
            };
        } else if (context?.mcpConfig) {
            finalMcpConfig = context.mcpConfig;
        } else if (this.loadedConfig?.mcp) {
            finalMcpConfig = {
                enabled: this.loadedConfig.mcp.enabled,
                servers: this.loadedConfig.mcp.servers,
            };
        }

        return llmServiceFactory.createService(llmConfig, {
            ...context,
            mcpConfig: finalMcpConfig,
        } as Parameters<typeof llmServiceFactory.createService>[1]);
    }

    // =====================================================================================
    // BUSINESS LOGIC METHODS
    // =====================================================================================

    /**
     * Get the configured search model name if available.
     * This is a typed accessor for the search configuration.
     * @returns The search model config name or undefined if not configured
     */
    getSearchModelName(): string | undefined {
        return this.loadedConfig?.llms?.search;
    }

    /**
     * Ensures that a backend private key exists for TENEX
     * Generates a new one if not present
     */
    async ensureBackendPrivateKey(): Promise<string> {
        const globalPath = this.getGlobalPath();
        const config = await this.loadTenexConfig(globalPath);

        if (!config.tenexPrivateKey) {
            // Generate new private key
            const signer = NDKPrivateKeySigner.generate();
            config.tenexPrivateKey = signer.privateKey;

            // Save config with new key
            await this.saveGlobalConfig(config);
            logger.info("Generated new TENEX backend private key");
        }

        return config.tenexPrivateKey;
    }

    /**
     * Get the TENEX backend signer for publishing system-level events
     */
    async getBackendSigner(): Promise<NDKPrivateKeySigner> {
        const privateKey = await this.ensureBackendPrivateKey();
        return new NDKPrivateKeySigner(privateKey);
    }

    /**
     * Get whitelisted pubkeys with CLI override support
     * If CLI option is provided, it ONLY uses those pubkeys (doesn't merge with config)
     * Otherwise, returns pubkeys from the configuration
     */
    getWhitelistedPubkeys(cliOption?: string, config?: TenexConfig): string[] {
        const pubkeys: Set<string> = new Set();

        // If CLI option is provided, ONLY use those pubkeys (don't merge with config)
        if (cliOption) {
            for (const pk of cliOption.split(",")) {
                const trimmed = pk.trim();
                if (trimmed) pubkeys.add(trimmed);
            }
            return Array.from(pubkeys);
        }

        // Otherwise, use config pubkeys
        if (config?.whitelistedPubkeys) {
            if (Array.isArray(config.whitelistedPubkeys)) {
                for (const pk of config.whitelistedPubkeys) {
                    if (pk) pubkeys.add(pk);
                }
            }
        }

        return Array.from(pubkeys);
    }

    // =====================================================================================
    // CONVENIENCE METHODS
    // =====================================================================================

    async saveGlobalConfig(config: TenexConfig): Promise<void> {
        const globalPath = this.getGlobalPath();
        await ensureDirectory(globalPath);
        await this.saveTenexConfig(globalPath, config);
    }

    async saveGlobalLLMs(llms: TenexLLMs): Promise<void> {
        const globalPath = this.getGlobalPath();
        await ensureDirectory(globalPath);
        await this.saveTenexLLMs(globalPath, llms);
    }

    async saveGlobalMCP(mcp: TenexMCP): Promise<void> {
        const globalPath = this.getGlobalPath();
        await ensureDirectory(globalPath);
        await this.saveTenexMCP(globalPath, mcp);
    }

    async saveGlobalProviders(providers: TenexProviders): Promise<void> {
        const globalPath = this.getGlobalPath();
        await ensureDirectory(globalPath);
        await this.saveTenexProviders(globalPath, providers);
    }

    // =====================================================================================
    // FILE EXISTENCE CHECKS
    // =====================================================================================

    async configExists(basePath: string, configFile: ConfigFile): Promise<boolean> {
        return fileExists(this.getConfigFilePath(basePath, configFile));
    }

    async globalConfigExists(configFile: ConfigFile): Promise<boolean> {
        return this.configExists(this.getGlobalPath(), configFile);
    }

    // =====================================================================================
    // PRIVATE IMPLEMENTATION
    // =====================================================================================

    private validateProviderReferences(llms: TenexLLMs, providers: TenexProviders): void {
        const missingProviders = new Set<string>();

        for (const configValue of Object.values(llms.configurations)) {
            if (configValue.provider === "meta") continue;

            const providerName = configValue.provider;
            if (!providers.providers[providerName]) {
                missingProviders.add(providerName);
            }
        }

        if (missingProviders.size > 0) {
            logger.warn(
                `LLM configurations reference providers not in providers.json: ${Array.from(missingProviders).join(", ")}`
            );
        }
    }

    private async loadConfigFile<T>(
        filePath: string,
        schema: z.ZodSchema<T>,
        defaultValue: T
    ): Promise<T> {
        // Check cache first
        const cached = this.getFromCache<T>(filePath);
        if (cached) {
            return cached;
        }

        // Check if file exists - if not, return default (this is expected)
        if (!(await fileExists(filePath))) {
            logger.debug(`Config file not found, using default: ${filePath}`);
            return defaultValue;
        }

        // File exists - any error from here is a real problem that should propagate
        try {
            const data = await readJsonFile(filePath);
            const validated = schema.parse(data);

            this.addToCache(filePath, validated);
            return validated;
        } catch (error) {
            // File exists but is corrupt/invalid - this is a real error, not a missing file
            const errorMessage = formatAnyError(error);
            logger.error(`Config file is corrupt or invalid: ${filePath}`, {
                error: errorMessage,
            });
            throw new Error(
                `Failed to load config file "${filePath}": ${errorMessage}. ` +
                    "Fix the file or delete it to use defaults.",
                { cause: error }
            );
        }
    }

    private async saveConfigFile<T>(
        filePath: string,
        data: T,
        schema: z.ZodSchema<T>
    ): Promise<void> {
        try {
            // Ensure directory exists
            await ensureDirectory(path.dirname(filePath));

            // Validate before saving
            const validated = schema.parse(data);

            // Save to file
            await writeJsonFile(filePath, validated);

            // Update cache
            this.addToCache(filePath, validated);

            logger.debug(`Configuration saved: ${filePath}`);
        } catch (error) {
            logger.error(`Failed to save config file: ${filePath}`, {
                error: formatAnyError(error),
            });
            throw error;
        }
    }

    private getFromCache<T>(filePath: string): T | null {
        const entry = this.cache.get(filePath);
        if (!entry) {
            return null;
        }

        const now = Date.now();
        if (now - entry.timestamp > 5000) {
            // 5 seconds TTL
            this.cache.delete(filePath);
            return null;
        }

        return entry.data as T;
    }

    private addToCache<T>(filePath: string, data: T): void {
        this.cache.set(filePath, {
            data,
            timestamp: Date.now(),
        });
    }

    clearCache(filePath?: string): void {
        if (filePath) {
            this.cache.delete(filePath);
        } else {
            this.cache.clear();
        }
    }
}

// Export instance
export const config = new ConfigService();
