import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_FILE, LLMS_FILE, MCP_CONFIG_FILE, TENEX_DIR } from "@/constants";
import { ensureDirectory, fileExists, readJsonFile, writeJsonFile } from "@/lib/fs";
import { llmServiceFactory } from "@/llm/LLMServiceFactory";
import type { LLMService } from "@/llm/service";
import type { LLMLogger } from "@/logging/LLMLogger";
import type {
    ConfigFile,
    LLMConfiguration,
    LoadedConfig,
    TenexConfig,
    TenexLLMs,
    TenexMCP,
} from "@/services/config/types";
import { TenexConfigSchema, TenexLLMsSchema, TenexMCPSchema } from "@/services/config/types";
import { formatAnyError } from "@/utils/error-formatter";
import { logger } from "@/utils/logger";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import type { z } from "zod";

/**
 * Centralized configuration service for TENEX
 * Handles loading and saving of all configuration files
 * Pure file operations with validation - no business logic
 */
export class ConfigService {
    private static instance: ConfigService;
    private cache = new Map<string, { data: unknown; timestamp: number }>();
    private loadedConfig?: LoadedConfig;

    private constructor() {}

    static getInstance(): ConfigService {
        if (!ConfigService.instance) {
            ConfigService.instance = new ConfigService();
        }
        return ConfigService.instance;
    }

    // =====================================================================================
    // PATH UTILITIES
    // =====================================================================================

    getGlobalPath(): string {
        return path.join(os.homedir(), TENEX_DIR);
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

    async loadConfig(projectPath?: string): Promise<LoadedConfig> {
        const globalPath = this.getGlobalPath();
        const projPath = projectPath ? this.getProjectPath(projectPath) : undefined;

        // Load global config
        const globalConfig = await this.loadTenexConfig(globalPath);

        // Load project config if provided
        let projectConfig: TenexConfig = {};
        if (projPath) {
            projectConfig = await this.loadTenexConfig(projPath);
        }

        // Merge configs (project overrides global)
        const config: TenexConfig = {
            ...globalConfig,
            ...projectConfig,
            // Merge arrays properly
            whitelistedPubkeys: [
                ...(globalConfig.whitelistedPubkeys || []),
                ...(projectConfig.whitelistedPubkeys || []),
            ],
        };

        // No longer loading agents from config files

        // Load LLMs (merge global and project)
        const globalLLMs = await this.loadTenexLLMs(globalPath);
        const projectLLMs = projPath
            ? await this.loadTenexLLMs(projPath)
            : { providers: {}, configurations: {}, default: undefined };
        const llms: TenexLLMs = {
            providers: { ...globalLLMs.providers, ...projectLLMs.providers },
            configurations: { ...globalLLMs.configurations, ...projectLLMs.configurations },
            default: projectLLMs.default ?? globalLLMs.default,
        };

        // Load MCP (merge global and project)
        const globalMCP = await this.loadTenexMCP(globalPath);
        const projectMCP = projPath
            ? await this.loadTenexMCP(projPath)
            : { servers: {}, enabled: true };
        const mcp: TenexMCP = {
            servers: { ...globalMCP.servers, ...projectMCP.servers },
            enabled: projectMCP.enabled !== undefined ? projectMCP.enabled : globalMCP.enabled,
        };

        const loadedConfig = { config, llms, mcp };
        this.loadedConfig = loadedConfig;

        // Initialize the LLM factory with provider configs
        await llmServiceFactory.initializeProviders(llms.providers);

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
     * Get LLM configuration by name
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

        return config;
    }

    /**
     * Create an LLM service for a named configuration
     */
    createLLMService(
        llmLogger: LLMLogger,
        configName?: string,
        context?: {
            tools?: Record<string, unknown>;
            agentName?: string;
            projectPath?: string;
        }
    ): LLMService {
        const config = this.getLLMConfig(configName);
        return llmServiceFactory.createService(llmLogger, config, context);
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

    async saveProjectConfig(projectPath: string, config: TenexConfig): Promise<void> {
        const projPath = this.getProjectPath(projectPath);
        await ensureDirectory(projPath);
        await this.saveTenexConfig(projPath, config);
    }

    async saveGlobalLLMs(llms: TenexLLMs): Promise<void> {
        const globalPath = this.getGlobalPath();
        await ensureDirectory(globalPath);
        await this.saveTenexLLMs(globalPath, llms);
    }

    async saveProjectLLMs(projectPath: string, llms: TenexLLMs): Promise<void> {
        const projPath = this.getProjectPath(projectPath);
        await ensureDirectory(projPath);
        await this.saveTenexLLMs(projPath, llms);
    }

    async saveGlobalMCP(mcp: TenexMCP): Promise<void> {
        const globalPath = this.getGlobalPath();
        await ensureDirectory(globalPath);
        await this.saveTenexMCP(globalPath, mcp);
    }

    async saveProjectMCP(projectPath: string, mcp: TenexMCP): Promise<void> {
        const projPath = this.getProjectPath(projectPath);
        await ensureDirectory(projPath);
        await this.saveTenexMCP(projPath, mcp);
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

    async projectConfigExists(projectPath: string, configFile: ConfigFile): Promise<boolean> {
        return this.configExists(this.getProjectPath(projectPath), configFile);
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

// Export singleton instance
export const configService = ConfigService.getInstance();
