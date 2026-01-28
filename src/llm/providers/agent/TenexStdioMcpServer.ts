/**
 * Converts TENEX tools to stdio MCP server configuration for Codex CLI
 *
 * Unlike ClaudeCodeToolsAdapter (which creates in-process SDK MCP servers for Claude Code),
 * this adapter creates a stdio MCP server configuration that spawns the `tenex mcp serve`
 * command as a separate process. This allows Codex CLI agents to access TENEX tools.
 */

import type { ProviderRuntimeContext } from "../types";
import { logger } from "@/utils/logger";
import { getProjectContext } from "@/services/projects";

interface StdioMCPServerConfig {
    transport: "stdio";
    command: string;
    args: string[];
    env: Record<string, string>;
}

/**
 * Creates a stdio MCP server configuration for TENEX tools
 * The configuration spawns a subprocess running the same executable with `mcp serve` subcommand,
 * passing context via environment variables.
 */
export class TenexStdioMcpServer {
    /**
     * Create a stdio MCP server configuration for TENEX tools
     * @param context Provider runtime context with agent tools and execution info
     * @param toolNames List of TENEX tool names to expose (filtered list)
     * @returns stdio MCP server configuration, or undefined if no tools to expose
     */
    static create(
        context: ProviderRuntimeContext,
        toolNames: string[]
    ): StdioMCPServerConfig | undefined {
        // Filter out MCP tools - they're handled by external MCP servers
        const localToolNames = toolNames.filter((name) => !name.startsWith("mcp__"));

        logger.info("[TenexStdioMcpServer] Creating stdio MCP server config:", {
            totalToolNames: toolNames.length,
            localToolNames: localToolNames.length,
            toolNames: localToolNames,
            agentName: context.agentName,
        });

        // Don't create server if no local tools
        if (localToolNames.length === 0) {
            logger.info("[TenexStdioMcpServer] No local TENEX tools to expose - skipping");
            return undefined;
        }

        // Extract context values - these come from agentName and workingDirectory
        // projectId, agentId would ideally be in context but aren't available in ProviderRuntimeContext yet
        // For now, use sensible defaults
        const agentName = context.agentName ?? "unknown";
        const workingDirectory = context.workingDirectory ?? process.cwd();

        // Try to get project context if available (from AsyncLocalStorage)
        let projectId = "unknown";
        const agentId = agentName;
        const conversationId = context.sessionId ?? "no-conversation";
        const currentBranch = "main";

        try {
            const projectCtx = getProjectContext();
            if (projectCtx && projectCtx.project) {
                const dTag = projectCtx.project.tagValue?.("d");
                if (dTag) {
                    projectId = dTag;
                }
            }
        } catch {
            // Project context not available in current async context
            // This is expected when called during initialization
            logger.debug("[TenexStdioMcpServer] Project context not available, using defaults");
        }

        logger.info("[TenexStdioMcpServer] Extracted context:", {
            projectId,
            agentId,
            conversationId,
            workingDirectory,
            currentBranch,
        });

        // Create the stdio MCP server configuration
        // Use the current executable (process.argv[0] + process.argv[1]) instead of hard-coding "tenex"
        // This ensures we spawn the same runtime and script that's currently executing
        const config: StdioMCPServerConfig = {
            transport: "stdio",
            command: process.argv[0],  // node or bun binary
            args: [process.argv[1], "mcp", "serve"],  // script path + subcommand
            env: {
                TENEX_PROJECT_ID: projectId,
                TENEX_AGENT_ID: agentId,
                TENEX_CONVERSATION_ID: conversationId,
                TENEX_WORKING_DIRECTORY: workingDirectory,
                TENEX_CURRENT_BRANCH: currentBranch,
                TENEX_TOOLS: localToolNames.join(","),
            },
        };

        logger.info("[TenexStdioMcpServer] Created stdio MCP server config:", {
            command: config.command,
            args: config.args,
            tools: localToolNames.length,
            toolNames: localToolNames,
            env: {
                TENEX_PROJECT_ID: config.env.TENEX_PROJECT_ID,
                TENEX_AGENT_ID: config.env.TENEX_AGENT_ID,
                TENEX_TOOLS: config.env.TENEX_TOOLS,
            },
        });

        return config;
    }
}
