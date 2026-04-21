import { isValidToolName } from "@/tools/registry";
import type { ToolName } from "@/tools/types";
import { logger } from "@/utils/logger";
import { DELEGATE_TOOLS, SKILL_MANAGEMENT_TOOLS, getCoreToolsForAgent, getDelegateToolsForAgent } from "./constants";
import type { AgentCategory } from "./role-categories";

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
 * 2. Add appropriate delegate tools via getDelegateToolsForAgent (category-aware)
 * 3. Add core tools (all agents get these)
 * 4. Validate tool names
 * 5. Return final deduplicated list
 *
 * ## Capability policy
 * getDelegateToolsForAgent() in constants.ts is the single source of truth
 * for which delegation tools each category receives. Domain-experts receive
 * only `ask`; workers receive `ask` and `delegate_followup`.
 *
 * ## Pure Functions
 * All functions here are stateless and side-effect free:
 * - Same input = same output
 * - No external state
 * - No mutations
 * - Easy to test
 *
 * @see constants.ts#getDelegateToolsForAgent for capability policy
 * @see agent-loader for usage in instance creation
 */

/**
 * Normalize agent tools by applying business rules:
 * 1. Filter out delegate tools (they're managed separately)
 * 2. Add appropriate delegate tools via getDelegateToolsForAgent (category-aware)
 * 3. Ensure all core tools are included
 */
export function normalizeAgentTools(requestedTools: string[], category?: AgentCategory): string[] {
    // Filter out delegation tools
    const toolNames = requestedTools.filter((tool) => {
        const typedTool = tool as ToolName;
        if (DELEGATE_TOOLS.includes(typedTool)) {
            return false;
        }

        if (category === "orchestrator" && SKILL_MANAGEMENT_TOOLS.includes(typedTool)) {
            return false;
        }

        return true;
    });

    // Add delegation tools — policy lives in getDelegateToolsForAgent.
    const delegateTools = getDelegateToolsForAgent(category);
    toolNames.push(...delegateTools);

    // Ensure core tools are included
    for (const coreTool of getCoreToolsForAgent(category)) {
        if (!toolNames.includes(coreTool)) {
            toolNames.push(coreTool);
        }
    }

    return toolNames;
}

/**
 * Validate and filter tools.
 *
 * MCP tools (mcp__ prefix) are no longer valid in tool lists — agents declare
 * MCP server access via mcpAccess instead. Any mcp__ entries are dropped with a warning.
 * Other unrecognized tools are also logged as warnings.
 */
export function validateTools(toolNames: string[]): string[] {
    const validTools: string[] = [];
    const droppedTools: string[] = [];
    const droppedMcpTools: string[] = [];

    for (const toolName of toolNames) {
        if (toolName.startsWith("mcp__")) {
            droppedMcpTools.push(toolName);
        } else if (isValidToolName(toolName)) {
            validTools.push(toolName);
        } else {
            droppedTools.push(toolName);
        }
    }

    if (droppedMcpTools.length > 0) {
        logger.warn(
            `[tool-normalization] Dropping ${droppedMcpTools.length} mcp__ tool(s) — use mcpAccess instead: ${droppedMcpTools.join(", ")}`
        );
    }

    if (droppedTools.length > 0) {
        logger.warn(
            `[tool-normalization] Dropping ${droppedTools.length} unrecognized tool(s): ${droppedTools.join(", ")}`
        );
    }

    return validTools;
}

/**
 * Complete tool processing pipeline:
 * 1. Normalize (add core, delegate, filter)
 * 2. Validate (drop unrecognized tools and legacy mcp__ entries)
 * Returns final list of valid tool names.
 *
 * MCP tools are no longer resolved here — agents declare server-level access
 * via mcpAccess and tools are injected at execution time.
 */
export function processAgentTools(requestedTools: string[], category?: AgentCategory): string[] {
    // Step 1: Normalize
    const normalized = normalizeAgentTools(requestedTools, category);

    // Step 2: Validate (drops mcp__ entries with warning)
    return validateTools(normalized);
}
