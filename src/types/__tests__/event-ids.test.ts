/**
 * Tests for typed event IDs
 */

import { describe, test, expect } from "bun:test";
import {
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

    // Constants
    FULL_EVENT_ID_LENGTH,
    SHORT_EVENT_ID_LENGTH,
    SHELL_TASK_ID_LENGTH,
} from "../event-ids";

// Test data
const VALID_FULL_ID = "a1b2c3d4e5f6789012345678901234567890123456789012345678901234abcd";
const VALID_SHORT_ID = "a1b2c3d4e5f6";
const VALID_SHELL_ID = "abc1234";

describe("Type Guards", () => {
    describe("isFullEventId", () => {
        test("should return true for valid 64-char hex string", () => {
            expect(isFullEventId(VALID_FULL_ID)).toBe(true);
        });

        test("should return true for all lowercase hex", () => {
            expect(isFullEventId("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")).toBe(true);
        });

        test("should return false for uppercase hex", () => {
            expect(isFullEventId(VALID_FULL_ID.toUpperCase())).toBe(false);
        });

        test("should return false for mixed case hex", () => {
            expect(isFullEventId("A1b2c3d4e5f6789012345678901234567890123456789012345678901234abcd")).toBe(false);
        });

        test("should return false for 63-char string", () => {
            expect(isFullEventId(VALID_FULL_ID.substring(0, 63))).toBe(false);
        });

        test("should return false for 65-char string", () => {
            expect(isFullEventId(VALID_FULL_ID + "0")).toBe(false);
        });

        test("should return false for string with non-hex characters", () => {
            expect(isFullEventId("g1b2c3d4e5f6789012345678901234567890123456789012345678901234abcd")).toBe(false);
        });

        test("should return false for empty string", () => {
            expect(isFullEventId("")).toBe(false);
        });
    });

    describe("isShortEventId", () => {
        test("should return true for valid 12-char hex string", () => {
            expect(isShortEventId(VALID_SHORT_ID)).toBe(true);
        });

        test("should return false for uppercase hex", () => {
            expect(isShortEventId(VALID_SHORT_ID.toUpperCase())).toBe(false);
        });

        test("should return false for 11-char string", () => {
            expect(isShortEventId(VALID_SHORT_ID.substring(0, 11))).toBe(false);
        });

        test("should return false for 13-char string", () => {
            expect(isShortEventId(VALID_SHORT_ID + "0")).toBe(false);
        });

        test("should return false for non-hex characters", () => {
            expect(isShortEventId("g1b2c3d4e5f6")).toBe(false);
        });
    });

    describe("isShellTaskId", () => {
        test("should return true for valid 7-char alphanumeric string", () => {
            expect(isShellTaskId(VALID_SHELL_ID)).toBe(true);
        });

        test("should return true for all digits", () => {
            expect(isShellTaskId("1234567")).toBe(true);
        });

        test("should return true for all letters", () => {
            expect(isShellTaskId("abcdefg")).toBe(true);
        });

        test("should return false for uppercase", () => {
            expect(isShellTaskId("ABC1234")).toBe(false);
        });

        test("should return false for 6-char string", () => {
            expect(isShellTaskId("abc123")).toBe(false);
        });

        test("should return false for 8-char string", () => {
            expect(isShellTaskId("abc12345")).toBe(false);
        });

        test("should return false for special characters", () => {
            expect(isShellTaskId("abc-123")).toBe(false);
        });
    });

    describe("detectIdType", () => {
        test("should detect full event ID", () => {
            expect(detectIdType(VALID_FULL_ID)).toBe("full");
        });

        test("should detect short event ID", () => {
            expect(detectIdType(VALID_SHORT_ID)).toBe("short");
        });

        test("should detect shell task ID", () => {
            expect(detectIdType(VALID_SHELL_ID)).toBe("shell");
        });

        test("should return null for unrecognized format", () => {
            expect(detectIdType("not-an-id")).toBeNull();
        });

        test("should normalize uppercase to lowercase for detection", () => {
            expect(detectIdType(VALID_FULL_ID.toUpperCase())).toBe("full");
        });

        test("should return null for empty string", () => {
            expect(detectIdType("")).toBeNull();
        });
    });
});

describe("Factory Functions", () => {
    describe("createFullEventId", () => {
        test("should create a FullEventId from valid input", () => {
            const id = createFullEventId(VALID_FULL_ID);
            expect(id).toBe(VALID_FULL_ID);
            expect(isFullEventId(id)).toBe(true);
        });

        test("should normalize uppercase to lowercase", () => {
            const id = createFullEventId(VALID_FULL_ID.toUpperCase());
            expect(id).toBe(VALID_FULL_ID);
        });

        test("should throw for invalid input", () => {
            expect(() => createFullEventId("invalid")).toThrow("Invalid FullEventId");
        });

        test("should throw for short ID", () => {
            expect(() => createFullEventId(VALID_SHORT_ID)).toThrow("Invalid FullEventId");
        });
    });

    describe("createShortEventId", () => {
        test("should create a ShortEventId from valid input", () => {
            const id = createShortEventId(VALID_SHORT_ID);
            expect(id).toBe(VALID_SHORT_ID);
            expect(isShortEventId(id)).toBe(true);
        });

        test("should normalize uppercase to lowercase", () => {
            const id = createShortEventId(VALID_SHORT_ID.toUpperCase());
            expect(id).toBe(VALID_SHORT_ID);
        });

        test("should throw for invalid input", () => {
            expect(() => createShortEventId("invalid")).toThrow("Invalid ShortEventId");
        });

        test("should throw for full ID", () => {
            expect(() => createShortEventId(VALID_FULL_ID)).toThrow("Invalid ShortEventId");
        });
    });

    describe("createShellTaskId", () => {
        test("should create a ShellTaskId from valid input", () => {
            const id = createShellTaskId(VALID_SHELL_ID);
            expect(id).toBe(VALID_SHELL_ID);
            expect(isShellTaskId(id)).toBe(true);
        });

        test("should normalize uppercase to lowercase", () => {
            const id = createShellTaskId("ABC1234");
            expect(id).toBe("abc1234");
        });

        test("should throw for invalid input", () => {
            expect(() => createShellTaskId("invalid-id")).toThrow("Invalid ShellTaskId");
        });
    });

    describe("tryCreateFullEventId", () => {
        test("should return FullEventId for valid input", () => {
            const id = tryCreateFullEventId(VALID_FULL_ID);
            expect(id).toBe(VALID_FULL_ID);
        });

        test("should return null for invalid input", () => {
            const id = tryCreateFullEventId("invalid");
            expect(id).toBeNull();
        });
    });

    describe("tryCreateShortEventId", () => {
        test("should return ShortEventId for valid input", () => {
            const id = tryCreateShortEventId(VALID_SHORT_ID);
            expect(id).toBe(VALID_SHORT_ID);
        });

        test("should return null for invalid input", () => {
            const id = tryCreateShortEventId("invalid");
            expect(id).toBeNull();
        });
    });

    describe("tryCreateShellTaskId", () => {
        test("should return ShellTaskId for valid input", () => {
            const id = tryCreateShellTaskId(VALID_SHELL_ID);
            expect(id).toBe(VALID_SHELL_ID);
        });

        test("should return null for invalid input", () => {
            const id = tryCreateShellTaskId("invalid-id");
            expect(id).toBeNull();
        });
    });
});

describe("Conversion Functions", () => {
    describe("shortenEventId", () => {
        test("should return first 12 characters of full ID", () => {
            const fullId = createFullEventId(VALID_FULL_ID);
            const shortId = shortenEventId(fullId);
            expect(shortId).toBe(VALID_FULL_ID.substring(0, 12));
            expect(isShortEventId(shortId)).toBe(true);
        });

        test("should return consistent results", () => {
            const fullId = createFullEventId(VALID_FULL_ID);
            expect(shortenEventId(fullId)).toBe(shortenEventId(fullId));
        });
    });

    describe("toRawString", () => {
        test("should convert FullEventId to string", () => {
            const fullId = createFullEventId(VALID_FULL_ID);
            const raw = toRawString(fullId);
            expect(raw).toBe(VALID_FULL_ID);
            expect(typeof raw).toBe("string");
        });

        test("should convert ShortEventId to string", () => {
            const shortId = createShortEventId(VALID_SHORT_ID);
            const raw = toRawString(shortId);
            expect(raw).toBe(VALID_SHORT_ID);
        });

        test("should convert ShellTaskId to string", () => {
            const shellId = createShellTaskId(VALID_SHELL_ID);
            const raw = toRawString(shellId);
            expect(raw).toBe(VALID_SHELL_ID);
        });
    });
});

describe("Assertion Functions", () => {
    describe("assertFullEventId", () => {
        test("should not throw for valid lowercase full ID", () => {
            expect(() => assertFullEventId(VALID_FULL_ID)).not.toThrow();
        });

        test("should throw for invalid input", () => {
            expect(() => assertFullEventId("invalid")).toThrow("Assertion failed");
        });

        test("should throw for uppercase (strict - no normalization)", () => {
            // Assertions are STRICT: they require lowercase input
            // Use createFullEventId() for normalization
            expect(() => assertFullEventId(VALID_FULL_ID.toUpperCase())).toThrow("Assertion failed");
        });
    });

    describe("assertShortEventId", () => {
        test("should not throw for valid lowercase short ID", () => {
            expect(() => assertShortEventId(VALID_SHORT_ID)).not.toThrow();
        });

        test("should throw for invalid input", () => {
            expect(() => assertShortEventId("invalid")).toThrow("Assertion failed");
        });

        test("should throw for uppercase (strict - no normalization)", () => {
            expect(() => assertShortEventId(VALID_SHORT_ID.toUpperCase())).toThrow("Assertion failed");
        });
    });

    describe("assertShellTaskId", () => {
        test("should not throw for valid lowercase shell ID", () => {
            expect(() => assertShellTaskId(VALID_SHELL_ID)).not.toThrow();
        });

        test("should throw for invalid input", () => {
            expect(() => assertShellTaskId("invalid-id")).toThrow("Assertion failed");
        });

        test("should throw for uppercase (strict - no normalization)", () => {
            expect(() => assertShellTaskId(VALID_SHELL_ID.toUpperCase())).toThrow("Assertion failed");
        });
    });
});

describe("Utility Functions", () => {
    describe("parseEventId", () => {
        test("should parse full event ID", () => {
            const result = parseEventId(VALID_FULL_ID);
            expect(result).not.toBeNull();
            expect(result!.type).toBe("full");
            expect(result!.id).toBe(VALID_FULL_ID);
        });

        test("should parse short event ID", () => {
            const result = parseEventId(VALID_SHORT_ID);
            expect(result).not.toBeNull();
            expect(result!.type).toBe("short");
            expect(result!.id).toBe(VALID_SHORT_ID);
        });

        test("should parse shell task ID", () => {
            const result = parseEventId(VALID_SHELL_ID);
            expect(result).not.toBeNull();
            expect(result!.type).toBe("shell");
            expect(result!.id).toBe(VALID_SHELL_ID);
        });

        test("should return null for unrecognized format", () => {
            const result = parseEventId("not-an-id");
            expect(result).toBeNull();
        });

        test("should trim whitespace", () => {
            const result = parseEventId(`  ${VALID_FULL_ID}  `);
            expect(result).not.toBeNull();
            expect(result!.id).toBe(VALID_FULL_ID);
        });

        test("should normalize to lowercase", () => {
            const result = parseEventId(VALID_FULL_ID.toUpperCase());
            expect(result).not.toBeNull();
            expect(result!.id).toBe(VALID_FULL_ID);
        });
    });
});

describe("Constants", () => {
    test("FULL_EVENT_ID_LENGTH should be 64", () => {
        expect(FULL_EVENT_ID_LENGTH).toBe(64);
    });

    test("SHORT_EVENT_ID_LENGTH should be 12", () => {
        expect(SHORT_EVENT_ID_LENGTH).toBe(12);
    });

    test("SHELL_TASK_ID_LENGTH should be 7", () => {
        expect(SHELL_TASK_ID_LENGTH).toBe(7);
    });

    test("valid IDs should match their expected lengths", () => {
        expect(VALID_FULL_ID.length).toBe(FULL_EVENT_ID_LENGTH);
        expect(VALID_SHORT_ID.length).toBe(SHORT_EVENT_ID_LENGTH);
        expect(VALID_SHELL_ID.length).toBe(SHELL_TASK_ID_LENGTH);
    });
});
