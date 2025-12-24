/**
 * Test for tool result preservation in RAL state
 *
 * This test verifies that when an agent executes a tool that returns a StopExecutionSignal,
 * the tool result is properly preserved in the RAL state messages for when the agent resumes.
 *
 * Bug: Tool results were being dropped/saved as empty strings when stored in RAL state.
 * The symptom was that after resuming from a delegation, the tool result message showed:
 * { type: "tool-result", toolName: "delegate", output: { type: "text", value: "" } }
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { RALRegistry } from "@/services/ral/RALRegistry";
import type { PendingDelegation, StopExecutionSignal } from "@/services/ral/types";
import type { ModelMessage } from "ai";

describe("Tool Result Preservation in RAL State", () => {
    const AGENT_PUBKEY = "test-agent-pubkey-123";
    const CONVERSATION_ID = "test-conversation-456";

    let ralRegistry: RALRegistry;
    let ralNumber: number;

    beforeEach(() => {
        ralRegistry = RALRegistry.getInstance();
        ralRegistry.clearAll();
        ralNumber = ralRegistry.create(AGENT_PUBKEY, CONVERSATION_ID, "trigger-event-id");
    });

    afterEach(() => {
        ralRegistry.clearAll();
    });

    describe("saveState with delegate tool results", () => {
        it("should preserve the delegate tool output in messages", () => {
            // Simulate the delegate tool return value
            const delegateOutput: StopExecutionSignal & { delegationEventIds: Record<string, string>; message: string } = {
                __stopExecution: true,
                pendingDelegations: [
                    {
                        eventId: "delegation-event-123",
                        recipientPubkey: "recipient-pubkey-456",
                        recipientSlug: "researcher",
                        prompt: "Research the topic",
                    },
                ],
                delegationEventIds: {
                    "recipient-pubkey-456": "delegation-event-123",
                },
                message: "Delegated to:\n@researcher -> delegation-event-123",
            };

            // Simulate the toolCalls and toolResults from AI SDK step
            const toolCallId = "call_48046689";
            const toolName = "delegate";

            // Build messages array as done in AgentExecutor.executeStreaming onStopCheck
            const baseMessages: ModelMessage[] = [
                { role: "system", content: "You are a helpful assistant." },
                { role: "user", content: "Please delegate to the researcher agent." },
            ];

            // Add assistant message with tool call
            const messagesWithToolCalls: ModelMessage[] = [
                ...baseMessages,
                {
                    role: "assistant",
                    content: [
                        {
                            type: "tool-call" as const,
                            toolCallId,
                            toolName,
                            input: {
                                delegations: [
                                    { recipient: "researcher", prompt: "Research the topic" }
                                ]
                            },
                        },
                    ],
                },
            ];

            // Simulate what AgentExecutor does - this is the critical part
            // Line 835-836 in AgentExecutor.ts:
            // output: tr.result !== undefined ? tr.result : { type: "text", value: "" }
            const toolResult = delegateOutput; // This is tr.result
            const formattedOutput = toolResult !== undefined ? toolResult : { type: "text", value: "" };

            // Add tool result message
            const finalMessages: ModelMessage[] = [
                ...messagesWithToolCalls,
                {
                    role: "tool",
                    content: [
                        {
                            type: "tool-result" as const,
                            toolCallId,
                            toolName,
                            output: formattedOutput,
                        },
                    ],
                },
            ];

            // Save state
            ralRegistry.saveState(
                AGENT_PUBKEY,
                CONVERSATION_ID,
                ralNumber,
                finalMessages,
                delegateOutput.pendingDelegations
            );

            // Retrieve and verify
            const savedMessages = ralRegistry.getMessages(AGENT_PUBKEY, CONVERSATION_ID, ralNumber);

            expect(savedMessages).toHaveLength(4);

            // Find the tool result message
            const toolResultMessage = savedMessages.find(m => m.role === "tool");
            expect(toolResultMessage).toBeDefined();

            const content = toolResultMessage!.content;
            expect(Array.isArray(content)).toBe(true);

            const toolResultContent = (content as any[])[0];
            expect(toolResultContent.type).toBe("tool-result");
            expect(toolResultContent.toolName).toBe("delegate");

            // THIS IS THE CRITICAL CHECK - the output should NOT be empty
            expect(toolResultContent.output).not.toEqual({ type: "text", value: "" });

            // The output should be the original delegate output
            expect(toolResultContent.output.__stopExecution).toBe(true);
            expect(toolResultContent.output.delegationEventIds).toBeDefined();
            expect(toolResultContent.output.message).toContain("Delegated to:");
        });

        it("should handle undefined tool result gracefully", () => {
            const toolCallId = "call_undefined";
            const toolName = "some_tool";

            const baseMessages: ModelMessage[] = [
                { role: "user", content: "Do something" },
            ];

            // Simulate undefined result (edge case)
            const toolResult = undefined;
            const formattedOutput = toolResult !== undefined ? toolResult : { type: "text" as const, value: "" };

            const messagesWithResult: ModelMessage[] = [
                ...baseMessages,
                {
                    role: "assistant",
                    content: [
                        {
                            type: "tool-call" as const,
                            toolCallId,
                            toolName,
                            input: {},
                        },
                    ],
                },
                {
                    role: "tool",
                    content: [
                        {
                            type: "tool-result" as const,
                            toolCallId,
                            toolName,
                            output: formattedOutput,
                        },
                    ],
                },
            ];

            ralRegistry.saveState(AGENT_PUBKEY, CONVERSATION_ID, ralNumber, messagesWithResult, []);

            const savedMessages = ralRegistry.getMessages(AGENT_PUBKEY, CONVERSATION_ID, ralNumber);
            const toolResultMessage = savedMessages.find(m => m.role === "tool");

            expect(toolResultMessage).toBeDefined();
            const toolResultContent = (toolResultMessage!.content as any[])[0];

            // For undefined results, the fallback is acceptable
            expect(toolResultContent.output).toEqual({ type: "text", value: "" });
        });
    });

    describe("message persistence across RAL operations", () => {
        it("should preserve tool results through getMessages calls", () => {
            const toolCallId = "call_persist";
            const toolResult = { status: "success", data: { count: 42 } };

            const messages: ModelMessage[] = [
                { role: "user", content: "Get count" },
                {
                    role: "assistant",
                    content: [
                        {
                            type: "tool-call" as const,
                            toolCallId,
                            toolName: "get_count",
                            input: {},
                        },
                    ],
                },
                {
                    role: "tool",
                    content: [
                        {
                            type: "tool-result" as const,
                            toolCallId,
                            toolName: "get_count",
                            output: toolResult,
                        },
                    ],
                },
            ];

            ralRegistry.saveMessages(AGENT_PUBKEY, CONVERSATION_ID, ralNumber, messages);

            // First retrieval
            const firstGet = ralRegistry.getMessages(AGENT_PUBKEY, CONVERSATION_ID, ralNumber);
            const firstToolResult = (firstGet.find(m => m.role === "tool")!.content as any[])[0];
            expect(firstToolResult.output).toEqual(toolResult);

            // Second retrieval (should be identical)
            const secondGet = ralRegistry.getMessages(AGENT_PUBKEY, CONVERSATION_ID, ralNumber);
            const secondToolResult = (secondGet.find(m => m.role === "tool")!.content as any[])[0];
            expect(secondToolResult.output).toEqual(toolResult);
        });

        it("should preserve complex nested tool outputs", () => {
            const complexOutput = {
                __stopExecution: true,
                pendingDelegations: [
                    { eventId: "e1", recipientPubkey: "pk1", recipientSlug: "agent1", prompt: "task1" },
                    { eventId: "e2", recipientPubkey: "pk2", recipientSlug: "agent2", prompt: "task2" },
                ],
                delegationEventIds: { pk1: "e1", pk2: "e2" },
                message: "Delegated to 2 agents",
                metadata: {
                    nested: {
                        deeply: {
                            value: "preserved",
                        },
                    },
                    array: [1, 2, 3, { key: "val" }],
                },
            };

            const messages: ModelMessage[] = [
                { role: "user", content: "Delegate" },
                {
                    role: "assistant",
                    content: [{ type: "tool-call" as const, toolCallId: "c1", toolName: "delegate", input: {} }],
                },
                {
                    role: "tool",
                    content: [{ type: "tool-result" as const, toolCallId: "c1", toolName: "delegate", output: complexOutput }],
                },
            ];

            ralRegistry.saveState(AGENT_PUBKEY, CONVERSATION_ID, ralNumber, messages, []);

            const retrieved = ralRegistry.getMessages(AGENT_PUBKEY, CONVERSATION_ID, ralNumber);
            const toolOutput = (retrieved.find(m => m.role === "tool")!.content as any[])[0].output;

            expect(toolOutput).toEqual(complexOutput);
            expect(toolOutput.metadata.nested.deeply.value).toBe("preserved");
            expect(toolOutput.metadata.array[3].key).toBe("val");
        });
    });
});
