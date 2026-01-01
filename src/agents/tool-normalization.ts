import type { MCPManager } from "@/services/mcp/MCPManager";
import { isValidToolName } from "@/tools/registry";
import type { ToolName } from "@/tools/types";
import { logger } from "@/utils/logger";
import { CORE_AGENT_TOOLS, DELEGATE_TOOLS, getDelegateToolsForAgent } from "./constants";

/**
 * tool-normalization - Pure functions for processing agent tool lists
 *
 * ## Responsibility
 * Centralizes all tool assignment logic that was previously scattered across:
 * - AgentRegistry
 * - agent-loader
 * - Agent creation tools
 *
 * ## What it does
 * Takes a raw tool list + agent context → returns final validated tool list:
 * 1. Filter out delegate tools (managed separately)
 * 2. Add appropriate delegate tools
 * 3. Add core tools (all agents get these)
 * 4. Validate tool names
 * 5. Resolve MCP tools (check availability)
 * 6. Return final deduplicated list
 *
 * ## Pure Functions
 * All functions here are stateless and side-effect free:
 * - Same input = same output
 * - No external state
 * - No mutations
 * - Easy to test
 *
 * ## Usage
 * Called during AgentInstance creation in agent-loader.ts:
 * ```typescript
 * const finalTools = processAgentTools(storedAgent.tools, storedAgent.slug);
 * ```
 *
 * @see agent-loader for usage in instance creation
 */

/**
 * Normalize agent tools by applying business rules:
 * 1. Filter out delegate tools (they're managed separately)
 * 2. Add appropriate delegate tools
 * 3. Ensure all core tools are included
 */
export function normalizeAgentTools(requestedTools: string[]): string[] {
    // Filter out delegation tools
    const toolNames = requestedTools.filter((tool) => {
        const typedTool = tool as ToolName;
        return !DELEGATE_TOOLS.includes(typedTool);
    });

    // Add delegation tools
    const delegateTools = getDelegateToolsForAgent();
    toolNames.push(...delegateTools);

    // Ensure core tools are included
    for (const coreTool of CORE_AGENT_TOOLS) {
        if (!toolNames.includes(coreTool)) {
            toolNames.push(coreTool);
        }
    }

    return toolNames;
}

/**
 * Validate and filter tools, separating valid tools from MCP tool requests.
 *
 * ## Warning: Unrecognized tools are logged
 * Tools that are neither valid static/dynamic tools nor MCP tools are logged
 * as warnings. This helps debug issues where dynamic tools fail to load.
 */
export function validateAndSeparateTools(toolNames: string[]): {
    validTools: string[];
    mcpToolRequests: string[];
} {
    const validTools: string[] = [];
    const mcpToolRequests: string[] = [];
    const droppedTools: string[] = [];

    for (const toolName of toolNames) {
        if (isValidToolName(toolName)) {
            validTools.push(toolName);
        } else if (toolName.startsWith("mcp__")) {
            mcpToolRequests.push(toolName);
        } else {
            // Track dropped tools to warn about them
            droppedTools.push(toolName);
        }
    }

    // Warn about dropped tools - this helps debug dynamic tool loading issues
    if (droppedTools.length > 0) {
        logger.warn(
            `[tool-normalization] Dropping ${droppedTools.length} unrecognized tool(s): ${droppedTools.join(", ")}. ` +
            `If these are dynamic tools, they may not have loaded yet.`
        );
    }

    return { validTools, mcpToolRequests };
}

/**
 * Resolve MCP tools - check if requested MCP tools are available
 * Returns array of available MCP tool names
 *
 * If mcpManager is not provided, returns all requested MCP tools without validation.
 * This allows agent loading to proceed before MCP is initialized - actual tool
 * availability is checked at execution time in getToolsObject.
 */
export function resolveMCPTools(mcpToolRequests: string[], agentSlug: string, mcpManager?: MCPManager): string[] {
    if (mcpToolRequests.length === 0) {
        return [];
    }

    // If no MCPManager available, keep all MCP tool requests - they'll be validated at execution time
    if (!mcpManager) {
        return mcpToolRequests;
    }

    const availableMcpTools: string[] = [];

    try {
        const allMcpTools = mcpManager.getCachedTools();
        for (const toolName of mcpToolRequests) {
            if (allMcpTools[toolName]) {
                availableMcpTools.push(toolName);
            }
        }
    } catch (error) {
        logger.debug(`Could not load MCP tools for agent "${agentSlug}":`, error);
        // Return all requested tools on error - validation will happen at execution time
        return mcpToolRequests;
    }

    return availableMcpTools;
}

/**
 * Complete tool processing pipeline:
 * 1. Normalize (add core, delegate, filter)
 * 2. Validate
 * 3. Resolve MCP tools
 * Returns final list of valid, available tool names
 *
 * @param mcpManager - Optional MCPManager for validating MCP tools. If not provided,
 *                     MCP tool names are kept without validation (validated at execution time).
 */
export function processAgentTools(requestedTools: string[], agentSlug: string, mcpManager?: MCPManager): string[] {
    // Step 1: Normalize
    const normalized = normalizeAgentTools(requestedTools);

    // Step 2: Validate and separate
    const { validTools, mcpToolRequests } = validateAndSeparateTools(normalized);

    // Step 3: Resolve MCP tools
    const mcpTools = resolveMCPTools(mcpToolRequests, agentSlug, mcpManager);

    // Combine and return
    return [...validTools, ...mcpTools];
}
