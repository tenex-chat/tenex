/**
 * Tests for image placeholder strategy
 *
 * Images in tool results should:
 * 1. First appearance: Show full ImagePart for agent to see/analyze
 * 2. Subsequent appearances: Replace with text placeholder referencing eventId
 *
 * This prevents token accumulation from screenshots (estimated ~1,600 tokens per image)
 * while preserving retrieval capability via fs_read(tool='<eventId>').
 */

import { describe, it, expect, beforeEach } from "bun:test";
import type { ToolResultPart } from "ai";
import {
    createImagePlaceholder,
    processToolResultWithImageTracking,
    type ImageTracker,
    createImageTracker,
    countImagesInToolResult,
    IMAGE_PLACEHOLDER_PREFIX,
    extractImageUrlsFromToolResult,
} from "../image-placeholder";

describe("image-placeholder", () => {
    describe("createImagePlaceholder", () => {
        it("should create placeholder text with eventId reference", () => {
            const placeholder = createImagePlaceholder("screenshot.png", "event-123");

            expect(placeholder).toContain("[Image:");
            expect(placeholder).toContain("screenshot.png");
            expect(placeholder).toContain("fs_read(tool=\"event-123\")");
        });

        it("should handle URLs by extracting filename", () => {
            const placeholder = createImagePlaceholder(
                "https://example.com/uploads/screenshot.png?v=123",
                "event-456"
            );

            expect(placeholder).toContain("screenshot.png");
            expect(placeholder).toContain("fs_read(tool=\"event-456\")");
        });

        it("should handle missing eventId with graceful fallback", () => {
            const placeholder = createImagePlaceholder("image.jpg", undefined);

            expect(placeholder).toContain("[Image:");
            expect(placeholder).toContain("image.jpg");
            expect(placeholder).toContain("original context lost");
        });
    });

    describe("createImageTracker", () => {
        it("should create empty tracker", () => {
            const tracker = createImageTracker();

            expect(tracker.hasBeenSeen("https://example.com/img.png")).toBe(false);
        });

        it("should track seen images", () => {
            const tracker = createImageTracker();

            tracker.markAsSeen("https://example.com/img.png");

            expect(tracker.hasBeenSeen("https://example.com/img.png")).toBe(true);
        });

        it("should not report unseen images as seen", () => {
            const tracker = createImageTracker();

            tracker.markAsSeen("https://example.com/first.png");

            expect(tracker.hasBeenSeen("https://example.com/second.png")).toBe(false);
        });

        it("should handle multiple images", () => {
            const tracker = createImageTracker();

            tracker.markAsSeen("https://example.com/a.png");
            tracker.markAsSeen("https://example.com/b.png");

            expect(tracker.hasBeenSeen("https://example.com/a.png")).toBe(true);
            expect(tracker.hasBeenSeen("https://example.com/b.png")).toBe(true);
            expect(tracker.hasBeenSeen("https://example.com/c.png")).toBe(false);
        });
    });

    describe("extractImageUrlsFromToolResult", () => {
        it("should extract image URLs from text output", () => {
            const toolData: ToolResultPart[] = [{
                type: "tool-result",
                toolCallId: "call-1",
                toolName: "screenshot",
                output: {
                    type: "text",
                    value: "Screenshot saved: https://example.com/screenshot.png",
                },
            }];

            const urls = extractImageUrlsFromToolResult(toolData);

            expect(urls).toHaveLength(1);
            expect(urls[0]).toBe("https://example.com/screenshot.png");
        });

        it("should extract multiple image URLs", () => {
            const toolData: ToolResultPart[] = [{
                type: "tool-result",
                toolCallId: "call-1",
                toolName: "screenshot",
                output: {
                    type: "text",
                    value: "First: https://example.com/a.png\nSecond: https://example.com/b.jpg",
                },
            }];

            const urls = extractImageUrlsFromToolResult(toolData);

            expect(urls).toHaveLength(2);
            expect(urls).toContain("https://example.com/a.png");
            expect(urls).toContain("https://example.com/b.jpg");
        });

        it("should return empty array for tool results without images", () => {
            const toolData: ToolResultPart[] = [{
                type: "tool-result",
                toolCallId: "call-1",
                toolName: "echo",
                output: {
                    type: "text",
                    value: "Hello, world! Visit https://example.com for more.",
                },
            }];

            const urls = extractImageUrlsFromToolResult(toolData);

            expect(urls).toHaveLength(0);
        });

        it("should handle string output directly", () => {
            const toolData: ToolResultPart[] = [{
                type: "tool-result",
                toolCallId: "call-1",
                toolName: "screenshot",
                output: "Screenshot saved: https://example.com/direct.png",
            }];

            const urls = extractImageUrlsFromToolResult(toolData);

            expect(urls).toHaveLength(1);
            expect(urls[0]).toBe("https://example.com/direct.png");
        });
    });

    describe("countImagesInToolResult", () => {
        it("should count images in tool result text", () => {
            const toolData: ToolResultPart[] = [{
                type: "tool-result",
                toolCallId: "call-1",
                toolName: "test",
                output: {
                    type: "text",
                    value: "Images: https://example.com/a.png and https://example.com/b.jpg",
                },
            }];

            expect(countImagesInToolResult(toolData)).toBe(2);
        });

        it("should return 0 for no images", () => {
            const toolData: ToolResultPart[] = [{
                type: "tool-result",
                toolCallId: "call-1",
                toolName: "test",
                output: { type: "text", value: "No images here" },
            }];

            expect(countImagesInToolResult(toolData)).toBe(0);
        });
    });

    describe("processToolResultWithImageTracking", () => {
        let tracker: ImageTracker;

        beforeEach(() => {
            tracker = createImageTracker();
        });

        it("should keep full image on first appearance", () => {
            const toolData: ToolResultPart[] = [{
                type: "tool-result",
                toolCallId: "call-1",
                toolName: "screenshot",
                output: {
                    type: "text",
                    value: "Screenshot: https://example.com/first.png",
                },
            }];

            const { processedParts, replacedCount, uniqueReplacedCount } = processToolResultWithImageTracking(
                toolData,
                tracker,
                "event-123"
            );

            // First appearance: should NOT be a placeholder
            const outputText = getOutputText(processedParts[0]);
            expect(outputText).not.toContain(IMAGE_PLACEHOLDER_PREFIX);
            expect(outputText).toContain("https://example.com/first.png");

            // Image should now be tracked
            expect(tracker.hasBeenSeen("https://example.com/first.png")).toBe(true);

            // No replacements on first appearance
            expect(replacedCount).toBe(0);
            expect(uniqueReplacedCount).toBe(0);
        });

        it("should replace image with placeholder on second appearance", () => {
            const toolData: ToolResultPart[] = [{
                type: "tool-result",
                toolCallId: "call-1",
                toolName: "screenshot",
                output: {
                    type: "text",
                    value: "Screenshot: https://example.com/seen.png",
                },
            }];

            // First call - marks as seen
            tracker.markAsSeen("https://example.com/seen.png");

            // Second call - should create placeholder
            const { processedParts, replacedCount, uniqueReplacedCount } = processToolResultWithImageTracking(
                toolData,
                tracker,
                "event-456"
            );

            const outputText = getOutputText(processedParts[0]);
            expect(outputText).toContain(IMAGE_PLACEHOLDER_PREFIX);
            expect(outputText).toContain("fs_read(tool=\"event-456\")");

            // One replacement occurred
            expect(replacedCount).toBe(1);
            expect(uniqueReplacedCount).toBe(1);
        });

        it("should handle mixed new and seen images", () => {
            const toolData: ToolResultPart[] = [{
                type: "tool-result",
                toolCallId: "call-1",
                toolName: "screenshot",
                output: {
                    type: "text",
                    value: "Old: https://example.com/old.png\nNew: https://example.com/new.png",
                },
            }];

            // Only old image has been seen
            tracker.markAsSeen("https://example.com/old.png");

            const { processedParts, replacedCount, uniqueReplacedCount } = processToolResultWithImageTracking(
                toolData,
                tracker,
                "event-789"
            );

            const outputText = getOutputText(processedParts[0]);

            // Old image should be placeholder
            expect(outputText).toContain(IMAGE_PLACEHOLDER_PREFIX);
            expect(outputText).toContain("old.png");

            // New image should be preserved (full URL)
            expect(outputText).toContain("https://example.com/new.png");

            // Both should now be tracked
            expect(tracker.hasBeenSeen("https://example.com/old.png")).toBe(true);
            expect(tracker.hasBeenSeen("https://example.com/new.png")).toBe(true);

            // Only one replacement (old.png)
            expect(replacedCount).toBe(1);
            expect(uniqueReplacedCount).toBe(1);
        });

        it("should preserve tool metadata", () => {
            const toolData: ToolResultPart[] = [{
                type: "tool-result",
                toolCallId: "specific-call-id",
                toolName: "specific-tool-name",
                output: {
                    type: "text",
                    value: "Content: https://example.com/img.png",
                },
            }];

            tracker.markAsSeen("https://example.com/img.png");

            const { processedParts } = processToolResultWithImageTracking(
                toolData,
                tracker,
                "event-1"
            );

            expect(processedParts[0].type).toBe("tool-result");
            expect(processedParts[0].toolCallId).toBe("specific-call-id");
            expect(processedParts[0].toolName).toBe("specific-tool-name");
        });

        it("should handle multiple tool results in array", () => {
            const toolData: ToolResultPart[] = [
                {
                    type: "tool-result",
                    toolCallId: "call-1",
                    toolName: "screenshot",
                    output: { type: "text", value: "A: https://example.com/a.png" },
                },
                {
                    type: "tool-result",
                    toolCallId: "call-2",
                    toolName: "screenshot",
                    output: { type: "text", value: "B: https://example.com/b.png" },
                },
            ];

            tracker.markAsSeen("https://example.com/a.png");
            // b.png is new

            const { processedParts, replacedCount, uniqueReplacedCount } = processToolResultWithImageTracking(
                toolData,
                tracker,
                "event-multi"
            );

            expect(processedParts).toHaveLength(2);

            // First result has seen image - placeholder
            const output1 = getOutputText(processedParts[0]);
            expect(output1).toContain(IMAGE_PLACEHOLDER_PREFIX);

            // Second result has new image - preserved
            const output2 = getOutputText(processedParts[1]);
            expect(output2).not.toContain(IMAGE_PLACEHOLDER_PREFIX);
            expect(output2).toContain("https://example.com/b.png");

            // One replacement
            expect(replacedCount).toBe(1);
            expect(uniqueReplacedCount).toBe(1);
        });

        it("should not modify tool results without images", () => {
            const toolData: ToolResultPart[] = [{
                type: "tool-result",
                toolCallId: "call-1",
                toolName: "echo",
                output: {
                    type: "text",
                    value: "Just plain text, no images here.",
                },
            }];

            const { processedParts, replacedCount, uniqueReplacedCount } = processToolResultWithImageTracking(
                toolData,
                tracker,
                "event-no-img"
            );

            const outputText = getOutputText(processedParts[0]);
            expect(outputText).toBe("Just plain text, no images here.");

            // No replacements
            expect(replacedCount).toBe(0);
            expect(uniqueReplacedCount).toBe(0);
        });

        it("should handle tool result with object value", () => {
            const toolData: ToolResultPart[] = [{
                type: "tool-result",
                toolCallId: "call-1",
                toolName: "json-tool",
                output: {
                    type: "json",
                    value: { imageUrl: "https://example.com/obj.png" },
                },
            }];

            // Object outputs should be passed through without modification
            // (image tracking only applies to text content)
            const { processedParts, replacedCount } = processToolResultWithImageTracking(
                toolData,
                tracker,
                "event-obj"
            );

            expect(processedParts[0].output).toEqual({
                type: "json",
                value: { imageUrl: "https://example.com/obj.png" },
            });
            expect(replacedCount).toBe(0);
        });

        it("should replace ALL occurrences of duplicate same-URL in one tool output", () => {
            const toolData: ToolResultPart[] = [{
                type: "tool-result",
                toolCallId: "call-1",
                toolName: "screenshot",
                output: {
                    type: "text",
                    value: "Image 1: https://example.com/dup.png\nImage 2: https://example.com/dup.png\nImage 3: https://example.com/dup.png",
                },
            }];

            // Mark image as seen
            tracker.markAsSeen("https://example.com/dup.png");

            const { processedParts, replacedCount, uniqueReplacedCount } = processToolResultWithImageTracking(
                toolData,
                tracker,
                "event-dup"
            );

            const outputText = getOutputText(processedParts[0]);

            // Should NOT contain any original URLs
            expect(outputText).not.toContain("https://example.com/dup.png");

            // Should contain placeholder (checking that replacement occurred)
            expect(outputText).toContain(IMAGE_PLACEHOLDER_PREFIX);

            // Count occurrences of placeholder
            const placeholderCount = (outputText.match(/\[Image:/g) || []).length;
            expect(placeholderCount).toBe(3);

            // Stats: 3 replacements, 1 unique URL
            expect(replacedCount).toBe(3);
            expect(uniqueReplacedCount).toBe(1);
        });

        it("should handle URLs followed by punctuation (., ), ])", () => {
            const toolData: ToolResultPart[] = [{
                type: "tool-result",
                toolCallId: "call-1",
                toolName: "screenshot",
                output: {
                    type: "text",
                    value: "See (https://example.com/paren.png). Also check https://example.com/period.png.",
                },
            }];

            // Mark both as seen
            tracker.markAsSeen("https://example.com/paren.png");
            tracker.markAsSeen("https://example.com/period.png");

            const { processedParts, replacedCount } = processToolResultWithImageTracking(
                toolData,
                tracker,
                "event-punct"
            );

            const outputText = getOutputText(processedParts[0]);

            // Should NOT contain original URLs
            expect(outputText).not.toContain("https://example.com/paren.png");
            expect(outputText).not.toContain("https://example.com/period.png");

            // Should have 2 replacements
            expect(replacedCount).toBe(2);
        });

        it("should handle missing eventId with graceful fallback in placeholder", () => {
            const toolData: ToolResultPart[] = [{
                type: "tool-result",
                toolCallId: "call-1",
                toolName: "screenshot",
                output: {
                    type: "text",
                    value: "Screenshot: https://example.com/no-event.png",
                },
            }];

            tracker.markAsSeen("https://example.com/no-event.png");

            const { processedParts, replacedCount } = processToolResultWithImageTracking(
                toolData,
                tracker,
                undefined // No eventId
            );

            const outputText = getOutputText(processedParts[0]);

            expect(outputText).toContain(IMAGE_PLACEHOLDER_PREFIX);
            expect(outputText).toContain("original context lost");
            expect(replacedCount).toBe(1);
        });
    });

    describe("IMAGE_PLACEHOLDER_PREFIX constant", () => {
        it("should be a recognizable string", () => {
            expect(IMAGE_PLACEHOLDER_PREFIX).toBe("[Image:");
        });
    });
});

// Helper function to extract text from output
function getOutputText(part: ToolResultPart): string {
    const output = part.output as unknown;
    if (typeof output === "string") {
        return output;
    }
    if (output && typeof output === "object" && "value" in output) {
        const value = (output as { value: unknown }).value;
        if (typeof value === "string") {
            return value;
        }
    }
    return "";
}
