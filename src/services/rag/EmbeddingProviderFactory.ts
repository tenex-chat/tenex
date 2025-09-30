import { ConfigService } from '@/services/ConfigService';
import { LocalTransformerEmbeddingProvider, OpenAIEmbeddingProvider, type EmbeddingProvider } from '../EmbeddingProvider';
import { logger } from '@/utils/logger';
import * as path from 'path';
import { readJsonFile, fileExists } from '@/lib/fs';

/**
 * Configuration for embedding providers
 */
export interface EmbeddingConfig {
    provider: 'local' | 'openai';
    model: string;
    apiKey?: string;
}

/**
 * Raw configuration as it may appear in JSON files
 * Supports both old format (string or partial object) and new format (full object)
 */
type RawEmbeddingConfig = 
    | string // Old format: just model name
    | { model: string; provider?: never } // Old format: object with just model
    | { provider: 'local' | 'openai'; model: string; apiKey?: string }; // New format

function isRawEmbeddingConfig(value: unknown): value is RawEmbeddingConfig {
    if (typeof value === 'string') {
        return true;
    }
    
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    
    const obj = value as Record<string, unknown>;
    
    // Must have a model
    if (!('model' in obj) || typeof obj.model !== 'string') {
        return false;
    }
    
    // If provider is present, must be valid
    if ('provider' in obj) {
        if (obj.provider !== 'local' && obj.provider !== 'openai') {
            return false;
        }
    }
    
    // If apiKey is present, must be string
    if ('apiKey' in obj && typeof obj.apiKey !== 'string') {
        return false;
    }
    
    return true;
}

/**
 * Factory for creating embedding providers based on configuration
 */
export class EmbeddingProviderFactory {
    private static readonly EMBED_CONFIG_FILE = 'embed.json';
    private static readonly DEFAULT_CONFIG: EmbeddingConfig = {
        provider: 'local',
        model: 'Xenova/all-MiniLM-L6-v2'
    };

    /**
     * Create an embedding provider based on configuration
     */
    static async create(customConfig?: EmbeddingConfig): Promise<EmbeddingProvider> {
        const config = customConfig || await this.loadConfiguration();
        
        logger.debug(`Creating embedding provider: ${config.provider}/${config.model}`);

        switch (config.provider) {
            case 'openai':
                if (!config.apiKey) {
                    throw new Error('OpenAI API key is required for OpenAI embedding provider');
                }
                return new OpenAIEmbeddingProvider(config.apiKey, config.model);
            
            case 'local':
            default:
                return new LocalTransformerEmbeddingProvider(config.model);
        }
    }

    /**
     * Load embedding configuration from ConfigService paths
     */
    private static async loadConfiguration(): Promise<EmbeddingConfig> {
        const configService = ConfigService.getInstance();
        
        try {
            // Try project config first
            const projectPath = process.cwd();
            const projectConfigPath = path.join(
                configService.getProjectPath(projectPath),
                this.EMBED_CONFIG_FILE
            );
            
            if (await fileExists(projectConfigPath)) {
                const projectConfig = await readJsonFile<unknown>(projectConfigPath);
                if (!isRawEmbeddingConfig(projectConfig)) {
                    logger.warn(`Invalid project embedding config at ${projectConfigPath}, using defaults`);
                    return this.DEFAULT_CONFIG;
                }
                logger.debug(`Loaded project embedding config from ${projectConfigPath}`);
                return this.parseConfig(projectConfig);
            }

            // Fall back to global config
            const globalConfigPath = path.join(
                configService.getGlobalPath(),
                this.EMBED_CONFIG_FILE
            );
            
            if (await fileExists(globalConfigPath)) {
                const globalConfig = await readJsonFile<unknown>(globalConfigPath);
                if (!isRawEmbeddingConfig(globalConfig)) {
                    logger.warn(`Invalid global embedding config at ${globalConfigPath}, using defaults`);
                    return this.DEFAULT_CONFIG;
                }
                logger.debug(`Loaded global embedding config from ${globalConfigPath}`);
                return this.parseConfig(globalConfig);
            }

            // Use default if no config found
            logger.debug('No embedding configuration found, using defaults');
            return this.DEFAULT_CONFIG;
        } catch (error) {
            logger.warn('Failed to load embedding configuration, using defaults', { error });
            return this.DEFAULT_CONFIG;
        }
    }

    /**
     * Parse and validate embedding configuration
     */
    private static parseConfig(raw: RawEmbeddingConfig): EmbeddingConfig {
        // Support both old format (just model string) and new format
        if (typeof raw === 'string' || (raw && raw.model && !raw.provider)) {
            // Old format or just model specified
            const modelId = typeof raw === 'string' ? raw : raw.model;
            
            // Infer provider from model name
            if (modelId.includes('text-embedding')) {
                return {
                    provider: 'openai',
                    model: modelId,
                    apiKey: process.env.OPENAI_API_KEY
                };
            }
            
            return {
                provider: 'local',
                model: modelId
            };
        }

        // New format with explicit provider
        return {
            provider: raw.provider || 'local',
            model: raw.model || this.DEFAULT_CONFIG.model,
            apiKey: raw.apiKey || process.env.OPENAI_API_KEY
        };
    }

    /**
     * Save embedding configuration
     */
    static async saveConfiguration(
        config: EmbeddingConfig,
        scope: 'global' | 'project' = 'global'
    ): Promise<void> {
        const configService = ConfigService.getInstance();
        
        const basePath = scope === 'global' 
            ? configService.getGlobalPath()
            : configService.getProjectPath(process.cwd());
        
        const configPath = path.join(basePath, this.EMBED_CONFIG_FILE);
        
        // Don't save API key to file
        const configToSave = {
            provider: config.provider,
            model: config.model
        };
        
        const { writeJsonFile, ensureDirectory } = await import('@/lib/fs');
        await ensureDirectory(basePath);
        await writeJsonFile(configPath, configToSave);
        
        logger.info(
            `Embedding configuration saved to ${scope} config: ${config.provider}/${config.model}`
        );
    }
}