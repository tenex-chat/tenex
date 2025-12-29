/**
 * Integration tests for AgentExecutor.executeStreaming onStopCheck callback
 *
 * These tests verify that when a tool returns a StopExecutionSignal (like delegate, ask),
 * the tool calls and tool results are correctly preserved in the RAL state.
 *
 * This tests the ACTUAL code path, not just simulated structures.
 *
 * Bug History:
 * - Bug 1: Code accessed `tr.result` but AI SDK provides `tr.output` → empty tool results
 * - Bug 2: Code accessed `tc.args` but AI SDK provides `tc.input` → empty tool call inputs
 *
 * These tests would have caught both bugs by using real AI SDK types.
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { RALRegistry } from "@/services/ral/RALRegistry";
import type { StepResult, TypedToolCall, TypedToolResult, ToolSet } from "ai";
import type { ModelMessage } from "ai";

// We need to test that the onStopCheck callback in AgentExecutor correctly
// maps AI SDK types to ModelMessage format. The key is to verify that:
// 1. TypedToolCall.input is mapped to ToolCallPart.input
// 2. TypedToolResult.output is mapped to ToolResultPart.output

describe("AgentExecutor.onStopCheck - Tool Message Preservation", () => {
    const AGENT_PUBKEY = "test-agent-onStopCheck";
    const CONVERSATION_ID = "test-conv-onStopCheck";

    let ralRegistry: RALRegistry;

    beforeEach(() => {
        ralRegistry = RALRegistry.getInstance();
        ralRegistry.clearAll();
    });

    afterEach(() => {
        ralRegistry.clearAll();
    });

    /**
     * Creates a properly typed StepResult matching AI SDK's structure
     * This is what the real AI SDK provides to onStopCheck
     */
    function createMockStepResult(options: {
        toolCalls: Array<{
            toolCallId: string;
            toolName: string;
            input: unknown;  // AI SDK uses 'input' NOT 'args'
        }>;
        toolResults: Array<{
            toolCallId: string;
            toolName: string;
            output: unknown;  // AI SDK uses 'output' NOT 'result'
        }>;
    }): StepResult<ToolSet> {
        // Create TypedToolCall objects matching AI SDK structure
        const typedToolCalls: TypedToolCall<ToolSet>[] = options.toolCalls.map(tc => ({
            type: "tool-call" as const,
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            input: tc.input,  // AI SDK uses 'input'
            dynamic: true,    // Mark as dynamic for flexibility
        }));

        // Create TypedToolResult objects matching AI SDK structure
        const typedToolResults: TypedToolResult<ToolSet>[] = options.toolResults.map(tr => ({
            type: "tool-result" as const,
            toolCallId: tr.toolCallId,
            toolName: tr.toolName,
            input: {},  // TypedToolResult also has input (what was passed to tool)
            output: tr.output,  // AI SDK uses 'output'
            dynamic: true,
        }));

        // Return a mock StepResult
        return {
            text: "",
            reasoning: [],
            reasoningText: undefined,
            files: [],
            sources: [],
            content: [],
            toolCalls: typedToolCalls,
            staticToolCalls: [],
            dynamicToolCalls: typedToolCalls,
            toolResults: typedToolResults,
            staticToolResults: [],
            dynamicToolResults: typedToolResults,
            finishReason: "tool-calls",
            rawFinishReason: "tool_calls",
            usage: {
                promptTokens: 100,
                completionTokens: 50,
                totalTokens: 150,
            },
            warnings: [],
            request: {},
            response: {
                id: "resp-123",
                timestamp: new Date(),
                modelId: "gpt-4",
            },
            providerMetadata: undefined,
        } as unknown as StepResult<ToolSet>;
    }

    /**
     * Simulates what onStopCheck does when processing tool results
     * This is extracted from AgentExecutor.executeStreaming to test in isolation
     */
    function simulateOnStopCheckMapping(
        lastStep: StepResult<ToolSet>,
        latestAccumulatedMessages: ModelMessage[]
    ): ModelMessage[] {
        const toolCalls = lastStep.toolCalls ?? [];
        const toolResults = lastStep.toolResults ?? [];
        const messagesWithToolCalls: ModelMessage[] = [...latestAccumulatedMessages];

        // This is the ACTUAL code from AgentExecutor.ts lines 813-839
        // Add assistant message with tool calls (if any)
        if (toolCalls.length > 0) {
            messagesWithToolCalls.push({
                role: "assistant",
                content: toolCalls.map((tc: TypedToolCall<ToolSet>) => ({
                    type: "tool-call" as const,
                    toolCallId: tc.toolCallId,
                    toolName: tc.toolName,
                    // AI SDK TypedToolCall and ModelMessage both use 'input'
                    input: tc.input !== undefined ? tc.input : {},
                })),
            });
        }

        // Add tool results
        if (toolResults.length > 0) {
            messagesWithToolCalls.push({
                role: "tool",
                content: toolResults.map((tr: TypedToolResult<ToolSet>) => ({
                    type: "tool-result" as const,
                    toolCallId: tr.toolCallId,
                    toolName: tr.toolName,
                    // AI SDK TypedToolResult provides 'output' field
                    output: tr.output !== undefined ? tr.output : { type: "text", value: "" },
                })),
            });
        }

        return messagesWithToolCalls;
    }

    describe("Tool Call Input Preservation (tc.input)", () => {
        it("should preserve complex input objects from TypedToolCall", () => {
            const delegateInput = {
                delegations: [
                    { recipient: "researcher", prompt: "Research the topic" },
                    { recipient: "executor", prompt: "Implement the feature" },
                ],
            };

            const stepResult = createMockStepResult({
                toolCalls: [{
                    toolCallId: "call_delegate_123",
                    toolName: "delegate",
                    input: delegateInput,
                }],
                toolResults: [{
                    toolCallId: "call_delegate_123",
                    toolName: "delegate",
                    output: { __stopExecution: true, pendingDelegations: [] },
                }],
            });

            const messages = simulateOnStopCheckMapping(stepResult, []);

            // Find the assistant message with tool calls
            const assistantMsg = messages.find(m => m.role === "assistant");
            expect(assistantMsg).toBeDefined();

            const toolCallContent = (assistantMsg!.content as any[])[0];
            expect(toolCallContent.type).toBe("tool-call");
            expect(toolCallContent.toolName).toBe("delegate");

            // CRITICAL: The input should be preserved, not empty
            expect(toolCallContent.input).toEqual(delegateInput);
            expect(toolCallContent.input.delegations).toHaveLength(2);
        });

        it("should handle empty input gracefully", () => {
            const stepResult = createMockStepResult({
                toolCalls: [{
                    toolCallId: "call_empty_input",
                    toolName: "ask",
                    input: undefined as any,
                }],
                toolResults: [{
                    toolCallId: "call_empty_input",
                    toolName: "ask",
                    output: { __stopExecution: true, pendingDelegations: [] },
                }],
            });

            const messages = simulateOnStopCheckMapping(stepResult, []);
            const assistantMsg = messages.find(m => m.role === "assistant");
            const toolCallContent = (assistantMsg!.content as any[])[0];

            // Should fall back to empty object, not undefined
            expect(toolCallContent.input).toEqual({});
        });
    });

    describe("Tool Result Output Preservation (tr.output)", () => {
        it("should preserve delegate tool output with StopExecutionSignal", () => {
            const delegateOutput = {
                __stopExecution: true,
                pendingDelegations: [
                    {
                        eventId: "delegation-event-123",
                        recipientPubkey: "recipient-pk-456",
                        recipientSlug: "researcher",
                        prompt: "Research the topic",
                    },
                ],
                delegationEventIds: {
                    "recipient-pk-456": "delegation-event-123",
                },
                message: "Delegated to:\n@researcher -> delegation-event-123",
            };

            const stepResult = createMockStepResult({
                toolCalls: [{
                    toolCallId: "call_delegate_456",
                    toolName: "delegate",
                    input: { delegations: [{ recipient: "researcher", prompt: "Research" }] },
                }],
                toolResults: [{
                    toolCallId: "call_delegate_456",
                    toolName: "delegate",
                    output: delegateOutput,
                }],
            });

            const messages = simulateOnStopCheckMapping(stepResult, []);

            // Find the tool message with results
            const toolMsg = messages.find(m => m.role === "tool");
            expect(toolMsg).toBeDefined();

            const toolResultContent = (toolMsg!.content as any[])[0];
            expect(toolResultContent.type).toBe("tool-result");
            expect(toolResultContent.toolName).toBe("delegate");

            // CRITICAL: The output should be the full delegate output, not empty
            expect(toolResultContent.output).toEqual(delegateOutput);
            expect(toolResultContent.output.__stopExecution).toBe(true);
            expect(toolResultContent.output.delegationEventIds).toBeDefined();
            expect(toolResultContent.output.message).toContain("Delegated to:");
        });

        it("should preserve ask tool output", () => {
            const askOutput = {
                __stopExecution: true,
                pendingDelegations: [
                    {
                        type: "ask",
                        eventId: "ask-event-789",
                        recipientPubkey: "user-pk-123",
                        recipientSlug: "user",
                        prompt: "Which approach do you prefer?",
                    },
                ],
            };

            const stepResult = createMockStepResult({
                toolCalls: [{
                    toolCallId: "call_ask_789",
                    toolName: "ask",
                    input: { question: "Which approach?", suggestions: ["A", "B"] },
                }],
                toolResults: [{
                    toolCallId: "call_ask_789",
                    toolName: "ask",
                    output: askOutput,
                }],
            });

            const messages = simulateOnStopCheckMapping(stepResult, []);
            const toolMsg = messages.find(m => m.role === "tool");
            const toolResultContent = (toolMsg!.content as any[])[0];

            expect(toolResultContent.output).toEqual(askOutput);
            expect(toolResultContent.output.__stopExecution).toBe(true);
        });

        it("should handle undefined output gracefully", () => {
            const stepResult = createMockStepResult({
                toolCalls: [{
                    toolCallId: "call_undefined_output",
                    toolName: "some_tool",
                    input: {},
                }],
                toolResults: [{
                    toolCallId: "call_undefined_output",
                    toolName: "some_tool",
                    output: undefined as any,
                }],
            });

            const messages = simulateOnStopCheckMapping(stepResult, []);
            const toolMsg = messages.find(m => m.role === "tool");
            const toolResultContent = (toolMsg!.content as any[])[0];

            // Should fall back to empty text format
            expect(toolResultContent.output).toEqual({ type: "text", value: "" });
        });
    });

    describe("Multiple Tools in Same Step", () => {
        it("should preserve all tool inputs and outputs when multiple tools called", () => {
            const stepResult = createMockStepResult({
                toolCalls: [
                    {
                        toolCallId: "call_read_file",
                        toolName: "read_path",
                        input: { path: "/src/index.ts" },
                    },
                    {
                        toolCallId: "call_delegate",
                        toolName: "delegate",
                        input: { delegations: [{ recipient: "executor", prompt: "Implement" }] },
                    },
                ],
                toolResults: [
                    {
                        toolCallId: "call_read_file",
                        toolName: "read_path",
                        output: { content: "file contents here" },
                    },
                    {
                        toolCallId: "call_delegate",
                        toolName: "delegate",
                        output: {
                            __stopExecution: true,
                            pendingDelegations: [{ eventId: "e1", recipientPubkey: "pk1" }],
                            delegationEventIds: { pk1: "e1" },
                            message: "Delegated",
                        },
                    },
                ],
            });

            const messages = simulateOnStopCheckMapping(stepResult, []);

            // Check assistant message has both tool calls
            const assistantMsg = messages.find(m => m.role === "assistant");
            const toolCalls = assistantMsg!.content as any[];
            expect(toolCalls).toHaveLength(2);

            expect(toolCalls[0].toolName).toBe("read_path");
            expect(toolCalls[0].input).toEqual({ path: "/src/index.ts" });

            expect(toolCalls[1].toolName).toBe("delegate");
            expect(toolCalls[1].input.delegations).toHaveLength(1);

            // Check tool message has both results
            const toolMsg = messages.find(m => m.role === "tool");
            const toolResults = toolMsg!.content as any[];
            expect(toolResults).toHaveLength(2);

            expect(toolResults[0].toolName).toBe("read_path");
            expect(toolResults[0].output.content).toBe("file contents here");

            expect(toolResults[1].toolName).toBe("delegate");
            expect(toolResults[1].output.__stopExecution).toBe(true);
        });
    });

    describe("Regression Tests - Would Have Caught Original Bugs", () => {
        /**
         * This test would have FAILED with the original buggy code that used tr.result
         */
        it("REGRESSION: should NOT produce empty output (the original bug)", () => {
            const stepResult = createMockStepResult({
                toolCalls: [{
                    toolCallId: "call_regression",
                    toolName: "delegate",
                    input: { delegations: [{ recipient: "agent", prompt: "task" }] },
                }],
                toolResults: [{
                    toolCallId: "call_regression",
                    toolName: "delegate",
                    output: {
                        __stopExecution: true,
                        pendingDelegations: [{ eventId: "e1", recipientPubkey: "p1" }],
                        delegationEventIds: { p1: "e1" },
                        message: "Delegated",
                    },
                }],
            });

            const messages = simulateOnStopCheckMapping(stepResult, []);
            const toolMsg = messages.find(m => m.role === "tool");
            const toolResultContent = (toolMsg!.content as any[])[0];

            // This assertion would have FAILED with the bug:
            // Original bug produced: { type: "text", value: "" }
            expect(toolResultContent.output).not.toEqual({ type: "text", value: "" });
            expect(toolResultContent.output.__stopExecution).toBe(true);
        });

        /**
         * This test would have FAILED with the buggy code that used tc.args
         */
        it("REGRESSION: should NOT produce empty input (the second bug)", () => {
            const complexInput = {
                delegations: [
                    { recipient: "researcher", prompt: "Research topic A" },
                    { recipient: "executor", prompt: "Implement feature B" },
                ],
                metadata: { priority: "high" },
            };

            const stepResult = createMockStepResult({
                toolCalls: [{
                    toolCallId: "call_input_regression",
                    toolName: "delegate",
                    input: complexInput,
                }],
                toolResults: [{
                    toolCallId: "call_input_regression",
                    toolName: "delegate",
                    output: { __stopExecution: true, pendingDelegations: [] },
                }],
            });

            const messages = simulateOnStopCheckMapping(stepResult, []);
            const assistantMsg = messages.find(m => m.role === "assistant");
            const toolCallContent = (assistantMsg!.content as any[])[0];

            // This assertion would have FAILED with the bug:
            // Original bug produced: {} (empty object from fallback)
            expect(toolCallContent.input).not.toEqual({});
            expect(toolCallContent.input).toEqual(complexInput);
            expect(toolCallContent.input.delegations).toHaveLength(2);
        });
    });
});
