import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_FILE, LLMS_FILE, MCP_CONFIG_FILE, TENEX_DIR } from "@/constants";
import { ensureDirectory, fileExists, readJsonFile, writeJsonFile } from "@/lib/fs";
import { llmServiceFactory } from "@/llm/LLMServiceFactory";
import { MetaModelResolver } from "@/llm/meta";
import type { MCPConfig } from "@/llm/providers/types";
import type { LLMService } from "@/llm/service";
import type {
    ConfigFile,
    LLMConfiguration,
    LoadedConfig,
    MetaModelConfiguration,
    TenexConfig,
    TenexLLMs,
    TenexMCP,
} from "@/services/config/types";
import { isMetaModelConfiguration, TenexConfigSchema, TenexLLMsSchema, TenexMCPSchema } from "@/services/config/types";
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
     * Get a path under the global ~/.tenex directory
     * @param subdir Optional subdirectory (e.g., "agents", "daemon")
     * @returns Full path to the directory or subdirectory
     */
    getConfigPath(subdir?: TenexSubdir | string): string {
        const basePath = path.join(os.homedir(), TENEX_DIR);
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
            : path.join(os.homedir(), "tenex");
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

        // Load global LLMs only (no project-level llms.json)
        const llms = await this.loadTenexLLMs(globalPath);

        // Load MCP (merge global and project metadata path)
        const globalMCP = await this.loadTenexMCP(globalPath);
        const projectMCP = metadataPath
            ? await this.loadTenexMCP(metadataPath)
            : { servers: {}, enabled: true };
        const mcp: TenexMCP = {
            servers: { ...globalMCP.servers, ...projectMCP.servers },
            enabled: projectMCP.enabled !== undefined ? projectMCP.enabled : globalMCP.enabled,
        };

        const loadedConfig = { config, llms, mcp };
        this.loadedConfig = loadedConfig;

        // Initialize the LLM factory with provider configs and global settings
        await llmServiceFactory.initializeProviders(llms.providers, {
            enableTenexTools: config.claudeCode?.enableTenexTools,
        });

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
            providers: {},
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

    // =====================================================================================
    // LLM SERVICE CREATION
    // =====================================================================================

    /**
     * Get LLM configuration by name.
     * If the configuration is a meta model, automatically resolves to the default variant.
     * Use resolveMetaModel() for keyword-based variant selection.
     */
    getLLMConfig(configName?: string): LLMConfiguration {
        if (!this.loadedConfig) {
            throw new Error("Config not loaded. Call loadConfig() first.");
        }

        // If configName is "default" or not provided, use the actual default from config
        let name = configName;
        if (!name || name === "default") {
            name = this.loadedConfig.llms.default;
            if (!name) {
                // If no default is configured, try to use the first available configuration
                const available = Object.keys(this.loadedConfig.llms.configurations);
                if (available.length > 0) {
                    name = available[0];
                    logger.warn(`No default LLM configured, using first available: ${name}`);
                } else {
                    throw new Error("No LLM configurations available");
                }
            }
        }

        // Try to get the configuration
        let config = this.loadedConfig.llms.configurations[name];

        // If configuration not found, fallback to default
        if (!config && name !== this.loadedConfig.llms.default) {
            const defaultName = this.loadedConfig.llms.default;
            if (defaultName) {
                logger.warn(
                    `LLM configuration "${name}" not found, falling back to default: ${defaultName}`
                );
                config = this.loadedConfig.llms.configurations[defaultName];

                // If even the default isn't found, try first available
                if (!config) {
                    const available = Object.keys(this.loadedConfig.llms.configurations);
                    if (available.length > 0) {
                        logger.warn(
                            `Default configuration "${defaultName}" not found, using first available: ${available[0]}`
                        );
                        config = this.loadedConfig.llms.configurations[available[0]];
                    }
                }
            }
        }

        // If still no config found, throw error
        if (!config) {
            const available = Object.keys(this.loadedConfig.llms.configurations);
            throw new Error(
                `No valid LLM configuration found. Requested: "${configName || "default"}". ` +
                    `Available: ${available.length > 0 ? available.join(", ") : "none"}`
            );
        }

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
        if (!this.loadedConfig) {
            throw new Error("Config not loaded. Call loadConfig() first.");
        }

        // If configName is "default" or not provided, use the actual default from config
        let name = configName;
        if (!name || name === "default") {
            name = this.loadedConfig.llms.default;
            if (!name) {
                const available = Object.keys(this.loadedConfig.llms.configurations);
                if (available.length > 0) {
                    name = available[0];
                } else {
                    throw new Error("No LLM configurations available");
                }
            }
        }

        const config = this.loadedConfig.llms.configurations[name];
        if (!config) {
            throw new Error(`LLM configuration "${name}" not found`);
        }

        return config;
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

        try {
            if (!(await fileExists(filePath))) {
                logger.debug(`Config file not found, using default: ${filePath}`);
                return defaultValue;
            }

            const data = await readJsonFile(filePath);
            const validated = schema.parse(data);

            this.addToCache(filePath, validated);
            return validated;
        } catch (error) {
            logger.error(`Failed to load config file: ${filePath}`, {
                error: formatAnyError(error),
            });
            return defaultValue;
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
