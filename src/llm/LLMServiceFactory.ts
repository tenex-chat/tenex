import type { LLMLogger } from "@/logging/LLMLogger";
import type { LLMConfiguration } from "@/services/config/types";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { trace, type Span } from "@opentelemetry/api";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createProviderRegistry } from "ai";
// Using 'any' for provider types due to version mismatch between different provider packages
import { type ClaudeCodeSettings, createClaudeCode } from "ai-sdk-provider-claude-code";
import { createGeminiProvider } from "ai-sdk-provider-gemini-cli";
import { createOllama } from "ollama-ai-provider-v2";
import { TenexToolsAdapter } from "./providers/TenexToolsAdapter";
import { LLMService } from "./service";
import { config as configService } from "@/services/ConfigService";

/**
 * Factory for creating LLM services with proper provider initialization
 */
export class LLMServiceFactory {
    private providers: Map<string, any> = new Map();
    private registry: ReturnType<typeof createProviderRegistry> | null = null;
    private enableTenexTools = true; // Global flag: provide TENEX tools to claude-code agents (default: true)
    private initialized = false;

    /**
     * Initialize providers from configuration
     */
    async initializeProviders(
        providerConfigs: Record<string, { apiKey: string }>,
        options?: { enableTenexTools?: boolean }
    ): Promise<void> {
        const tracer = trace.getTracer("llm-service-factory");

        return tracer.startActiveSpan("initializeProviders", async (span) => {
            try {
                await this.doInitializeProviders(providerConfigs, options, span);
            } finally {
                span.end();
            }
        });
    }

    private async doInitializeProviders(
        providerConfigs: Record<string, { apiKey: string }>,
        options: { enableTenexTools?: boolean } | undefined,
        span: Span
    ): Promise<void> {
        this.providers.clear();
        this.enableTenexTools = options?.enableTenexTools !== false; // Default to true

        // Check if mock mode is enabled
        if (process.env.USE_MOCK_LLM === "true") {
            span.addEvent("llm_factory.mock_mode_enabled");

            // Dynamically import MockProvider only when needed to avoid loading test dependencies
            try {
                const { createMockProvider } = await import("./providers/MockProvider");
                this.providers.set("mock", createMockProvider());
            } catch (error) {
                logger.error("[LLMServiceFactory] Failed to load MockProvider:", error);
                throw new Error(
                    "Mock mode is enabled but MockProvider could not be loaded. Make sure test dependencies are installed."
                );
            }

            // In mock mode, we only use the mock provider
            // Other providers can still be initialized but won't be used by default
        }

        for (const [name, config] of Object.entries(providerConfigs)) {
            if (!config?.apiKey) {
                continue;
            }

            try {
                switch (name) {
                    case "openrouter":
                        this.providers.set(
                            name,
                            createOpenRouter({
                                apiKey: config.apiKey,
                            })
                        );
                        break;

                    case "anthropic":
                        this.providers.set(
                            name,
                            createAnthropic({
                                apiKey: config.apiKey,
                            })
                        );
                        break;

                    case "openai":
                        this.providers.set(
                            name,
                            createOpenAI({
                                apiKey: config.apiKey,
                            })
                        );
                        break;

                    case "ollama": {
                        // For Ollama, apiKey is actually the base URL
                        // The library expects the URL to include /api path
                        let baseURL: string | undefined;
                        if (config.apiKey === "local") {
                            // Use default (library provides http://127.0.0.1:11434/api)
                            baseURL = undefined;
                        } else {
                            // Custom URL - ensure it ends with /api
                            baseURL = config.apiKey.endsWith("/api")
                                ? config.apiKey
                                : `${config.apiKey.replace(/\/$/, "")}/api`;
                        }

                        // Create Ollama provider with custom base URL if provided
                        const ollamaProvider = createOllama(baseURL ? { baseURL } : undefined);

                        this.providers.set(name, ollamaProvider as any);
                        break;
                    }

                    case "gemini-cli": {
                        this.providers.set(
                            name,
                            createGeminiProvider({ authType: "oauth-personal" }) as any
                        );
                        break;
                    }

                    case "claudeCode": {
                        // Claude Code is always available, no initialization needed
                        break;
                    }

                    default:
                        logger.warn(`[LLMServiceFactory] Unknown provider type: ${name}`);
                }
            } catch (error) {
                logger.error(`[LLMServiceFactory] Failed to initialize provider ${name}`, {
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }

        // Create the provider registry with all configured providers
        if (this.providers.size > 0) {
            const providerObject = Object.fromEntries(this.providers.entries());
            this.registry = createProviderRegistry(providerObject);
            span.addEvent("llm_factory.registry_created", {
                "providers.count": this.providers.size,
                "providers.names": Array.from(this.providers.keys()).join(", "),
            });
        } else {
            logger.warn("[LLMServiceFactory] No providers were successfully initialized");
            // Create an empty registry to avoid null checks everywhere
            this.registry = createProviderRegistry({});
        }

        this.initialized = true;
    }

    /**
     * Create an LLM service from a resolved configuration
     * @param llmLogger Logger for the service
     * @param config LLM configuration
     * @param context Optional runtime context for Claude Code
     */
    createService(
        llmLogger: LLMLogger,
        config: LLMConfiguration,
        context?: {
            tools?: Record<string, AISdkTool>;
            agentName?: string;
            sessionId?: string;
            /** Working directory path for Claude Code execution */
            workingDirectory?: string;
        }
    ): LLMService {
        if (!this.initialized) {
            throw new Error("LLMServiceFactory not initialized. Call initializeProviders first.");
        }

        // Convert agent name to slug format for logging
        const agentSlug = context?.agentName
            ? context.agentName.toLowerCase().replace(/\s+/g, "-")
            : undefined;

        // Create a logger with agent set if agentSlug is provided
        const serviceLogger = agentSlug ? llmLogger.withAgent(agentSlug) : llmLogger;

        // If mock mode is enabled, always use mock provider regardless of config
        const actualProvider = process.env.USE_MOCK_LLM === "true" ? "mock" : config.provider;

        // Handle Claude Code provider specially
        if (actualProvider === "claudeCode") {
            // Extract tool names from the provided tools
            const toolNames = context?.tools ? Object.keys(context.tools) : [];
            const regularTools = toolNames.filter((name) => !name.startsWith("mcp__"));

            trace.getActiveSpan()?.addEvent("llm_factory.creating_claude_code", {
                "agent.name": context?.agentName ?? "",
                "agent.slug": agentSlug ?? "",
                "session.id": context?.sessionId ?? "",
                "tools.count": regularTools.length,
                "tenex_tools.enabled": this.enableTenexTools,
            });

            // Create SDK MCP server for local TENEX tools if enabled and tools exist
            const tenexSdkServer =
                this.enableTenexTools && regularTools.length > 0 && context?.tools
                    ? TenexToolsAdapter.createSdkMcpServer(context.tools, context)
                    : undefined;

            // Build mcpServers configuration
            const mcpServersConfig: Record<string, any> = {};

            // Add TENEX tools wrapper if enabled
            if (tenexSdkServer) {
                mcpServersConfig.tenex = tenexSdkServer;
            }

            // Add TENEX's MCP servers from config
            // Load MCP config and convert TENEX MCP servers to Claude Code format
            const mcpConfig = configService.getMCP();
            if (mcpConfig.enabled && mcpConfig.servers) {
                for (const [serverName, serverConfig] of Object.entries(mcpConfig.servers)) {
                    // Convert TENEX's MCPServerConfig to Claude Code's McpStdioServerConfig
                    mcpServersConfig[serverName] = {
                        type: "stdio" as const,
                        command: serverConfig.command,
                        args: serverConfig.args,
                        env: serverConfig.env,
                    };
                }

                trace.getActiveSpan()?.addEvent("llm_factory.mcp_servers_added", {
                    "mcp.server_count": Object.keys(mcpConfig.servers).length,
                    "mcp.servers": Object.keys(mcpConfig.servers).join(", "),
                });
            }

            // Create Claude Code provider with runtime configuration
            // IMPORTANT: Always pass mcpServers and allowedTools explicitly (even if empty)
            // to override any old session state that might have TENEX tools registered
            const defaultSettings: ClaudeCodeSettings = {
                permissionMode: "bypassPermissions",
                verbose: true,
                cwd: context?.workingDirectory,
                mcpServers: mcpServersConfig,
                disallowedTools: [],
                logger: {
                    warn: (message: string) => logger.warn("[ClaudeCode]", message),
                    error: (message: string) => logger.error("[ClaudeCode]", message),
                    info: (message: string) => logger.info("[ClaudeCode]", message),
                    debug: (message: string) => logger.debug("[ClaudeCode]", message),
                },
            };

            const providerFunction = createClaudeCode({
                defaultSettings,
            });

            return new LLMService(
                serviceLogger,
                null,
                "claudeCode",
                config.model,
                config.temperature,
                config.maxTokens,
                providerFunction as any,
                context?.sessionId,
                agentSlug
            );
        }

        // For standard providers, check if provider is available
        if (!this.providers.has(actualProvider)) {
            const available = Array.from(this.providers.keys());
            throw new Error(
                `Provider "${actualProvider}" not available. ` +
                    `Initialized providers: ${available.length > 0 ? available.join(", ") : "none"}`
            );
        }

        // Return standard LLMService with registry
        if (!this.registry) {
            throw new Error("Provider registry not initialized");
        }

        return new LLMService(
            serviceLogger,
            this.registry,
            actualProvider,
            config.model,
            config.temperature,
            config.maxTokens,
            undefined,
            context?.sessionId,
            agentSlug
        );
    }

    /**
     * Check if a provider is available
     */
    hasProvider(providerName: string): boolean {
        // Check standard providers, Claude Code (always available), or Gemini CLI (always available)
        return (
            this.providers.has(providerName) ||
            providerName === "claudeCode" ||
            providerName === "gemini-cli"
        );
    }

    /**
     * Get the provider registry
     * Useful for direct access to language models
     */
    getRegistry(): ReturnType<typeof createProviderRegistry> {
        if (!this.registry) {
            throw new Error("LLMServiceFactory not initialized. Call initializeProviders first.");
        }
        return this.registry;
    }

    /**
     * Reset the factory (mainly for testing)
     */
    reset(): void {
        this.providers.clear();
        this.registry = null;
        this.initialized = false;
    }
}

// Export singleton instance
export const llmServiceFactory = new LLMServiceFactory();
