import { mcpService } from "@/services/mcp/MCPManager";
import { isValidToolName } from "@/tools/registry";
import type { ToolName } from "@/tools/types";
import { logger } from "@/utils/logger";
import {
    CORE_AGENT_TOOLS,
    DELEGATE_TOOLS,
    PHASE_MANAGEMENT_TOOLS,
    getDelegateToolsForAgent,
} from "./constants";

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
 * 1. Filter out delegate/phase management tools (managed separately)
 * 2. Add appropriate delegate tools based on agent phases
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
 * const finalTools = processAgentTools(storedAgent.tools, {
 *   slug: storedAgent.slug,
 *   phases: storedAgent.phases
 * });
 * ```
 *
 * @see agent-loader for usage in instance creation
 */

/**
 * Normalize agent tools by applying business rules:
 * 1. Filter out delegate and phase management tools (they're managed separately)
 * 2. Add appropriate delegate tools based on phases
 * 3. Ensure all core tools are included
 */
export function normalizeAgentTools(
    requestedTools: string[],
    agent: { phases?: Record<string, string> }
): string[] {
    // Filter out delegation and phase management tools
    const toolNames = requestedTools.filter((tool) => {
        const typedTool = tool as ToolName;
        return !DELEGATE_TOOLS.includes(typedTool) && !PHASE_MANAGEMENT_TOOLS.includes(typedTool);
    });

    // Add delegation tools based on phases
    const delegateTools = getDelegateToolsForAgent(agent);
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
 * Validate and filter tools, separating valid tools from MCP tool requests
 */
export function validateAndSeparateTools(toolNames: string[]): {
    validTools: string[];
    mcpToolRequests: string[];
} {
    const validTools: string[] = [];
    const mcpToolRequests: string[] = [];

    for (const toolName of toolNames) {
        if (isValidToolName(toolName)) {
            validTools.push(toolName);
        } else if (toolName.startsWith("mcp__")) {
            mcpToolRequests.push(toolName);
        }
    }

    return { validTools, mcpToolRequests };
}

/**
 * Resolve MCP tools - check if requested MCP tools are available
 * Returns array of available MCP tool names
 */
export function resolveMCPTools(mcpToolRequests: string[], agentSlug: string): string[] {
    if (mcpToolRequests.length === 0) {
        return [];
    }

    const availableMcpTools: string[] = [];

    try {
        const allMcpTools = mcpService.getCachedTools();
        for (const toolName of mcpToolRequests) {
            if (allMcpTools[toolName]) {
                availableMcpTools.push(toolName);
            }
        }
    } catch (error) {
        logger.debug(`Could not load MCP tools for agent "${agentSlug}":`, error);
    }

    return availableMcpTools;
}

/**
 * Complete tool processing pipeline:
 * 1. Normalize (add core, delegate, filter)
 * 2. Validate
 * 3. Resolve MCP tools
 * Returns final list of valid, available tool names
 */
export function processAgentTools(
    requestedTools: string[],
    agent: { slug: string; phases?: Record<string, string> }
): string[] {
    // Step 1: Normalize
    const normalized = normalizeAgentTools(requestedTools, agent);

    // Step 2: Validate and separate
    const { validTools, mcpToolRequests } = validateAndSeparateTools(normalized);

    // Step 3: Resolve MCP tools
    const mcpTools = resolveMCPTools(mcpToolRequests, agent.slug);

    // Combine and return
    return [...validTools, ...mcpTools];
}
