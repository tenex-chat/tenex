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
                const projectConfig = await readJsonFile<any>(projectConfigPath);
                logger.debug(`Loaded project embedding config from ${projectConfigPath}`);
                return this.parseConfig(projectConfig);
            }

            // Fall back to global config
            const globalConfigPath = path.join(
                configService.getGlobalPath(),
                this.EMBED_CONFIG_FILE
            );
            
            if (await fileExists(globalConfigPath)) {
                const globalConfig = await readJsonFile<any>(globalConfigPath);
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
    private static parseConfig(raw: any): EmbeddingConfig {
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