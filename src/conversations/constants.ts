/**
 * Constants for conversation management
 */

// Timing constants (in milliseconds)
export const SUMMARIZATION_DEFAULTS = {
    /** Initial summary delay after first message (30 seconds) */
    INITIAL_SUMMARY_DELAY_MS: 30 * 1000,

    /** Default inactivity timeout before generating summary (2 minutes) */
    INACTIVITY_TIMEOUT_MS: 2 * 60 * 1000,

    /** How often to check for conversations needing summarization */
    CHECK_INTERVAL_MS: 30 * 1000,
} as const;

// UI constants
export const CONVERSATION_UI = {
    /** How many days of conversation history to show */
    DAYS_OF_HISTORY: 7,

    /** Maximum number of conversations to fetch */
    MAX_CONVERSATIONS: 50,

    /** How often to refresh conversation list (milliseconds) */
    REFRESH_INTERVAL_MS: 30 * 1000,
} as const;
