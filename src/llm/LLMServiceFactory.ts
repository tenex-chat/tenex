import type { LLMLogger } from "@/logging/LLMLogger";
import type { LLMConfiguration } from "@/services/config/types";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createProviderRegistry } from "ai";
import type { ProviderV2 } from "@ai-sdk/provider";
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
    private providers: Map<string, ProviderV2> = new Map();
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
        this.providers.clear();
        this.enableTenexTools = options?.enableTenexTools !== false; // Default to true

        // Check if mock mode is enabled
        if (process.env.USE_MOCK_LLM === "true") {
            logger.debug(
                "[LLMServiceFactory] Mock LLM mode enabled via USE_MOCK_LLM environment variable"
            );

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
                logger.debug(`[LLMServiceFactory] Skipping provider ${name} - no API key`);
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
                        logger.debug("[LLMServiceFactory] Initialized OpenRouter provider");
                        break;

                    case "anthropic":
                        this.providers.set(
                            name,
                            createAnthropic({
                                apiKey: config.apiKey,
                            })
                        );
                        logger.debug("[LLMServiceFactory] Initialized Anthropic provider");
                        break;

                    case "openai":
                        this.providers.set(
                            name,
                            createOpenAI({
                                apiKey: config.apiKey,
                            })
                        );
                        logger.debug("[LLMServiceFactory] Initialized OpenAI provider");
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

                        this.providers.set(name, ollamaProvider as ProviderV2);
                        logger.debug(
                            `[LLMServiceFactory] Initialized Ollama provider with baseURL: ${baseURL || "default (http://localhost:11434)"}`
                        );
                        break;
                    }

                    case "gemini-cli": {
                        this.providers.set(
                            name,
                            createGeminiProvider({ authType: "oauth-personal" }) as ProviderV2
                        );
                        logger.debug("[LLMServiceFactory] Initialized Gemini CLI provider");
                        break;
                    }

                    case "claudeCode": {
                        // Claude Code is always available, no initialization needed
                        logger.debug("[LLMServiceFactory] Claude Code provider is always available");
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
            logger.debug(
                `[LLMServiceFactory] Created provider registry with ${this.providers.size} providers`
            );
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
            projectPath?: string;
        }
    ): LLMService {
        if (!this.initialized) {
            throw new Error("LLMServiceFactory not initialized. Call initializeProviders first.");
        }

        // Convert agent name to slug format for logging
        const agentSlug = context?.agentName
            ? context.agentName.toLowerCase().replace(/\s+/g, "-")
            : undefined;

        // If mock mode is enabled, always use mock provider regardless of config
        const actualProvider = process.env.USE_MOCK_LLM === "true" ? "mock" : config.provider;

        if (actualProvider === "mock" && actualProvider !== config.provider) {
            logger.debug(
                `[LLMServiceFactory] Using mock provider instead of ${config.provider} due to USE_MOCK_LLM=true`
            );
        }

        // Handle Claude Code provider specially
        if (actualProvider === "claudeCode") {
            // Extract tool names from the provided tools
            const toolNames = context?.tools ? Object.keys(context.tools) : [];
            const regularTools = toolNames.filter((name) => !name.startsWith("mcp__"));

            logger.info("[LLMServiceFactory] 🚀 CREATING CLAUDE CODE PROVIDER", {
                agent: context?.agentName,
                agentSlug,
                sessionId: context?.sessionId || "NONE",
                hasSessionId: !!context?.sessionId,
                regularTools,
                toolCount: regularTools.length,
                enableTenexTools: this.enableTenexTools,
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
            const mcpConfig = configService.getConfig().mcp;
            if (mcpConfig?.enabled && mcpConfig.servers) {
                for (const [serverName, serverConfig] of Object.entries(mcpConfig.servers)) {
                    // Convert TENEX's MCPServerConfig to Claude Code's McpStdioServerConfig
                    mcpServersConfig[serverName] = {
                        type: "stdio" as const,
                        command: serverConfig.command,
                        args: serverConfig.args,
                        env: serverConfig.env,
                    };
                }

                logger.info("[LLMServiceFactory] Added MCP servers to Claude Code agent", {
                    serverCount: Object.keys(mcpConfig.servers).length,
                    servers: Object.keys(mcpConfig.servers),
                });
            }

            // Create Claude Code provider with runtime configuration
            // IMPORTANT: Always pass mcpServers and allowedTools explicitly (even if empty)
            // to override any old session state that might have TENEX tools registered
            const defaultSettings: ClaudeCodeSettings = {
                permissionMode: "bypassPermissions",
                verbose: true,
                cwd: context?.projectPath,
                allowedTools: ["Bash(echo:*)", "Bash(date)", "Bash(pwd)"],
                mcpServers: mcpServersConfig as any,
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
                llmLogger,
                null,
                "claudeCode",
                config.model,
                config.temperature,
                config.maxTokens,
                providerFunction,
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
            llmLogger,
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
