/**
 * Integration test for thinking block filtering in real-world scenarios
 */

import { describe, expect, it } from "vitest";
import { isOnlyThinkingBlocks, stripThinkingBlocks } from "../content-utils";

describe("Thinking Blocks - Real World Integration", () => {
    describe("Agent response scenarios", () => {
        it("should handle Claude-style thinking blocks in agent responses", () => {
            const agentResponse = `<thinking>
The user is asking about implementing a feature.
I need to:
1. Understand the requirements
2. Check existing code
3. Propose a solution
</thinking>

I'll help you implement that feature. Here's what we need to do:

1. First, let's examine the existing codebase
2. Then we'll create the new components
3. Finally, we'll add tests

<thinking>
I should also mention best practices
</thinking>

Make sure to follow the existing patterns in your codebase.`;

            const expected = `I'll help you implement that feature. Here's what we need to do:
1. First, let's examine the existing codebase
2. Then we'll create the new components
3. Finally, we'll add tests
Make sure to follow the existing patterns in your codebase.`;

            expect(stripThinkingBlocks(agentResponse)).toBe(expected);
            expect(isOnlyThinkingBlocks(agentResponse)).toBe(false);
        });

        it("should skip agent messages that are purely thinking", () => {
            const pureThinkingMessage = `<thinking>
The user's previous message was clear.
They want me to implement feature X.
I already provided the solution in my last response.
This triggering event seems to be a duplicate or error.
I shouldn't respond again.
</thinking>`;

            expect(stripThinkingBlocks(pureThinkingMessage)).toBe("");
            expect(isOnlyThinkingBlocks(pureThinkingMessage)).toBe(true);
        });

        it("should handle mixed content with code blocks and thinking", () => {
            const mixedContent = `Here's the implementation:

\`\`\`typescript
function processData(input: string): string {
    return input.trim();
}
\`\`\`

<thinking>
The code is simple but I should explain it
</thinking>

This function takes a string input and returns it trimmed.

<thinking>
Should I add more examples? No, this is sufficient.
</thinking>`;

            const expected = `Here's the implementation:
\`\`\`typescript
function processData(input: string): string {
    return input.trim();
}
\`\`\`
This function takes a string input and returns it trimmed.`;

            expect(stripThinkingBlocks(mixedContent)).toBe(expected);
        });

        it("should handle thinking blocks with special characters and formatting", () => {
            const complexThinking = `Initial response text.

<thinking>
Let me analyze this:
- Point 1: Something with <brackets>
- Point 2: "Quoted text"
- Point 3: Special chars !@#$%^&*()
</thinking>

Final response text.`;

            const expected = `Initial response text.
Final response text.`;

            expect(stripThinkingBlocks(complexThinking)).toBe(expected);
        });

        it("should handle multiple agents in conversation with thinking blocks", () => {
            // Simulate a conversation history where multiple agents have thinking blocks
            const agent1Message =
                "Let me analyze this. <thinking>internal thought</thinking> Here's my analysis.";
            const agent2Message =
                "<THINKING>Responding to agent1</THINKING>I agree with your analysis.";
            const userMessage = "What about edge cases?";
            const agent3Message = "<thinking>Both agents missed edge cases</thinking>";

            expect(stripThinkingBlocks(agent1Message)).toBe(
                "Let me analyze this. Here's my analysis."
            );
            expect(stripThinkingBlocks(agent2Message)).toBe("I agree with your analysis.");
            expect(stripThinkingBlocks(userMessage)).toBe("What about edge cases?");
            expect(stripThinkingBlocks(agent3Message)).toBe("");
            expect(isOnlyThinkingBlocks(agent3Message)).toBe(true);
        });

        it("should preserve important whitespace and formatting", () => {
            const formattedContent = `## Title

<thinking>
This is a section with important formatting
</thinking>

### Subsection

- Item 1
- Item 2

<thinking>Another thought</thinking>

    Code block with indentation
    Line 2 of code

End of content`;

            const expected = `## Title
### Subsection
- Item 1
- Item 2
    Code block with indentation
    Line 2 of code
End of content`;

            expect(stripThinkingBlocks(formattedContent)).toBe(expected);
        });

        it("should handle edge case with unclosed or malformed thinking tags", () => {
            const malformed1 = "Text <thinking>unclosed block";
            const malformed2 = "Text </thinking> without opening";
            const malformed3 = "Text <thinking> proper </thinking> and <thinking> unclosed";

            // Malformed tags should not be processed
            expect(stripThinkingBlocks(malformed1)).toBe(malformed1);
            expect(stripThinkingBlocks(malformed2)).toBe(malformed2);
            // Only the properly closed block should be removed
            expect(stripThinkingBlocks(malformed3)).toBe("Text and <thinking> unclosed");
        });

        it("should handle thinking blocks in delegation responses", () => {
            const delegationResponse = `<thinking>
This is a delegated task from the main agent.
I need to process it carefully.
</thinking>

## Delegated Task Result

Here's what I found:
1. Data point A
2. Data point B

<thinking>
Should I include more details? The requesting agent can ask if needed.
</thinking>

Summary: Task completed successfully.`;

            const expected = `## Delegated Task Result
Here's what I found:
1. Data point A
2. Data point B
Summary: Task completed successfully.`;

            expect(stripThinkingBlocks(delegationResponse)).toBe(expected);
        });

        it("should handle real-world streaming scenarios with partial thinking blocks", () => {
            // Simulate progressive streaming where thinking blocks might be split
            const chunk1 = "Starting response <think";
            const chunk2 = "ing>This is internal</thi";
            const chunk3 = "nking> visible content";

            const fullMessage = chunk1 + chunk2 + chunk3;
            const expected = "Starting response visible content";

            expect(stripThinkingBlocks(fullMessage)).toBe(expected);
        });
    });

    describe("Performance scenarios", () => {
        it("should handle very long messages with multiple thinking blocks efficiently", () => {
            const longMessage = Array(100)
                .fill(null)
                .map((_, i) => `Section ${i}: <thinking>thought ${i}</thinking> Content ${i}`)
                .join("\n");

            const result = stripThinkingBlocks(longMessage);

            // Should not contain any thinking blocks
            expect(result).not.toContain("<thinking>");
            expect(result).not.toContain("</thinking>");

            // Should contain all the content sections
            for (let i = 0; i < 100; i++) {
                expect(result).toContain(`Section ${i}: Content ${i}`);
            }
        });
    });
});
