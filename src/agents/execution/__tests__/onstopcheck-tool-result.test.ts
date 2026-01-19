/**
 * Test for the bug where tool results were being lost in onStopCheck
 *
 * Root cause: The code was accessing `tr.result` but the AI SDK provides `tr.output`
 *
 * In AgentExecutor.ts onStopCheck:
 *   toolResults.map((tr: { toolCallId: string; toolName: string; result: unknown }) => ...)
 *
 * But AI SDK's TypedToolResult has:
 *   { type: 'tool-result'; toolCallId: string; toolName: string; output: unknown; ... }
 *
 * So `tr.result` is always undefined, causing the fallback to { type: "text", value: "" }
 */

import { describe, it, expect } from "bun:test";
import { isStopExecutionSignal, extractPendingDelegations } from "@/services/ral/types";

describe("onStopCheck tool result mapping - BUG REPRODUCTION", () => {
    // Simulating the AI SDK's TypedToolResult structure
    interface AISDKToolResult {
        type: "tool-result";
        toolCallId: string;
        toolName: string;
        input: unknown;
        output: unknown;  // <-- AI SDK uses 'output'
        providerExecuted?: boolean;
    }

    // What the buggy code expected
    interface BuggyToolResult {
        toolCallId: string;
        toolName: string;
        result: unknown;  // <-- Buggy code looked for 'result'
    }

    it("should demonstrate the bug: accessing tr.result on AI SDK result gives undefined", () => {
        // This is what the AI SDK provides
        const aiSDKResult: AISDKToolResult = {
            type: "tool-result",
            toolCallId: "call_123",
            toolName: "delegate",
            input: { delegations: [{ recipient: "researcher", prompt: "research" }] },
            output: {  // The actual tool output is in 'output'
                __stopExecution: true,
                pendingDelegations: [{ delegationConversationId: "e1", recipientPubkey: "pk1" }],
                delegationEventIds: { pk1: "e1" },
                message: "Delegated to researcher",
            },
        };

        // What the buggy code does - cast to wrong type and access .result
        const asBuggy = aiSDKResult as unknown as BuggyToolResult;

        // BUG: tr.result is undefined because AI SDK uses 'output'
        expect(asBuggy.result).toBeUndefined();

        // The buggy fallback logic:
        const buggyOutput = asBuggy.result !== undefined
            ? asBuggy.result
            : { type: "text", value: "" };

        // This is why we see empty output!
        expect(buggyOutput).toEqual({ type: "text", value: "" });
    });

    it("should show the fix: access tr.output instead of tr.result", () => {
        const aiSDKResult: AISDKToolResult = {
            type: "tool-result",
            toolCallId: "call_123",
            toolName: "delegate",
            input: { delegations: [{ recipient: "researcher", prompt: "research" }] },
            output: {
                __stopExecution: true,
                pendingDelegations: [{ delegationConversationId: "e1", recipientPubkey: "pk1" }],
                delegationEventIds: { pk1: "e1" },
                message: "Delegated to researcher",
            },
        };

        // CORRECT: Access 'output' not 'result'
        const correctOutput = aiSDKResult.output !== undefined
            ? aiSDKResult.output
            : { type: "text", value: "" };

        // Now we get the actual output
        expect(correctOutput).toEqual({
            __stopExecution: true,
            pendingDelegations: [{ delegationConversationId: "e1", recipientPubkey: "pk1" }],
            delegationEventIds: { pk1: "e1" },
            message: "Delegated to researcher",
        });

        // And it's definitely not empty
        expect(correctOutput).not.toEqual({ type: "text", value: "" });
    });

    it("should simulate the complete fix for onStopCheck toolResult mapping", () => {
        // Simulate the step.toolResults array from AI SDK
        const toolResults: AISDKToolResult[] = [
            {
                type: "tool-result",
                toolCallId: "call_456",
                toolName: "delegate",
                input: { delegations: [{ recipient: "agent", prompt: "task" }] },
                output: {
                    __stopExecution: true,
                    pendingDelegations: [
                        { eventId: "ev1", recipientPubkey: "pk1", recipientSlug: "agent", prompt: "task" }
                    ],
                    delegationEventIds: { pk1: "ev1" },
                    message: "Delegated to: @agent -> ev1",
                },
            },
        ];

        // FIXED: Use 'output' in the type and access
        const fixedMapping = toolResults.map((tr) => ({
            type: "tool-result" as const,
            toolCallId: tr.toolCallId,
            toolName: tr.toolName,
            output: tr.output !== undefined ? tr.output : { type: "text", value: "" },
        }));

        // Now the output is correctly preserved
        expect(fixedMapping[0].output).toHaveProperty("__stopExecution", true);
        expect(fixedMapping[0].output).toHaveProperty("delegationEventIds");
        expect((fixedMapping[0].output as any).message).toBe("Delegated to: @agent -> ev1");
    });
});

describe("isStopExecutionSignal and extractPendingDelegations - MCP wrapped format", () => {
    const directSignal = {
        __stopExecution: true as const,
        pendingDelegations: [
            {
                delegationConversationId: "event123",
                recipientPubkey: "pk1",
                senderPubkey: "pk2",
                prompt: "do something",
                ralNumber: 1,
            },
        ],
    };

    it("should detect direct StopExecutionSignal", () => {
        expect(isStopExecutionSignal(directSignal)).toBe(true);
    });

    it("should extract pending delegations from direct StopExecutionSignal", () => {
        const delegations = extractPendingDelegations(directSignal);
        expect(delegations).not.toBeNull();
        expect(delegations?.length).toBe(1);
        expect(delegations?.[0].delegationConversationId).toBe("event123");
    });

    it("should detect MCP-wrapped StopExecutionSignal (array format)", () => {
        // This is what Claude Code SDK produces
        const mcpWrapped = [
            { type: "text", text: JSON.stringify(directSignal) }
        ];
        expect(isStopExecutionSignal(mcpWrapped)).toBe(true);
    });

    it("should extract pending delegations from MCP-wrapped format (array)", () => {
        const mcpWrapped = [
            { type: "text", text: JSON.stringify(directSignal) }
        ];
        const delegations = extractPendingDelegations(mcpWrapped);
        expect(delegations).not.toBeNull();
        expect(delegations?.length).toBe(1);
        expect(delegations?.[0].delegationConversationId).toBe("event123");
    });

    it("should detect MCP-wrapped StopExecutionSignal (content object format)", () => {
        // Alternative MCP format with content property
        const mcpWrapped = {
            content: [{ type: "text", text: JSON.stringify(directSignal) }]
        };
        expect(isStopExecutionSignal(mcpWrapped)).toBe(true);
    });

    it("should extract pending delegations from MCP-wrapped format (content object)", () => {
        const mcpWrapped = {
            content: [{ type: "text", text: JSON.stringify(directSignal) }]
        };
        const delegations = extractPendingDelegations(mcpWrapped);
        expect(delegations).not.toBeNull();
        expect(delegations?.length).toBe(1);
        expect(delegations?.[0].delegationConversationId).toBe("event123");
    });

    it("should return false for non-stop signals", () => {
        expect(isStopExecutionSignal("just a string")).toBe(false);
        expect(isStopExecutionSignal({ foo: "bar" })).toBe(false);
        expect(isStopExecutionSignal([{ type: "text", text: '{"foo": "bar"}' }])).toBe(false);
        expect(isStopExecutionSignal(null)).toBe(false);
        expect(isStopExecutionSignal(undefined)).toBe(false);
    });

    it("should return null for non-stop signals when extracting", () => {
        expect(extractPendingDelegations("just a string")).toBeNull();
        expect(extractPendingDelegations({ foo: "bar" })).toBeNull();
        expect(extractPendingDelegations([{ type: "text", text: '{"foo": "bar"}' }])).toBeNull();
        expect(extractPendingDelegations(null)).toBeNull();
        expect(extractPendingDelegations(undefined)).toBeNull();
    });

    it("should handle malformed JSON gracefully", () => {
        const malformed = [{ type: "text", text: "not valid json{{{" }];
        expect(isStopExecutionSignal(malformed)).toBe(false);
        expect(extractPendingDelegations(malformed)).toBeNull();
    });

    it("should handle empty arrays", () => {
        expect(isStopExecutionSignal([])).toBe(false);
        expect(extractPendingDelegations([])).toBeNull();
    });

    it("should handle arrays without text items", () => {
        const noText = [{ type: "image", url: "http://example.com/img.png" }];
        expect(isStopExecutionSignal(noText)).toBe(false);
        expect(extractPendingDelegations(noText)).toBeNull();
    });
});
