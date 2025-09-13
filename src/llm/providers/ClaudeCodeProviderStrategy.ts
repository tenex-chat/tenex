import { createClaudeCode } from "ai-sdk-provider-claude-code";
import { createProviderRegistry, type ProviderRegistry } from "ai";
import type { LLMLogger } from "@/logging/LLMLogger";
import type { LLMConfiguration } from "@/services/config/types";
import type { AISdkTool } from "@/tools/registry";
import { LLMService } from "../service";
import type { ProviderStrategy } from "./ProviderStrategy";
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

        // Extract unique MCP server names
        const mcpServers = [...new Set(
            mcpTools.map(name => {
                const parts = name.split('__');
                return parts[1]; // Get server name from mcp__<server>__<tool>
            }).filter(Boolean)
        )];

        logger.debug("[ClaudeCodeProviderStrategy] Creating Claude Code provider", {
            agent: context?.agentName,
            regularTools,
            mcpServers,
            mcpToolCount: mcpTools.length
        });

        // Create Claude Code provider with runtime configuration
        const claudeCodeConfig = {
            // Include MCP servers that this agent needs
            mcpServers: mcpServers.length > 0 ? mcpServers : undefined,

            // Allow all tools that the agent has access to
            allowedTools: toolNames.length > 0 ? toolNames : undefined,

            // Default settings
            defaultSettings: {
                // Use environment variable or default path
                pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_PATH || '/usr/local/bin/claude',

                // Permission mode - could be configurable per agent
                permissionMode: 'default',

                // Custom system prompt could include agent context
                customSystemPrompt: context?.agentName
                    ? `You are operating as the ${context.agentName} agent.`
                    : undefined
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