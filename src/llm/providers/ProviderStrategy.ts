import type { Provider, ProviderRegistry } from "ai";
import type { LLMLogger } from "@/logging/LLMLogger";
import type { LLMConfiguration } from "@/services/config/types";
import type { AISdkTool } from "@/tools/registry";
import { LLMService } from "../service";

/**
 * Strategy interface for creating LLM services with provider-specific initialization
 */
export interface ProviderStrategy {
    /**
     * Create an LLM service instance, potentially with runtime-specific configuration
     * @param llmLogger Logger instance for the service
     * @param config LLM configuration containing provider, model, etc.
     * @param registry Provider registry for standard providers
     * @param context Optional execution context for providers that need runtime configuration
     */
    createService(
        llmLogger: LLMLogger,
        config: LLMConfiguration,
        registry: ProviderRegistry,
        context?: {
            tools?: Record<string, AISdkTool>;
            agentName?: string;
        }
    ): LLMService;

    /**
     * Whether this provider requires runtime context (tools, etc.) to be created
     */
    requiresRuntimeContext(): boolean;
}