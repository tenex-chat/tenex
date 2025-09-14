import { createClaudeCode, createSdkMcpServer } from "ai-sdk-provider-claude-code";
import { createProviderRegistry, type ProviderRegistry } from "ai";
import type { LLMLogger } from "@/logging/LLMLogger";
import type { LLMConfiguration } from "@/services/config/types";
import type { AISdkTool } from "@/tools/registry";
import { LLMService } from "../service";
import type { ProviderStrategy } from "./ProviderStrategy";
import { TenexToolsAdapter } from "./TenexToolsAdapter";
import { logger } from "@/utils/logger";

/**
 * Provider strategy for Claude Code which requires runtime tool configuration
 */
export class ClaudeCodeProviderStrategy implements ProviderStrategy {
    requiresRuntimeContext(): boolean {
        return true;
    }

    createService(
        llmLogger: LLMLogger,
        config: LLMConfiguration,
        _registry: ProviderRegistry, // Unused for Claude Code
        context?: {
            tools?: Record<string, AISdkTool>;
            agentName?: string;
        }
    ): LLMService {
        // Extract tool names from the provided tools
        const toolNames = context?.tools ? Object.keys(context.tools) : [];

        // Separate MCP tools from regular tools
        const mcpTools = toolNames.filter(name => name.startsWith('mcp__'));
        const regularTools = toolNames.filter(name => !name.startsWith('mcp__'));

        // Extract unique external MCP server names
        const externalMcpServers = [...new Set(
            mcpTools.map(name => {
                const parts = name.split('__');
                return parts[1]; // Get server name from mcp__<server>__<tool>
            }).filter(Boolean)
        )];

        logger.info("[ClaudeCodeProviderStrategy] Creating Claude Code provider", {
            agent: context?.agentName,
            regularTools,
            externalMcpServers,
            mcpToolCount: mcpTools.length
        });

        // Create SDK MCP server for local TENEX tools if any exist
        const tenexSdkServer = regularTools.length > 0 && context?.tools
            ? TenexToolsAdapter.createSdkMcpServer(context.tools, context)
            : undefined;

        // Build mcpServers configuration
        const mcpServersConfig: any = {};

        // Add external MCP servers by name
        // Note: External MCP servers should be configured separately in Claude Code's config
        // We only add the SDK server here for TENEX tools
        if (externalMcpServers.length > 0) {
            logger.debug(`[ClaudeCodeProviderStrategy] External MCP servers required: ${externalMcpServers.join(', ')}`);
            // External servers need to be configured in Claude Code's own configuration
            // We can't add them here as they require full server definitions
        }

        // Add SDK MCP server for TENEX tools
        if (tenexSdkServer) {
            mcpServersConfig.tenex = tenexSdkServer;
        }

        // Build allowed tools list
        // Only include TENEX tools via SDK server since external MCP servers
        // need to be configured separately in Claude Code
        const allowedTools = tenexSdkServer
            ? regularTools.map(name => `mcp__tenex__${name}`) // TENEX tools via SDK server
            : [];

        // Create Claude Code provider with runtime configuration
        const claudeCodeConfig = {
            // Include both external MCP servers and SDK MCP server
            mcpServers: Object.keys(mcpServersConfig).length > 0 ? mcpServersConfig : undefined,

            // Allow all tools (both external MCP and TENEX via SDK)
            allowedTools: allowedTools.length > 0 ? allowedTools : undefined,

            // Default settings
            defaultSettings: {
                // Permission mode - could be configurable per agent
                permissionMode: 'bypassPermissions',
            }
        };

        // Create the provider with the configuration
        const provider = createClaudeCode(claudeCodeConfig);

        // Create a new registry with just this provider
        const claudeCodeRegistry = createProviderRegistry({
            claudeCode: provider
        });

        logger.debug("[ClaudeCodeProviderStrategy] Created Claude Code provider with custom registry");

        // Return a new LLMService with the Claude Code-specific registry
        return new LLMService(
            llmLogger,
            claudeCodeRegistry,
            'claudeCode',
            config.model,
            config.temperature,
            config.maxTokens
        );
    }
}