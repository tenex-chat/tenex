import { describe, expect, it } from "bun:test";
import { createRAGDeleteCollectionTool } from "../rag_delete_collection";
import { createMockExecutionEnvironment } from "@/test-utils";
import { tmpdir } from "os";

describe("ragDeleteCollectionTool - schema validation", () => {
    const mockContext = createMockExecutionEnvironment({
        workingDirectory: tmpdir(),
        projectBasePath: tmpdir(),
    });
    const ragDeleteCollectionTool = createRAGDeleteCollectionTool(mockContext);
    const schema = ragDeleteCollectionTool.inputSchema;

    describe("description is required", () => {
        it("should fail when description is missing", () => {
            const result = schema.safeParse({ name: "old_collection", confirm: true });
            expect(result.success).toBe(false);
        });

        it("should fail when description is empty", () => {
            const result = schema.safeParse({ name: "old_collection", confirm: true, description: "" });
            expect(result.success).toBe(false);
        });

        it("should fail when description is whitespace-only", () => {
            const result = schema.safeParse({ name: "old_collection", confirm: true, description: "   " });
            expect(result.success).toBe(false);
        });

        it("should pass with a valid description", () => {
            const result = schema.safeParse({ name: "old_collection", confirm: true, description: "Remove stale collection" });
            expect(result.success).toBe(true);
        });
    });
});
