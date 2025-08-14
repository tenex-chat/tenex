import * as os from "node:os";
import * as path from "node:path";
import { ensureDirectory, fileExists, readJsonFile, writeJsonFile } from "@/lib/fs";
import type {
    ConfigFile,
    LoadedConfig,
    TenexAgents,
    TenexConfig,
    TenexLLMs,
    TenexMCP,
} from "@/services/config/types";
import {
    TenexAgentsSchema,
    TenexConfigSchema,
    TenexLLMsSchema,
    TenexMCPSchema,
} from "@/services/config/types";
import { logger } from "@/utils/logger";
import { TENEX_DIR, CONFIG_FILE, MCP_CONFIG_FILE, AGENTS_FILE, LLMS_FILE } from "@/constants";
import type { z } from "zod";

/**
 * Centralized configuration service for TENEX
 * Handles loading and saving of all configuration files
 * Pure file operations with validation - no business logic
 */
export class ConfigService {
    private static instance: ConfigService;
    private cache = new Map<string, { data: unknown; timestamp: number }>();
    private readonly CACHE_TTL_MS = 5000; // 5 seconds
    private readonly cacheTTL = this.CACHE_TTL_MS; // Keep for backwards compatibility

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

    private getConfigFilePath(basePath: string, configFile: ConfigFile): string {
        return path.join(basePath, configFile);
    }

    // =====================================================================================
    // COMPLETE CONFIGURATION LOADING
    // =====================================================================================

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

        // Load agents (merge global and project)
        const globalAgents = await this.loadTenexAgents(globalPath);
        const projectAgents = projPath ? await this.loadTenexAgents(projPath) : {};
        const agents: TenexAgents = { ...globalAgents, ...projectAgents };

        // Load LLMs (merge global and project)
        const globalLLMs = await this.loadTenexLLMs(globalPath);
        const projectLLMs = projPath
            ? await this.loadTenexLLMs(projPath)
            : { configurations: {}, defaults: {}, credentials: {} };
        const llms: TenexLLMs = {
            configurations: { ...globalLLMs.configurations, ...projectLLMs.configurations },
            defaults: { ...globalLLMs.defaults, ...projectLLMs.defaults },
            credentials: { ...globalLLMs.credentials, ...projectLLMs.credentials },
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

        return { config, agents, llms, mcp };
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

    async loadTenexAgents(basePath: string): Promise<TenexAgents> {
        return this.loadConfigFile(
            this.getConfigFilePath(basePath, AGENTS_FILE),
            TenexAgentsSchema,
            {}
        );
    }

    async loadTenexLLMs(basePath: string): Promise<TenexLLMs> {
        return this.loadConfigFile(this.getConfigFilePath(basePath, LLMS_FILE), TenexLLMsSchema, {
            configurations: {},
            defaults: {},
            credentials: {},
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

    async saveTenexAgents(basePath: string, agents: TenexAgents): Promise<void> {
        await this.saveConfigFile(
            this.getConfigFilePath(basePath, AGENTS_FILE),
            agents,
            TenexAgentsSchema
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
    // BUSINESS LOGIC METHODS
    // =====================================================================================

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

    async saveGlobalAgents(agents: TenexAgents): Promise<void> {
        const globalPath = this.getGlobalPath();
        await ensureDirectory(globalPath);
        await this.saveTenexAgents(globalPath, agents);
    }

    async loadProjectAgents(projectPath: string): Promise<TenexAgents> {
        const projPath = this.getProjectPath(projectPath);
        return this.loadTenexAgents(projPath);
    }

    async saveProjectAgents(projectPath: string, agents: TenexAgents): Promise<void> {
        const projPath = this.getProjectPath(projectPath);
        await ensureDirectory(projPath);
        await this.saveTenexAgents(projPath, agents);
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
            return validated as T;
        } catch (error) {
            logger.error(`Failed to load config file: ${filePath}`, { error });
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
            logger.error(`Failed to save config file: ${filePath}`, { error });
            throw error;
        }
    }

    private getFromCache<T>(filePath: string): T | null {
        const entry = this.cache.get(filePath);
        if (!entry) {
            return null;
        }

        const now = Date.now();
        if (now - entry.timestamp > this.cacheTTL) {
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
