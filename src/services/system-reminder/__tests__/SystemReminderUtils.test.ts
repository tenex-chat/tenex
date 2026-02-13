/**
 * Unit tests for SystemReminderUtils
 */

import { describe, it, expect } from "bun:test";
import {
    wrapInSystemReminder,
    combineSystemReminders,
    appendSystemReminderToMessage,
    hasSystemReminder,
    extractSystemReminderContent,
} from "../SystemReminderUtils";

describe("SystemReminderUtils", () => {
    describe("wrapInSystemReminder", () => {
        it("should wrap content in system-reminder tags", () => {
            const result = wrapInSystemReminder("Hello, world!");
            expect(result).toBe("<system-reminder>\nHello, world!\n</system-reminder>");
        });

        it("should trim whitespace from content", () => {
            const result = wrapInSystemReminder("  \n  Hello  \n  ");
            expect(result).toBe("<system-reminder>\nHello\n</system-reminder>");
        });

        it("should return empty string for empty content", () => {
            expect(wrapInSystemReminder("")).toBe("");
            expect(wrapInSystemReminder("   ")).toBe("");
        });

        it("should handle multi-line content", () => {
            const content = "Line 1\nLine 2\nLine 3";
            const result = wrapInSystemReminder(content);
            expect(result).toContain("Line 1\nLine 2\nLine 3");
            expect(result).toMatch(/^<system-reminder>/);
            expect(result).toMatch(/<\/system-reminder>$/);
        });
    });

    describe("combineSystemReminders", () => {
        it("should combine multiple contents into one wrapped block", () => {
            const result = combineSystemReminders(["Content 1", "Content 2"]);
            expect(result).toContain("<system-reminder>");
            expect(result).toContain("</system-reminder>");
            expect(result).toContain("Content 1");
            expect(result).toContain("Content 2");
        });

        it("should filter out empty strings", () => {
            const result = combineSystemReminders(["Content 1", "", "  ", "Content 2"]);
            expect(result).toContain("Content 1");
            expect(result).toContain("Content 2");
            // Should not have empty sections
            expect(result).not.toContain("\n\n\n");
        });

        it("should return empty string when all contents are empty", () => {
            const result = combineSystemReminders(["", "   ", ""]);
            expect(result).toBe("");
        });

        it("should separate contents with double newlines", () => {
            const result = combineSystemReminders(["A", "B", "C"]);
            expect(result).toContain("A\n\nB\n\nC");
        });
    });

    describe("appendSystemReminderToMessage", () => {
        it("should append wrapped reminder to existing content", () => {
            const result = appendSystemReminderToMessage("Original message", "Reminder content");
            expect(result).toContain("Original message");
            expect(result).toContain("<system-reminder>");
            expect(result).toContain("Reminder content");
        });

        it("should not double-wrap already wrapped content", () => {
            const alreadyWrapped = "<system-reminder>\nWrapped\n</system-reminder>";
            const result = appendSystemReminderToMessage("Original", alreadyWrapped);
            // Should contain exactly one opening and one closing tag
            const openCount = (result.match(/<system-reminder>/g) || []).length;
            const closeCount = (result.match(/<\/system-reminder>/g) || []).length;
            expect(openCount).toBe(1);
            expect(closeCount).toBe(1);
        });

        it("should return original content when reminder is empty", () => {
            const result = appendSystemReminderToMessage("Original", "");
            expect(result).toBe("Original");
        });
    });

    describe("hasSystemReminder", () => {
        it("should return true when content has system-reminder tags", () => {
            const content = "Hello <system-reminder>test</system-reminder> world";
            expect(hasSystemReminder(content)).toBe(true);
        });

        it("should return false when tags are missing", () => {
            expect(hasSystemReminder("No tags here")).toBe(false);
            expect(hasSystemReminder("<system-reminder>no closing")).toBe(false);
            expect(hasSystemReminder("no opening</system-reminder>")).toBe(false);
        });
    });

    describe("extractSystemReminderContent", () => {
        it("should extract content from system-reminder tags", () => {
            const wrapped = "<system-reminder>\nInner content\n</system-reminder>";
            expect(extractSystemReminderContent(wrapped)).toBe("Inner content");
        });

        it("should return empty string when no tags found", () => {
            expect(extractSystemReminderContent("No tags")).toBe("");
        });

        it("should handle multi-line content", () => {
            const wrapped = "<system-reminder>\nLine 1\nLine 2\n</system-reminder>";
            const result = extractSystemReminderContent(wrapped);
            expect(result).toContain("Line 1");
            expect(result).toContain("Line 2");
        });
    });
});
