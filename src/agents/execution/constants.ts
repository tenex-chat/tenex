/**
 * Configuration constants for agent execution
 */
export const ExecutionConfig = {
    /** Maximum number of attempts to enforce proper termination */
    MAX_TERMINATION_ATTEMPTS: 2,
    
    /** Delay in milliseconds after publishing typing indicator */
    TOOL_INDICATOR_DELAY_MS: 100,
    
    /** Default duration for tool execution when not tracked */
    DEFAULT_TOOL_DURATION_MS: 1000,
} as const;