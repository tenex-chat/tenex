/**
 * Tests for tool result preservation in RAL messages
 *
 * This test suite specifically tests that tool results are correctly preserved
 * when saved to RAL state and retrieved later.
 *
 * Bug context: Tool results (especially delegate tool) were observed to have
 * empty output values after being restored:
 *
 * role:"tool",
 * content:[{
 *   type:"tool-result",
 *   toolCallId:"call_48046689",
 *   toolName:"delegate",
 *   output:{ type:"text", value:"" }  // <-- EMPTY!
 * }]
 *
 * This test attempts to reproduce this bug.
 */

import { describe, expect, it, beforeEach, mock } from "bun:test";
import { RALRegistry } from "../RALRegistry";
import type { PendingDelegation } from "../types";
import type { ModelMessage } from "ai";

// Mock getProjectContext
mock.module("@/services/ProjectContext", () => ({
    getProjectContext: () => ({
        getAgentByPubkey: () => undefined,
    }),
}));

const AGENT_PUBKEY = "test-agent-pubkey-123";
const CONVERSATION_ID = "test-conversation-123";

describe("Tool Result Preservation", () => {
    let registry: RALRegistry;

    beforeEach(() => {
        // Reset singleton for testing
        // @ts-expect-error - accessing private static for testing
        RALRegistry.instance = undefined;
        registry = RALRegistry.getInstance();
    });

    describe("Delegate tool result preservation", () => {
        it("should preserve delegate tool output when saving state", () => {
            const ralNumber = registry.create(AGENT_PUBKEY, CONVERSATION_ID);

            // Simulate what happens when delegate tool is called:
            // The delegate tool returns a DelegateOutput object
            const delegateOutput = {
                __stopExecution: true,
                pendingDelegations: [
                    {
                        eventId: "delegation-event-123",
                        recipientPubkey: "recipient-pubkey",
                        recipientSlug: "recipient-agent",
                        prompt: "Please help with this task",
                    },
                ],
                delegationEventIds: {
                    "recipient-pubkey": "delegation-event-123",
                },
                message: "Delegated to:\n@recipient-agent -> delegation-event-123",
            };

            // Build messages as AgentExecutor.onStopCheck does (lines 827-838)
            const messagesWithToolCalls: ModelMessage[] = [
                { role: "user", content: "Please delegate this task" },
                { role: "assistant", content: "I'll delegate this task." },
                // Assistant's tool calls
                {
                    role: "assistant",
                    content: [
                        {
                            type: "tool-call" as const,
                            toolCallId: "call_48046689",
                            toolName: "delegate",
                            input: {
                                delegations: [
                                    {
                                        recipient: "@recipient-agent",
                                        prompt: "Please help with this task",
                                    },
                                ],
                            },
                        },
                    ],
                },
                // Tool results - THIS IS WHERE THE BUG MANIFESTS
                {
                    role: "tool",
                    content: [
                        {
                            type: "tool-result" as const,
                            toolCallId: "call_48046689",
                            toolName: "delegate",
                            // This should preserve the full output, not just { type: "text", value: "" }
                            output: delegateOutput,
                        },
                    ],
                },
            ];

            const pendingDelegations: PendingDelegation[] = [
                {
                    eventId: "delegation-event-123",
                    recipientPubkey: "recipient-pubkey",
                    recipientSlug: "recipient-agent",
                    prompt: "Please help with this task",
                },
            ];

            // Save state as AgentExecutor does
            registry.saveState(AGENT_PUBKEY, CONVERSATION_ID, ralNumber, messagesWithToolCalls, pendingDelegations);

            // Now retrieve the messages
            const retrievedMessages = registry.getMessages(AGENT_PUBKEY, CONVERSATION_ID, ralNumber);

            // Verify the messages are preserved correctly
            expect(retrievedMessages).toHaveLength(4);

            // Find the tool result message
            const toolMessage = retrievedMessages.find(m => m.role === "tool");
            expect(toolMessage).toBeDefined();
            expect(toolMessage!.content).toBeArrayOfSize(1);

            const toolResult = (toolMessage!.content as any[])[0];
            expect(toolResult.type).toBe("tool-result");
            expect(toolResult.toolCallId).toBe("call_48046689");
            expect(toolResult.toolName).toBe("delegate");

            // THIS IS THE KEY ASSERTION - the output should NOT be empty
            expect(toolResult.output).toBeDefined();
            expect(toolResult.output).not.toEqual({ type: "text", value: "" });
            expect(toolResult.output.__stopExecution).toBe(true);
            expect(toolResult.output.delegationEventIds).toEqual({
                "recipient-pubkey": "delegation-event-123",
            });
            expect(toolResult.output.message).toContain("Delegated to:");
        });

        it("should handle tool result with complex nested output", () => {
            const ralNumber = registry.create(AGENT_PUBKEY, CONVERSATION_ID);

            const complexOutput = {
                success: true,
                data: {
                    nested: {
                        deeply: {
                            value: "preserved",
                        },
                    },
                    array: [1, 2, 3],
                },
                metadata: {
                    timestamp: Date.now(),
                    version: "1.0.0",
                },
            };

            const messages: ModelMessage[] = [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "tool-call" as const,
                            toolCallId: "call_complex",
                            toolName: "some_tool",
                            input: { query: "test" },
                        },
                    ],
                },
                {
                    role: "tool",
                    content: [
                        {
                            type: "tool-result" as const,
                            toolCallId: "call_complex",
                            toolName: "some_tool",
                            output: complexOutput,
                        },
                    ],
                },
            ];

            registry.saveMessages(AGENT_PUBKEY, CONVERSATION_ID, ralNumber, messages);

            const retrieved = registry.getMessages(AGENT_PUBKEY, CONVERSATION_ID, ralNumber);
            const toolResult = (retrieved[1].content as any[])[0];

            // The complex output should be fully preserved
            expect(toolResult.output).toEqual(complexOutput);
            expect(toolResult.output.data.nested.deeply.value).toBe("preserved");
            expect(toolResult.output.data.array).toEqual([1, 2, 3]);
        });

        it("should preserve tool result across multiple save/get cycles", () => {
            const ralNumber = registry.create(AGENT_PUBKEY, CONVERSATION_ID);

            const originalOutput = {
                delegationEventIds: { key1: "value1", key2: "value2" },
                message: "Original message",
                __stopExecution: true,
                pendingDelegations: [],
            };

            const messages: ModelMessage[] = [
                {
                    role: "tool",
                    content: [
                        {
                            type: "tool-result" as const,
                            toolCallId: "call_1",
                            toolName: "delegate",
                            output: originalOutput,
                        },
                    ],
                },
            ];

            // First save
            registry.saveMessages(AGENT_PUBKEY, CONVERSATION_ID, ralNumber, messages);

            // First retrieval
            const firstRetrieval = registry.getMessages(AGENT_PUBKEY, CONVERSATION_ID, ralNumber);
            expect((firstRetrieval[0].content as any[])[0].output).toEqual(originalOutput);

            // Add more messages and save again (simulating continued execution)
            const updatedMessages = [
                ...firstRetrieval,
                { role: "user" as const, content: "Continue working" },
            ];
            registry.saveMessages(AGENT_PUBKEY, CONVERSATION_ID, ralNumber, updatedMessages);

            // Second retrieval
            const secondRetrieval = registry.getMessages(AGENT_PUBKEY, CONVERSATION_ID, ralNumber);
            expect(secondRetrieval).toHaveLength(2);

            // The original tool result should STILL be preserved
            const toolResult = (secondRetrieval[0].content as any[])[0];
            expect(toolResult.output).toEqual(originalOutput);
            expect(toolResult.output.message).toBe("Original message");
        });
    });

    describe("Tool result with undefined/null handling", () => {
        it("should not convert defined output to empty string", () => {
            const ralNumber = registry.create(AGENT_PUBKEY, CONVERSATION_ID);

            const output = { status: "success", id: "123" };

            const messages: ModelMessage[] = [
                {
                    role: "tool",
                    content: [
                        {
                            type: "tool-result" as const,
                            toolCallId: "call_1",
                            toolName: "test_tool",
                            output: output,
                        },
                    ],
                },
            ];

            registry.saveMessages(AGENT_PUBKEY, CONVERSATION_ID, ralNumber, messages);
            const retrieved = registry.getMessages(AGENT_PUBKEY, CONVERSATION_ID, ralNumber);

            const toolResult = (retrieved[0].content as any[])[0];

            // Should NOT be { type: "text", value: "" }
            expect(toolResult.output).toEqual(output);
            expect(toolResult.output.status).toBe("success");
        });

        it("should preserve tool result output when it contains special characters", () => {
            const ralNumber = registry.create(AGENT_PUBKEY, CONVERSATION_ID);

            const output = {
                message: "Special chars: \n\t\"quotes\" and 'apostrophes' and unicode: 🎉",
                code: "function() { return `template ${string}`; }",
            };

            const messages: ModelMessage[] = [
                {
                    role: "tool",
                    content: [
                        {
                            type: "tool-result" as const,
                            toolCallId: "call_special",
                            toolName: "test_tool",
                            output: output,
                        },
                    ],
                },
            ];

            registry.saveMessages(AGENT_PUBKEY, CONVERSATION_ID, ralNumber, messages);
            const retrieved = registry.getMessages(AGENT_PUBKEY, CONVERSATION_ID, ralNumber);

            const toolResult = (retrieved[0].content as any[])[0];
            expect(toolResult.output).toEqual(output);
        });
    });

    describe("saveState with pendingDelegations preserves tool output", () => {
        it("should preserve full tool result when saving state with pending delegations", () => {
            const ralNumber = registry.create(AGENT_PUBKEY, CONVERSATION_ID);

            // This simulates exactly what happens in AgentExecutor.onStopCheck
            const delegateToolResult = {
                __stopExecution: true,
                pendingDelegations: [
                    {
                        eventId: "event-123",
                        recipientPubkey: "pubkey",
                        prompt: "task",
                    },
                ],
                delegationEventIds: { pubkey: "event-123" },
                message: "Delegated successfully",
            };

            const messages: ModelMessage[] = [
                { role: "user", content: "Do something" },
                {
                    role: "assistant",
                    content: [
                        {
                            type: "tool-call" as const,
                            toolCallId: "call_xyz",
                            toolName: "delegate",
                            input: { delegations: [] },
                        },
                    ],
                },
                {
                    role: "tool",
                    content: [
                        {
                            type: "tool-result" as const,
                            toolCallId: "call_xyz",
                            toolName: "delegate",
                            output: delegateToolResult,
                        },
                    ],
                },
            ];

            const pendingDelegations: PendingDelegation[] = [
                {
                    eventId: "event-123",
                    recipientPubkey: "pubkey",
                    prompt: "task",
                },
            ];

            // This is what AgentExecutor does
            registry.saveState(AGENT_PUBKEY, CONVERSATION_ID, ralNumber, messages, pendingDelegations);

            // Now check what's in the RAL
            const state = registry.getState(AGENT_PUBKEY, CONVERSATION_ID);
            expect(state).toBeDefined();
            expect(state!.messages).toHaveLength(3);

            // The tool result should have the FULL output, not empty
            const toolMsg = state!.messages.find(m => m.role === "tool");
            expect(toolMsg).toBeDefined();

            const toolResultContent = (toolMsg!.content as any[])[0];
            expect(toolResultContent.output).toBeDefined();
            expect(toolResultContent.output.__stopExecution).toBe(true);
            expect(toolResultContent.output.message).toBe("Delegated successfully");
            expect(toolResultContent.output.delegationEventIds).toEqual({ pubkey: "event-123" });
        });
    });
});
