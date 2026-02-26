import { describe, expect, it } from "bun:test";
import { createRAGQueryTool } from "../rag_query";
import { createMockExecutionEnvironment } from "@/test-utils";
import { tmpdir } from "os";

describe("ragQueryTool - schema validation", () => {
    const mockContext = createMockExecutionEnvironment({
        workingDirectory: tmpdir(),
        projectBasePath: tmpdir(),
    });
    const ragQueryTool = createRAGQueryTool(mockContext);
    const schema = ragQueryTool.inputSchema;

    describe("description is required", () => {
        it("should fail when description is missing", () => {
            const result = schema.safeParse({ collection: "test", query_text: "search" });
            expect(result.success).toBe(false);
        });

        it("should fail when description is empty", () => {
            const result = schema.safeParse({ collection: "test", query_text: "search", description: "" });
            expect(result.success).toBe(false);
        });

        it("should fail when description is whitespace-only", () => {
            const result = schema.safeParse({ collection: "test", query_text: "search", description: "   " });
            expect(result.success).toBe(false);
        });

        it("should pass with a valid description", () => {
            const result = schema.safeParse({ collection: "test", query_text: "search", description: "Search test collection" });
            expect(result.success).toBe(true);
        });
    });
});
