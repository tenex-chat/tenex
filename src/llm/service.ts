import { generateText, streamText } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { CoreMessage } from 'ai';
import type { AISdkProvider } from './types';
import type { TenexLLMs, LLMConfiguration } from '@/services/config/types';

/**
 * LLM Service that supports multiple AI SDK providers
 */
export class LLMService {
  private providers: Map<string, any> = new Map();
  private configurations: Map<string, LLMConfiguration> = new Map();
  private defaultConfiguration?: string;
  
  constructor(
    providerConfigs: Record<string, { apiKey: string }>,
    configurations?: Record<string, LLMConfiguration>,
    defaultConfig?: string
  ) {
    // Initialize configured providers
    for (const [provider, config] of Object.entries(providerConfigs)) {
      if (config?.apiKey) {
        this.initializeProvider(provider as AISdkProvider, config.apiKey);
      }
    }
    
    // Store configurations
    if (configurations) {
      for (const [name, config] of Object.entries(configurations)) {
        this.configurations.set(name, config);
      }
    }
    
    this.defaultConfiguration = defaultConfig;
  }
  
  private initializeProvider(provider: AISdkProvider, apiKey: string) {
    switch (provider) {
      case 'openrouter':
        this.providers.set(provider, createOpenRouter({ 
          apiKey,
          headers: { 
            'X-Title': 'TENEX',
            'HTTP-Referer': 'https://github.com/pablof7z/tenex'
          }
        }));
        break;
      case 'anthropic':
        // Dynamically import Anthropic provider when needed
        import('@ai-sdk/anthropic').then(({ createAnthropic }) => {
          this.providers.set(provider, createAnthropic({ apiKey }));
        }).catch(() => {
          console.warn(`Anthropic provider not installed. Run: npm install @ai-sdk/anthropic`);
        });
        break;
      case 'openai':
        // Dynamically import OpenAI provider when needed
        import('@ai-sdk/openai').then(({ createOpenAI }) => {
          this.providers.set(provider, createOpenAI({ apiKey }));
        }).catch(() => {
          console.warn(`OpenAI provider not installed. Run: npm install @ai-sdk/openai`);
        });
        break;
    }
  }
  
  private resolveModelString(modelString: string): { 
    provider: string; 
    model: string;
    temperature?: number;
    maxTokens?: number;
  } {
    // Check if it's a configuration name
    const config = this.configurations.get(modelString);
    if (config) {
      return {
        provider: config.provider,
        model: config.model,
        temperature: config.temperature,
        maxTokens: config.maxTokens
      };
    }
    
    // Check if it's the special "default" keyword
    if (modelString === 'default' && this.defaultConfiguration) {
      const defaultConfig = this.configurations.get(this.defaultConfiguration);
      if (defaultConfig) {
        return {
          provider: defaultConfig.provider,
          model: defaultConfig.model,
          temperature: defaultConfig.temperature,
          maxTokens: defaultConfig.maxTokens
        };
      }
    }
    
    // Otherwise parse as "provider:model" format
    const parts = modelString.split(':');
    if (parts.length === 2) {
      return { provider: parts[0], model: parts[1] };
    }
    
    // Default to openrouter for backward compatibility
    return { provider: 'openrouter', model: modelString };
  }
  
  private getProvider(providerName: string) {
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new Error(`Provider ${providerName} not configured. Please run 'tenex setup llm' to configure it.`);
    }
    return provider;
  }
  
  async complete(
    modelString: string, 
    messages: CoreMessage[], 
    options?: {
      tools?: Record<string, any>;
      temperature?: number;
      maxTokens?: number;
    }
  ) {
    const resolved = this.resolveModelString(modelString);
    const llmProvider = this.getProvider(resolved.provider);
    
    return generateText({
      model: llmProvider(resolved.model),
      messages,
      tools: options?.tools,
      maxRetries: 0,  // Manual control for RAL
      temperature: options?.temperature ?? resolved.temperature ?? 0.7,
      maxTokens: options?.maxTokens ?? resolved.maxTokens
    });
  }
  
  async stream(
    modelString: string, 
    messages: CoreMessage[], 
    options?: {
      tools?: Record<string, any>;
      temperature?: number;
      maxTokens?: number;
    }
  ) {
    const resolved = this.resolveModelString(modelString);
    const llmProvider = this.getProvider(resolved.provider);
    
    return streamText({
      model: llmProvider(resolved.model),
      messages,
      tools: options?.tools,
      maxRetries: 0,  // Manual control for RAL
      temperature: options?.temperature ?? resolved.temperature ?? 0.7,
      maxTokens: options?.maxTokens ?? resolved.maxTokens
    });
  }
}

// Create service from config
let service: LLMService | null = null;

export function getLLMService(
  providerConfigs: Record<string, { apiKey: string }>,
  configurations?: Record<string, LLMConfiguration>,
  defaultConfig?: string
): LLMService {
  if (!service) {
    service = new LLMService(providerConfigs, configurations, defaultConfig);
  }
  return service;
}

// Helper to get service from config file
export async function getLLMServiceFromConfig(): Promise<LLMService> {
  const { configService } = await import('@/services');
  const config = await configService.loadConfig();
  return getLLMService(
    config.llms.providers,
    config.llms.configurations,
    config.llms.default
  );
}