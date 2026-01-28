import { describe, it, expect } from "vitest";
import {
    parseRelativeDelay,
    formatDelay,
    formatExecuteAt,
} from "@/services/scheduling/utils";

/**
 * Tests for one-off task scheduling utility functions.
 * These tests verify the relative delay parsing, formatting, and timestamp handling.
 */

describe("parseRelativeDelay", () => {
    it("should parse minutes correctly", () => {
        expect(parseRelativeDelay("5m")).toBe(5 * 60 * 1000);
        expect(parseRelativeDelay("30m")).toBe(30 * 60 * 1000);
        expect(parseRelativeDelay("1m")).toBe(60 * 1000);
    });

    it("should parse hours correctly", () => {
        expect(parseRelativeDelay("2h")).toBe(2 * 60 * 60 * 1000);
        expect(parseRelativeDelay("24h")).toBe(24 * 60 * 60 * 1000);
        expect(parseRelativeDelay("1h")).toBe(60 * 60 * 1000);
    });

    it("should parse days correctly", () => {
        expect(parseRelativeDelay("3d")).toBe(3 * 24 * 60 * 60 * 1000);
        expect(parseRelativeDelay("1d")).toBe(24 * 60 * 60 * 1000);
        expect(parseRelativeDelay("7d")).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it("should handle decimal values", () => {
        expect(parseRelativeDelay("1.5h")).toBe(1.5 * 60 * 60 * 1000);
        expect(parseRelativeDelay("0.5d")).toBe(0.5 * 24 * 60 * 60 * 1000);
    });

    it("should be case-insensitive", () => {
        expect(parseRelativeDelay("5M")).toBe(5 * 60 * 1000);
        expect(parseRelativeDelay("2H")).toBe(2 * 60 * 60 * 1000);
        expect(parseRelativeDelay("3D")).toBe(3 * 24 * 60 * 60 * 1000);
    });

    it("should return null for invalid formats", () => {
        expect(parseRelativeDelay("5")).toBeNull();
        expect(parseRelativeDelay("m")).toBeNull();
        expect(parseRelativeDelay("5x")).toBeNull();
        expect(parseRelativeDelay("")).toBeNull();
        expect(parseRelativeDelay("5 minutes")).toBeNull();
        expect(parseRelativeDelay("five m")).toBeNull();
    });

    it("should allow whitespace between number and unit", () => {
        expect(parseRelativeDelay("5 m")).toBe(5 * 60 * 1000);
        expect(parseRelativeDelay("2 h")).toBe(2 * 60 * 60 * 1000);
    });
});

describe("formatDelay", () => {
    it("should format singular units correctly", () => {
        expect(formatDelay("1m")).toBe("1 minute");
        expect(formatDelay("1h")).toBe("1 hour");
        expect(formatDelay("1d")).toBe("1 day");
    });

    it("should format plural units correctly", () => {
        expect(formatDelay("5m")).toBe("5 minutes");
        expect(formatDelay("2h")).toBe("2 hours");
        expect(formatDelay("3d")).toBe("3 days");
    });

    it("should return original string for invalid formats", () => {
        expect(formatDelay("invalid")).toBe("invalid");
        expect(formatDelay("5x")).toBe("5x");
    });
});

describe("formatExecuteAt", () => {
    it("should format valid ISO timestamps", () => {
        const result = formatExecuteAt("2024-01-30T10:00:00Z");
        expect(result).toContain("UTC");
        expect(result).toContain("Jan");
        expect(result).toContain("30");
        expect(result).toContain("2024");
    });

    it("should return 'Invalid date' for invalid timestamps", () => {
        expect(formatExecuteAt("not-a-date")).toBe("Invalid date");
        expect(formatExecuteAt("")).toBe("Invalid date");
        expect(formatExecuteAt("2024-99-99")).toBe("Invalid date");
    });
});

describe("ScheduledTask type with oneoff", () => {
    it("should accept oneoff task type", () => {
        const task = {
            id: "test-123",
            schedule: "2024-01-30T10:00:00Z",
            prompt: "Test prompt",
            fromPubkey: "abc123",
            toPubkey: "def456",
            projectId: "proj-1",
            type: "oneoff" as const,
            executeAt: "2024-01-30T10:00:00Z",
        };

        expect(task.type).toBe("oneoff");
        expect(task.executeAt).toBeDefined();
    });

    it("should default to cron type for backward compatibility", () => {
        const task = {
            id: "test-456",
            schedule: "0 9 * * *",
            prompt: "Daily task",
            fromPubkey: "abc123",
            toPubkey: "def456",
            projectId: "proj-1",
            // No type field - backward compatible
        };

        // When type is undefined, it should be treated as cron
        expect(task.type).toBeUndefined();
    });
});
