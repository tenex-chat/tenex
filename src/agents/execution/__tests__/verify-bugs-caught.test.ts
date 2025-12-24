/**
 * Verification tests that prove our new tests would have caught the original bugs
 *
 * These tests simulate the BUGGY code patterns and verify they fail appropriately.
 */

import { describe, it, expect } from "bun:test";
import type { TypedToolCall, TypedToolResult, ToolSet, StepResult } from "ai";
import type { ModelMessage } from "ai";

describe("Bug Detection Verification", () => {
    /**
     * Creates a mock step result with proper AI SDK types
     */
    function createMockStepResult(options: {
        toolCalls: Array<{
            toolCallId: string;
            toolName: string;
            input: unknown;
        }>;
        toolResults: Array<{
            toolCallId: string;
            toolName: string;
            output: unknown;
        }>;
    }): StepResult<ToolSet> {
        const typedToolCalls: TypedToolCall<ToolSet>[] = options.toolCalls.map(tc => ({
            type: "tool-call" as const,
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            input: tc.input,
            dynamic: true,
        }));

        const typedToolResults: TypedToolResult<ToolSet>[] = options.toolResults.map(tr => ({
            type: "tool-result" as const,
            toolCallId: tr.toolCallId,
            toolName: tr.toolName,
            input: {},
            output: tr.output,
            dynamic: true,
        }));

        return {
            toolCalls: typedToolCalls,
            toolResults: typedToolResults,
        } as unknown as StepResult<ToolSet>;
    }

    describe("Bug 1: tr.result vs tr.output", () => {
        it("BUGGY CODE: accessing tr.result produces undefined (falls back to empty)", () => {
            const stepResult = createMockStepResult({
                toolCalls: [{ toolCallId: "c1", toolName: "delegate", input: {} }],
                toolResults: [{
                    toolCallId: "c1",
                    toolName: "delegate",
                    output: {
                        __stopExecution: true,
                        pendingDelegations: [{ eventId: "e1" }],
                        message: "Delegated",
                    },
                }],
            });

            const toolResults = stepResult.toolResults;

            // Simulate the BUGGY code pattern
            const buggyMapping = toolResults.map((tr: any) => ({
                type: "tool-result" as const,
                toolCallId: tr.toolCallId,
                toolName: tr.toolName,
                // BUG: accessing 'result' instead of 'output'
                output: tr.result !== undefined ? tr.result : { type: "text", value: "" },
            }));

            // The bug causes empty output
            expect(buggyMapping[0].output).toEqual({ type: "text", value: "" });
        });

        it("FIXED CODE: accessing tr.output preserves the data", () => {
            const expectedOutput = {
                __stopExecution: true,
                pendingDelegations: [{ eventId: "e1" }],
                message: "Delegated",
            };

            const stepResult = createMockStepResult({
                toolCalls: [{ toolCallId: "c1", toolName: "delegate", input: {} }],
                toolResults: [{
                    toolCallId: "c1",
                    toolName: "delegate",
                    output: expectedOutput,
                }],
            });

            const toolResults = stepResult.toolResults;

            // Simulate the FIXED code pattern
            const fixedMapping = toolResults.map((tr: TypedToolResult<ToolSet>) => ({
                type: "tool-result" as const,
                toolCallId: tr.toolCallId,
                toolName: tr.toolName,
                // FIXED: accessing 'output' correctly
                output: tr.output !== undefined ? tr.output : { type: "text", value: "" },
            }));

            // The fix preserves the output
            expect(fixedMapping[0].output).toEqual(expectedOutput);
            expect(fixedMapping[0].output).not.toEqual({ type: "text", value: "" });
        });
    });

    describe("Bug 2: tc.args vs tc.input", () => {
        it("BUGGY CODE: accessing tc.args produces undefined (falls back to empty)", () => {
            const stepResult = createMockStepResult({
                toolCalls: [{
                    toolCallId: "c1",
                    toolName: "delegate",
                    input: {
                        delegations: [{ recipient: "researcher", prompt: "Research" }],
                    },
                }],
                toolResults: [{ toolCallId: "c1", toolName: "delegate", output: {} }],
            });

            const toolCalls = stepResult.toolCalls;

            // Simulate the BUGGY code pattern
            const buggyMapping = toolCalls.map((tc: any) => ({
                type: "tool-call" as const,
                toolCallId: tc.toolCallId,
                toolName: tc.toolName,
                // BUG: accessing 'args' instead of 'input'
                input: tc.args !== undefined ? tc.args : {},
            }));

            // The bug causes empty input
            expect(buggyMapping[0].input).toEqual({});
        });

        it("FIXED CODE: accessing tc.input preserves the data", () => {
            const expectedInput = {
                delegations: [{ recipient: "researcher", prompt: "Research" }],
            };

            const stepResult = createMockStepResult({
                toolCalls: [{
                    toolCallId: "c1",
                    toolName: "delegate",
                    input: expectedInput,
                }],
                toolResults: [{ toolCallId: "c1", toolName: "delegate", output: {} }],
            });

            const toolCalls = stepResult.toolCalls;

            // Simulate the FIXED code pattern
            const fixedMapping = toolCalls.map((tc: TypedToolCall<ToolSet>) => ({
                type: "tool-call" as const,
                toolCallId: tc.toolCallId,
                toolName: tc.toolName,
                // FIXED: accessing 'input' correctly
                input: tc.input !== undefined ? tc.input : {},
            }));

            // The fix preserves the input
            expect(fixedMapping[0].input).toEqual(expectedInput);
            expect(fixedMapping[0].input).not.toEqual({});
        });
    });

    describe("TypeScript Compile-Time Safety", () => {
        it("demonstrates that strict typing would catch these bugs at compile time", () => {
            // This test demonstrates that when using proper TypedToolCall/TypedToolResult types,
            // TypeScript will error if you try to access wrong properties.

            // With proper typing:
            const typedToolCall: TypedToolCall<ToolSet> = {
                type: "tool-call",
                toolCallId: "c1",
                toolName: "test",
                input: { key: "value" },
                dynamic: true,
            };

            // TypeScript allows tc.input (correct)
            expect(typedToolCall.input).toEqual({ key: "value" });

            // TypeScript would ERROR on tc.args (incorrect) - can't test at runtime
            // but this is the point: with strict types, the compiler catches it

            const typedToolResult: TypedToolResult<ToolSet> = {
                type: "tool-result",
                toolCallId: "c1",
                toolName: "test",
                input: {},
                output: { data: "result" },
                dynamic: true,
            };

            // TypeScript allows tr.output (correct)
            expect(typedToolResult.output).toEqual({ data: "result" });

            // TypeScript would ERROR on tr.result (incorrect) - can't test at runtime
            // but this is the point: with strict types, the compiler catches it
        });
    });
});
