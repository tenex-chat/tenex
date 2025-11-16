/**
 * Configuration constants for agent execution
 */
export const ExecutionConfig = {
    /** Delay in milliseconds after publishing typing indicator */
    TOOL_INDICATOR_DELAY_MS: 100,

    /** Default duration for tool execution when not tracked */
    DEFAULT_TOOL_DURATION_MS: 1000,

    /** Default timeout for shell commands in milliseconds (30 seconds) */
    DEFAULT_COMMAND_TIMEOUT_MS: 30000,

    /** Threshold for considering a phase transition as recent in milliseconds (30 seconds) */
    RECENT_TRANSITION_THRESHOLD_MS: 30000,
} as const;
