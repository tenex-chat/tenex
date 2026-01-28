/**
 * Nudge Tool Permissions Types
 *
 * Defines the structure for tool permissions specified in nudge events (kind:4201).
 * Nudges can modify an agent's available tools through three tag types:
 *
 * 1. only-tool: Highest priority - REPLACES all tools with only these
 * 2. allow-tool: Adds tools to the agent's default set
 * 3. deny-tool: Removes tools from the agent's default set
 *
 * Precedence: only-tool > allow-tool/deny-tool
 */

/**
 * Tool permissions extracted from nudge event tags.
 * Used to modify an agent's available tools during execution.
 */
export interface NudgeToolPermissions {
    /**
     * If set, the agent gets EXACTLY these tools (and nothing else).
     * This is the highest priority - completely overrides allow/deny and agent defaults.
     * Tag format: ["only-tool", "tool_name"]
     */
    onlyTools?: string[];

    /**
     * Tools to enable (add to agent's default set).
     * Ignored if onlyTools is set.
     * Tag format: ["allow-tool", "tool_name"]
     */
    allowTools?: string[];

    /**
     * Tools to disable (remove from agent's default set).
     * Ignored if onlyTools is set.
     * Tag format: ["deny-tool", "tool_name"]
     */
    denyTools?: string[];
}

/**
 * Individual nudge data with content and title
 */
export interface NudgeData {
    /** The nudge content/prompt */
    content: string;
    /** The nudge title (from "title" tag) */
    title?: string;
}

/**
 * Result from fetching nudges with their tool permissions.
 * Contains both the concatenated content for system prompt injection
 * and the extracted tool permissions.
 */
export interface NudgeResult {
    /** Individual nudge data for rendering in the fragment */
    nudges: NudgeData[];

    /** Concatenated content from all nudges (for backward compatibility) */
    content: string;

    /** Tool permissions extracted from all nudge tags */
    toolPermissions: NudgeToolPermissions;
}

/**
 * Check if nudge permissions are using only-tool mode (highest priority)
 */
export function isOnlyToolMode(permissions: NudgeToolPermissions): boolean {
    return Array.isArray(permissions.onlyTools) && permissions.onlyTools.length > 0;
}

/**
 * Check if nudge permissions have any tool modifications
 */
export function hasToolPermissions(permissions: NudgeToolPermissions): boolean {
    return (
        isOnlyToolMode(permissions) ||
        (Array.isArray(permissions.allowTools) && permissions.allowTools.length > 0) ||
        (Array.isArray(permissions.denyTools) && permissions.denyTools.length > 0)
    );
}
