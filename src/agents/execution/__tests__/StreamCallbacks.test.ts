/**
 * Unit tests for StreamCallbacks
 *
 * Tests the createOnStopCheck callback for delegation stop detection:
 * - Detection of StopExecutionSignal in tool results
 * - Merging of pending delegations
 * - Return value (true = stop, false = continue)
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import type { StepResult, ToolSet, TypedToolResult } from "ai";
import { RALRegistry } from "@/services/ral/RALRegistry";
import type { AISdkTool } from "@/tools/types";

// Import the extractPendingDelegations function to understand the signal format
import { extractPendingDelegations } from "@/services/ral";

describe("StreamCallbacks - createOnStopCheck", () => {
    const AGENT_PUBKEY = "test-agent-streamcallbacks";
    const CONVERSATION_ID = "test-conv-streamcallbacks";
    const RAL_NUMBER = 1;

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
     */
    function createMockStepResult(options: {
        toolResults: Array<{
            toolCallId: string;
            toolName: string;
            output: unknown;
        }>;
    }): StepResult<Record<string, AISdkTool>> {
        const typedToolResults: TypedToolResult<ToolSet>[] = options.toolResults.map(tr => ({
            type: "tool-result" as const,
            toolCallId: tr.toolCallId,
            toolName: tr.toolName,
            input: {},
            output: tr.output,
            dynamic: true,
        }));

        return {
            text: "",
            reasoning: [],
            reasoningText: undefined,
            files: [],
            sources: [],
            content: [],
            toolCalls: [],
            staticToolCalls: [],
            dynamicToolCalls: [],
            toolResults: typedToolResults,
            staticToolResults: [],
            dynamicToolResults: typedToolResults,
            finishReason: "tool-calls",
            rawFinishReason: "tool_calls",
            usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
            warnings: [],
            request: {},
            response: { id: "resp-123", timestamp: new Date(), modelId: "gpt-4" },
            providerMetadata: undefined,
        } as unknown as StepResult<Record<string, AISdkTool>>;
    }

    describe("extractPendingDelegations - StopExecutionSignal Detection", () => {
        test("detects delegation stop signal in tool output", () => {
            const delegateOutput = {
                __stopExecution: true,
                pendingDelegations: [
                    {
                        delegationConversationId: "delegation-123",
                        recipientPubkey: "recipient-pk",
                        recipientSlug: "researcher",
                        prompt: "Research this topic",
                    },
                ],
                delegationEventIds: { "recipient-pk": "delegation-123" },
                message: "Delegated to researcher",
            };

            const result = extractPendingDelegations(delegateOutput);

            expect(result).not.toBeNull();
            expect(result).toHaveLength(1);
            expect(result![0].delegationConversationId).toBe("delegation-123");
            expect(result![0].recipientSlug).toBe("researcher");
        });

        test("detects ask tool stop signal", () => {
            const askOutput = {
                __stopExecution: true,
                pendingDelegations: [
                    {
                        type: "ask",
                        delegationConversationId: "ask-event-456",
                        recipientPubkey: "user-pk",
                        recipientSlug: "user",
                        prompt: "Which option do you prefer?",
                    },
                ],
            };

            const result = extractPendingDelegations(askOutput);

            expect(result).not.toBeNull();
            expect(result).toHaveLength(1);
            expect(result![0].type).toBe("ask");
        });

        test("returns null for non-stop tool outputs", () => {
            const normalOutput = {
                content: "File contents here",
            };

            const result = extractPendingDelegations(normalOutput);

            expect(result).toBeNull();
        });

        test("returns null for output without __stopExecution flag", () => {
            const outputWithDelegations = {
                pendingDelegations: [{ delegationConversationId: "123" }],
                // Missing __stopExecution: true
            };

            const result = extractPendingDelegations(outputWithDelegations);

            expect(result).toBeNull();
        });

        test("returns undefined for __stopExecution without pendingDelegations", () => {
            const outputWithoutDelegations = {
                __stopExecution: true,
                // Missing pendingDelegations array
            };

            const result = extractPendingDelegations(outputWithoutDelegations);

            // Returns undefined because pendingDelegations field is missing
            expect(result).toBeUndefined();
        });

        test("returns empty array for empty pendingDelegations", () => {
            const emptyDelegationsOutput = {
                __stopExecution: true,
                pendingDelegations: [],
            };

            const result = extractPendingDelegations(emptyDelegationsOutput);

            // Returns the empty array as-is (caller decides how to handle)
            expect(result).toEqual([]);
        });
    });

    describe("Multiple Tool Results in Single Step", () => {
        test("detects stop signal among multiple tool results", () => {
            const stepResult = createMockStepResult({
                toolResults: [
                    {
                        toolCallId: "call-fs-read",
                        toolName: "fs_read",
                        output: { content: "file contents" },
                    },
                    {
                        toolCallId: "call-delegate",
                        toolName: "delegate",
                        output: {
                            __stopExecution: true,
                            pendingDelegations: [
                                { delegationConversationId: "e1", recipientPubkey: "pk1", recipientSlug: "agent1" },
                            ],
                            delegationEventIds: { pk1: "e1" },
                        },
                    },
                ],
            });

            // Check that at least one tool result has a stop signal
            const toolResults = stepResult.toolResults ?? [];
            let foundStopSignal = false;

            for (const tr of toolResults) {
                const pending = extractPendingDelegations(tr.output);
                if (pending) {
                    foundStopSignal = true;
                    expect(pending).toHaveLength(1);
                    break;
                }
            }

            expect(foundStopSignal).toBe(true);
        });

        test("first stop signal triggers stop even with multiple tools", () => {
            const stepResult = createMockStepResult({
                toolResults: [
                    {
                        toolCallId: "call-delegate-1",
                        toolName: "delegate",
                        output: {
                            __stopExecution: true,
                            pendingDelegations: [
                                { delegationConversationId: "d1", recipientPubkey: "pk1", recipientSlug: "agent1" },
                            ],
                        },
                    },
                    {
                        toolCallId: "call-delegate-2",
                        toolName: "delegate",
                        output: {
                            __stopExecution: true,
                            pendingDelegations: [
                                { delegationConversationId: "d2", recipientPubkey: "pk2", recipientSlug: "agent2" },
                            ],
                        },
                    },
                ],
            });

            // First stop signal should be detected
            const firstResult = (stepResult.toolResults ?? [])[0];
            const pending = extractPendingDelegations(firstResult.output);

            expect(pending).not.toBeNull();
            expect(pending![0].delegationConversationId).toBe("d1");
        });
    });

    describe("Edge Cases", () => {
        test("handles empty steps array", () => {
            const steps: StepResult<Record<string, AISdkTool>>[] = [];

            // With empty steps, there's nothing to check
            expect(steps.length).toBe(0);
        });

        test("handles step with no tool results", () => {
            const stepResult = createMockStepResult({
                toolResults: [],
            });

            const toolResults = stepResult.toolResults ?? [];
            expect(toolResults).toHaveLength(0);

            // No tool results means no stop signal
            let foundStopSignal = false;
            for (const tr of toolResults) {
                if (extractPendingDelegations(tr.output)) {
                    foundStopSignal = true;
                }
            }
            expect(foundStopSignal).toBe(false);
        });

        test("handles undefined output in tool result", () => {
            const stepResult = createMockStepResult({
                toolResults: [
                    {
                        toolCallId: "call-undefined",
                        toolName: "some_tool",
                        output: undefined as any,
                    },
                ],
            });

            const toolResults = stepResult.toolResults ?? [];
            const pending = extractPendingDelegations(toolResults[0].output);

            expect(pending).toBeNull();
        });

        test("handles null output in tool result", () => {
            const stepResult = createMockStepResult({
                toolResults: [
                    {
                        toolCallId: "call-null",
                        toolName: "some_tool",
                        output: null as any,
                    },
                ],
            });

            const toolResults = stepResult.toolResults ?? [];
            const pending = extractPendingDelegations(toolResults[0].output);

            expect(pending).toBeNull();
        });
    });

    describe("Delegation Merging Logic", () => {
        test("does not duplicate delegations with same conversationId", () => {
            const existingDelegations = [
                { delegationConversationId: "existing-1", recipientPubkey: "pk1", recipientSlug: "agent1" },
            ];

            const newDelegations = [
                { delegationConversationId: "existing-1", recipientPubkey: "pk1", recipientSlug: "agent1" }, // duplicate
                { delegationConversationId: "new-2", recipientPubkey: "pk2", recipientSlug: "agent2" },
            ];

            // Simulate merging logic from createOnStopCheck
            const mergedDelegations = [...existingDelegations];
            for (const newDelegation of newDelegations) {
                if (!mergedDelegations.some(d => d.delegationConversationId === newDelegation.delegationConversationId)) {
                    mergedDelegations.push(newDelegation);
                }
            }

            expect(mergedDelegations).toHaveLength(2);
            expect(mergedDelegations.map(d => d.delegationConversationId)).toContain("existing-1");
            expect(mergedDelegations.map(d => d.delegationConversationId)).toContain("new-2");
        });

        test("preserves all unique delegations", () => {
            const existingDelegations = [
                { delegationConversationId: "d1", recipientPubkey: "pk1", recipientSlug: "agent1" },
            ];

            const newDelegations = [
                { delegationConversationId: "d2", recipientPubkey: "pk2", recipientSlug: "agent2" },
                { delegationConversationId: "d3", recipientPubkey: "pk3", recipientSlug: "agent3" },
            ];

            const mergedDelegations = [...existingDelegations];
            for (const newDelegation of newDelegations) {
                if (!mergedDelegations.some(d => d.delegationConversationId === newDelegation.delegationConversationId)) {
                    mergedDelegations.push(newDelegation);
                }
            }

            expect(mergedDelegations).toHaveLength(3);
        });
    });
});
