/**
 * Unit tests for content utilities - thinking block handling
 */

import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { describe, expect, it } from "bun:test";
import {
    countThinkingBlocks,
    hasReasoningTag,
    hasThinkingBlocks,
    isOnlyThinkingBlocks,
    stripThinkingBlocks,
} from "../content-utils";

describe("Content Utils - Thinking Block Handling", () => {
    describe("stripThinkingBlocks", () => {
        it("should remove a single thinking block", () => {
            const input = "Hello <thinking>internal thoughts</thinking> World";
            const expected = "Hello World";
            expect(stripThinkingBlocks(input)).toBe(expected);
        });

        it("should remove multiple thinking blocks", () => {
            const input =
                "Start <thinking>thought 1</thinking> middle <thinking>thought 2</thinking> end";
            const expected = "Start  middle  end";
            expect(stripThinkingBlocks(input)).toBe(expected.replace(/\s+/g, " ").trim());
        });

        it("should handle thinking blocks with attributes", () => {
            const input = 'Text <thinking class="deep">internal</thinking> more text';
            const expected = "Text  more text";
            expect(stripThinkingBlocks(input)).toBe(expected.replace(/\s+/g, " ").trim());
        });

        it("should handle case-insensitive thinking tags", () => {
            const input1 = "Before <Thinking>thoughts</Thinking> after";
            const input2 = "Before <THINKING>thoughts</THINKING> after";
            const input3 = "Before <ThInKiNg>thoughts</ThInKiNg> after";
            const expected = "Before  after";

            expect(stripThinkingBlocks(input1)).toBe(expected.replace(/\s+/g, " ").trim());
            expect(stripThinkingBlocks(input2)).toBe(expected.replace(/\s+/g, " ").trim());
            expect(stripThinkingBlocks(input3)).toBe(expected.replace(/\s+/g, " ").trim());
        });

        it("should handle multi-line thinking blocks", () => {
            const input = `Hello world
<thinking>
This is a 
multi-line
thinking block
</thinking>
End of message`;
            const expected = "Hello world\nEnd of message";
            expect(stripThinkingBlocks(input)).toBe(expected);
        });

        it("should collapse multiple newlines after removal", () => {
            const input = `Start

<thinking>thoughts</thinking>


End`;
            const expected = "Start\nEnd";
            expect(stripThinkingBlocks(input)).toBe(expected);
        });

        it("should collapse multiple blank lines to single newline", () => {
            const input = `Line 1



Line 2<thinking>test</thinking>




Line 3`;
            const expected = "Line 1\nLine 2\nLine 3";
            expect(stripThinkingBlocks(input)).toBe(expected);
        });

        it("should return empty string for content with only thinking blocks", () => {
            const input = "<thinking>only thoughts here</thinking>";
            expect(stripThinkingBlocks(input)).toBe("");
        });

        it("should handle nested content correctly (non-nested thinking blocks)", () => {
            // Note: The regex is non-greedy and will match the first closing tag it finds
            const input = "Text <thinking>outer <thinking>inner</thinking> outer</thinking> Text";
            // This will match: <thinking>outer <thinking>inner</thinking>
            // Leaving: "Text  outer</thinking> Text"
            const result = stripThinkingBlocks(input);
            expect(result).toBe("Text outer</thinking> Text");
        });

        it("should preserve content with no thinking blocks", () => {
            const input = "This is regular content with no thinking blocks";
            expect(stripThinkingBlocks(input)).toBe(input);
        });

        it("should handle empty input", () => {
            expect(stripThinkingBlocks("")).toBe("");
            expect(stripThinkingBlocks("   ")).toBe("");
        });

        it("should handle malformed tags (not closed properly)", () => {
            const input = "Text <thinking>unclosed";
            // Malformed tags should not be matched
            expect(stripThinkingBlocks(input)).toBe(input);
        });
    });

    describe("isOnlyThinkingBlocks", () => {
        it("should return true for content with only thinking blocks", () => {
            expect(isOnlyThinkingBlocks("<thinking>only thoughts</thinking>")).toBe(true);
            expect(
                isOnlyThinkingBlocks("<thinking>thought1</thinking><thinking>thought2</thinking>")
            ).toBe(true);
            expect(isOnlyThinkingBlocks("  <thinking>thoughts</thinking>  ")).toBe(true);
        });

        it("should return false for content with text and thinking blocks", () => {
            expect(isOnlyThinkingBlocks("Text <thinking>thoughts</thinking>")).toBe(false);
            expect(isOnlyThinkingBlocks("<thinking>thoughts</thinking> Text")).toBe(false);
            expect(isOnlyThinkingBlocks("Start <thinking>mid</thinking> End")).toBe(false);
        });

        it("should return false for content with no thinking blocks", () => {
            expect(isOnlyThinkingBlocks("Regular text content")).toBe(false);
        });

        it("should return false for empty content", () => {
            expect(isOnlyThinkingBlocks("")).toBe(false);
            expect(isOnlyThinkingBlocks("   ")).toBe(false);
        });

        it("should handle case-insensitive tags", () => {
            expect(isOnlyThinkingBlocks("<THINKING>thoughts</THINKING>")).toBe(true);
            expect(isOnlyThinkingBlocks("<Thinking>thoughts</Thinking>")).toBe(true);
        });

        it("should handle multiple thinking blocks with only whitespace between", () => {
            const input = `<thinking>first</thinking>
            
            <thinking>second</thinking>`;
            expect(isOnlyThinkingBlocks(input)).toBe(true);
        });
    });

    describe("hasThinkingBlocks", () => {
        it("should detect presence of thinking blocks", () => {
            expect(hasThinkingBlocks("Text <thinking>thoughts</thinking>")).toBe(true);
            expect(hasThinkingBlocks("<thinking>thoughts</thinking>")).toBe(true);
            expect(hasThinkingBlocks("No thinking here")).toBe(false);
        });

        it("should detect case-insensitive thinking blocks", () => {
            expect(hasThinkingBlocks("<THINKING>test</THINKING>")).toBe(true);
            expect(hasThinkingBlocks("<Thinking>test</Thinking>")).toBe(true);
        });

        it("should handle empty input", () => {
            expect(hasThinkingBlocks("")).toBe(false);
        });
    });

    describe("countThinkingBlocks", () => {
        it("should count thinking blocks correctly", () => {
            expect(countThinkingBlocks("No blocks here")).toBe(0);
            expect(countThinkingBlocks("<thinking>one</thinking>")).toBe(1);
            expect(
                countThinkingBlocks("<thinking>one</thinking> text <thinking>two</thinking>")
            ).toBe(2);
            expect(
                countThinkingBlocks(
                    "<thinking>1</thinking><thinking>2</thinking><thinking>3</thinking>"
                )
            ).toBe(3);
        });

        it("should count case-insensitive blocks", () => {
            const input = "<thinking>1</thinking> <THINKING>2</THINKING> <Thinking>3</Thinking>";
            expect(countThinkingBlocks(input)).toBe(3);
        });

        it("should handle empty input", () => {
            expect(countThinkingBlocks("")).toBe(0);
        });
    });

    describe("hasReasoningTag", () => {
        it("should detect reasoning tag", () => {
            const event = {
                tags: [["reasoning"], ["E", "root-id"], ["e", "parent-id"]],
            } as unknown as NDKEvent;

            expect(hasReasoningTag(event)).toBe(true);
        });

        it("should return false when no reasoning tag present", () => {
            const event = {
                tags: [
                    ["E", "root-id"],
                    ["e", "parent-id"],
                    ["p", "pubkey"],
                ],
            } as unknown as NDKEvent;

            expect(hasReasoningTag(event)).toBe(false);
        });

        it("should return false for reasoning tag with additional values", () => {
            // We only want to match ["reasoning"], not ["reasoning", "something-else"]
            const event = {
                tags: [
                    ["reasoning", "extra-value"],
                    ["E", "root-id"],
                ],
            } as unknown as NDKEvent;

            expect(hasReasoningTag(event)).toBe(false);
        });

        it("should handle events with no tags", () => {
            const event = {
                tags: [],
            } as unknown as NDKEvent;

            expect(hasReasoningTag(event)).toBe(false);
        });

        it("should handle events with undefined tags", () => {
            const event = {} as unknown as NDKEvent;

            expect(hasReasoningTag(event)).toBe(false);
        });
    });

    describe("Integration scenarios", () => {
        it("should handle a complex message with interleaved content and thinking", () => {
            const input = `Hello, I need to help you with this task.

<thinking>
Let me analyze what the user is asking for:
1. They want help with X
2. I should consider Y
3. The best approach is Z
</thinking>

Based on my analysis, here's what I recommend:

1. First, do this
2. Then, do that

<thinking>
I should also mention the edge cases
</thinking>

Don't forget to handle edge cases!`;

            const expected = `Hello, I need to help you with this task.
Based on my analysis, here's what I recommend:
1. First, do this
2. Then, do that
Don't forget to handle edge cases!`;

            expect(stripThinkingBlocks(input)).toBe(expected);
        });

        it("should properly identify message that becomes empty after stripping", () => {
            const pureThinking = `<thinking>
This message is entirely composed of thinking.
No actual content for the user.
Just internal reasoning.
</thinking>`;

            expect(stripThinkingBlocks(pureThinking)).toBe("");
            expect(isOnlyThinkingBlocks(pureThinking)).toBe(true);
        });

        it("should handle real-world agent response format", () => {
            const agentResponse = `<thinking>
The user is asking about database optimization.
I should provide concrete steps.
</thinking>

To optimize your database performance:

1. Add appropriate indexes
2. Optimize your queries
3. Consider caching strategies

<thinking>
I should also mention monitoring
</thinking>

Remember to monitor performance metrics after making changes.`;

            const expected = `To optimize your database performance:
1. Add appropriate indexes
2. Optimize your queries
3. Consider caching strategies
Remember to monitor performance metrics after making changes.`;

            expect(stripThinkingBlocks(agentResponse)).toBe(expected);
            expect(isOnlyThinkingBlocks(agentResponse)).toBe(false);
            expect(hasThinkingBlocks(agentResponse)).toBe(true);
            expect(countThinkingBlocks(agentResponse)).toBe(2);
        });
    });
});
