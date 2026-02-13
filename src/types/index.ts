/**
 * Types barrel export
 *
 * Centralized exports for all custom types used throughout the system.
 */

// Event ID types and utilities
export {
    // Branded types
    type FullEventId,
    type ShortEventId,
    type ShellTaskId,
    type AnyEventId,
    type AnyTaskId,

    // Constants
    FULL_EVENT_ID_LENGTH,
    SHORT_EVENT_ID_LENGTH,
    SHELL_TASK_ID_LENGTH,

    // Type guards
    isFullEventId,
    isShortEventId,
    isShellTaskId,
    detectIdType,

    // Factory functions
    createFullEventId,
    createShortEventId,
    createShellTaskId,
    tryCreateFullEventId,
    tryCreateShortEventId,
    tryCreateShellTaskId,

    // Conversion functions
    shortenEventId,
    toRawString,

    // Assertion functions
    assertFullEventId,
    assertShortEventId,
    assertShellTaskId,

    // Utility functions
    parseEventId,
} from "./event-ids";
