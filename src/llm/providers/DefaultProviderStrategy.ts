import type { ProviderRegistry } from "ai";
import type { LLMLogger } from "@/logging/LLMLogger";
import type { LLMConfiguration } from "@/services/config/types";
import type { AISdkTool } from "@/tools/registry";
import { LLMService } from "../service";
import type { ProviderStrategy } from "./ProviderStrategy";

/**
 * Default provider strategy for standard providers (OpenAI, Anthropic, etc.)
 * These providers receive tools at the streamText/generateText call time
 */
export class DefaultProviderStrategy implements ProviderStrategy {
    requiresRuntimeContext(): boolean {
        return false;
    }

    createService(
        llmLogger: LLMLogger,
        config: LLMConfiguration,
        registry: ProviderRegistry,
        _context?: { tools?: Record<string, AISdkTool>; agentName?: string }
    ): LLMService {
        // Standard providers use the shared registry
        return new LLMService(
            llmLogger,
            registry,
            config.provider,
            config.model,
            config.temperature,
            config.maxTokens
        );
    }
}