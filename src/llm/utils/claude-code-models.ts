/**
 * Claude Code Model Definitions
 *
 * Known model aliases supported by the ai-sdk-provider-claude-code package.
 * These aliases are resolved by the provider to the actual Claude model versions.
 */

export interface ClaudeCodeModelOption {
    id: string;
    displayName: string;
    description: string;
}

/**
 * Known Claude Code model aliases
 */
export const CLAUDE_CODE_MODELS: ClaudeCodeModelOption[] = [
    {
        id: "sonnet",
        displayName: "Claude Sonnet",
        description: "Balanced performance and cost — recommended for most tasks",
    },
    {
        id: "opus",
        displayName: "Claude Opus",
        description: "Most capable — best for complex reasoning and coding",
    },
    {
        id: "haiku",
        displayName: "Claude Haiku",
        description: "Fastest and most cost-effective — best for simple tasks",
    },
];
