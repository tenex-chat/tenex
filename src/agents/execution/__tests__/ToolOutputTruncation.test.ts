import { describe, expect, it } from "bun:test";
import {
    FullResultStash,
    TOOL_OUTPUT_TRUNCATION_THRESHOLD,
    buildTruncationPlaceholder,
    serializeToolResult,
    wrapToolsWithOutputTruncation,
} from "../ToolOutputTruncation";

describe("FullResultStash", () => {
    it("should stash and consume a result", () => {
        const stash = new FullResultStash();
        stash.stash("call-1", "full result data");

        expect(stash.consume("call-1")).toBe("full result data");
    });

    it("should return undefined and remove entry on consume", () => {
        const stash = new FullResultStash();
        stash.stash("call-1", "data");

        expect(stash.consume("call-1")).toBe("data");
        expect(stash.consume("call-1")).toBeUndefined();
    });

    it("should return undefined for unknown toolCallId", () => {
        const stash = new FullResultStash();
        expect(stash.consume("nonexistent")).toBeUndefined();
    });

    it("should clear all entries", () => {
        const stash = new FullResultStash();
        stash.stash("call-1", "a");
        stash.stash("call-2", "b");

        stash.clear();

        expect(stash.consume("call-1")).toBeUndefined();
        expect(stash.consume("call-2")).toBeUndefined();
    });
});

describe("serializeToolResult", () => {
    it("should pass strings through", () => {
        expect(serializeToolResult("hello")).toBe("hello");
    });

    it("should JSON-stringify objects", () => {
        expect(serializeToolResult({ key: "value" })).toBe('{"key":"value"}');
    });

    it("should return empty string for null", () => {
        expect(serializeToolResult(null)).toBe("");
    });

    it("should return empty string for undefined", () => {
        expect(serializeToolResult(undefined)).toBe("");
    });

    it("should JSON-stringify arrays", () => {
        expect(serializeToolResult([1, 2, 3])).toBe("[1,2,3]");
    });

    it("should handle numbers via JSON.stringify", () => {
        expect(serializeToolResult(42)).toBe("42");
    });
});

describe("buildTruncationPlaceholder", () => {
    it("should include tool name, call ID, preview and remaining count", () => {
        const preview = "a".repeat(500);
        const placeholder = buildTruncationPlaceholder("shell", "call_abc", preview, 20000);

        expect(placeholder).toContain('[shell result truncated (20000 chars)');
        expect(placeholder).toContain('fs_read(tool: "call_abc")');
        expect(placeholder).toContain("--- Preview ---");
        expect(placeholder).toContain(preview);
        expect(placeholder).toContain("... [19500 more chars]");
    });
});

describe("wrapToolsWithOutputTruncation", () => {
    it("should pass through small results unchanged", async () => {
        const stash = new FullResultStash();
        const smallResult = "small output";

        const tools = wrapToolsWithOutputTruncation(
            {
                myTool: {
                    execute: async () => smallResult,
                    parameters: { type: "object", properties: {} },
                } as any,
            },
            stash
        );

        const result = await tools.myTool.execute!({}, { toolCallId: "call-1" } as any);
        expect(result).toBe(smallResult);
        // Stash should be empty for small results
        expect(stash.consume("call-1")).toBeUndefined();
    });

    it("should truncate large string results and stash full result", async () => {
        const stash = new FullResultStash();
        const largeResult = "x".repeat(TOOL_OUTPUT_TRUNCATION_THRESHOLD + 5000);

        const tools = wrapToolsWithOutputTruncation(
            {
                shell: {
                    execute: async () => largeResult,
                    parameters: { type: "object", properties: {} },
                } as any,
            },
            stash
        );

        const result = await tools.shell.execute!({}, { toolCallId: "call-big" } as any);

        // LLM should see a truncation placeholder
        expect(typeof result).toBe("string");
        expect(result as string).toContain("truncated");
        expect(result as string).toContain('fs_read(tool: "call-big")');
        expect(result as string).toContain("--- Preview ---");

        // Full result should be stashed
        const stashed = stash.consume("call-big");
        expect(stashed).toBe(largeResult);
    });

    it("should truncate large object results after serialization", async () => {
        const stash = new FullResultStash();
        const largeObject = { data: "y".repeat(TOOL_OUTPUT_TRUNCATION_THRESHOLD + 1000) };

        const tools = wrapToolsWithOutputTruncation(
            {
                shell: {
                    execute: async () => largeObject,
                    parameters: { type: "object", properties: {} },
                } as any,
            },
            stash
        );

        const result = await tools.shell.execute!({}, { toolCallId: "call-obj" } as any);

        expect(typeof result).toBe("string");
        expect(result as string).toContain("truncated");

        // Stash should contain the JSON-serialized full result
        const stashed = stash.consume("call-obj");
        expect(stashed).toBe(JSON.stringify(largeObject));
    });

    it("should skip tools without execute", () => {
        const stash = new FullResultStash();
        const toolWithoutExecute = { parameters: { type: "object", properties: {} } } as any;

        const tools = wrapToolsWithOutputTruncation({ noExec: toolWithoutExecute }, stash);
        expect(tools.noExec).toBe(toolWithoutExecute);
    });

    it("should handle null/undefined results without truncation", async () => {
        const stash = new FullResultStash();

        const tools = wrapToolsWithOutputTruncation(
            {
                myTool: {
                    execute: async () => null,
                    parameters: { type: "object", properties: {} },
                } as any,
            },
            stash
        );

        const result = await tools.myTool.execute!({}, { toolCallId: "call-null" } as any);
        expect(result).toBeNull();
        expect(stash.consume("call-null")).toBeUndefined();
    });

    it("should not wrap project_list (truncation exempt)", async () => {
        const stash = new FullResultStash();
        const largeResult = "x".repeat(TOOL_OUTPUT_TRUNCATION_THRESHOLD + 1000);
        const originalExecute = async () => largeResult;

        const tools = wrapToolsWithOutputTruncation(
            {
                project_list: {
                    execute: originalExecute,
                    parameters: { type: "object", properties: {} },
                } as any,
            },
            stash
        );

        const result = await tools.project_list.execute!({}, { toolCallId: "call-pl" } as any);

        // Exempt tools pass through unchanged — no truncation, no stash entry
        expect(result).toBe(largeResult);
        expect(stash.consume("call-pl")).toBeUndefined();
    });

    it("should handle results exactly at threshold without truncation", async () => {
        const stash = new FullResultStash();
        const exactResult = "z".repeat(TOOL_OUTPUT_TRUNCATION_THRESHOLD);

        const tools = wrapToolsWithOutputTruncation(
            {
                myTool: {
                    execute: async () => exactResult,
                    parameters: { type: "object", properties: {} },
                } as any,
            },
            stash
        );

        const result = await tools.myTool.execute!({}, { toolCallId: "call-exact" } as any);
        expect(result).toBe(exactResult);
        expect(stash.consume("call-exact")).toBeUndefined();
    });
});
