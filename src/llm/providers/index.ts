/**
 * LLM Providers Module
 *
 * This module provides a modular, extensible system for LLM providers.
 * Each provider implements the ILLMProvider interface and registers
 * itself with the ProviderRegistry.
 *
 * ## Architecture
 *
 * - **Standard Providers**: Use AI SDK's provider packages and createProviderRegistry
 *   Examples: OpenRouter, Anthropic, OpenAI, Ollama, Gemini CLI
 *
 * - **Agent Providers**: Have built-in tools and session management
 *   Examples: Claude Code, Codex CLI
 *
 * ## Adding a New Provider
 *
 * 1. Create a new provider class extending StandardProvider or AgentProvider
 * 2. Implement the required abstract methods
 * 3. Add the provider to the ALL_PROVIDERS array below
 * 4. The provider will be automatically registered and available
 *
 * @module
 */

// Export types
export * from "./types";

// Export base classes
export * from "./base";

// Export registry
export { ProviderRegistry, providerRegistry } from "./registry";

// Export standard providers
export {
    OpenRouterProvider,
    AnthropicProvider,
    OpenAIProvider,
    OllamaProvider,
    GeminiCliProvider,
} from "./standard";

// Export agent providers
export { ClaudeCodeProvider, CodexCliProvider } from "./agent";

// Export TenexToolsAdapter
export { TenexToolsAdapter } from "./TenexToolsAdapter";

// Import for registration
import type { ProviderRegistration } from "./types";
import { OpenRouterProvider } from "./standard/OpenRouterProvider";
import { AnthropicProvider } from "./standard/AnthropicProvider";
import { OpenAIProvider } from "./standard/OpenAIProvider";
import { OllamaProvider } from "./standard/OllamaProvider";
import { GeminiCliProvider } from "./standard/GeminiCliProvider";
import { ClaudeCodeProvider } from "./agent/ClaudeCodeProvider";
import { CodexCliProvider } from "./agent/CodexCliProvider";
import { providerRegistry } from "./registry";

/**
 * All available provider registrations
 *
 * Add new providers to this array to make them available.
 */
export const ALL_PROVIDER_REGISTRATIONS: ProviderRegistration[] = [
    // Standard providers
    {
        Provider: OpenRouterProvider,
        metadata: new OpenRouterProvider().metadata,
    },
    {
        Provider: AnthropicProvider,
        metadata: new AnthropicProvider().metadata,
    },
    {
        Provider: OpenAIProvider,
        metadata: new OpenAIProvider().metadata,
    },
    {
        Provider: OllamaProvider,
        metadata: new OllamaProvider().metadata,
    },
    {
        Provider: GeminiCliProvider,
        metadata: new GeminiCliProvider().metadata,
    },
    // Agent providers
    {
        Provider: ClaudeCodeProvider,
        metadata: new ClaudeCodeProvider().metadata,
    },
    {
        Provider: CodexCliProvider,
        metadata: new CodexCliProvider().metadata,
    },
];

/**
 * Register all providers with the registry
 * This is called automatically on module load
 */
export function registerAllProviders(): void {
    providerRegistry.registerAll(ALL_PROVIDER_REGISTRATIONS);
}

// Auto-register all providers on module load
registerAllProviders();
