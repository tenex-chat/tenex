import { describe, expect, it } from "bun:test";
import { createRAGCollectionCreateTool } from "../rag_collection_create";
import { createMockExecutionEnvironment } from "@/test-utils";
import { tmpdir } from "node:os";

describe("ragCreateCollectionTool - schema validation", () => {
    const mockContext = createMockExecutionEnvironment({
        workingDirectory: tmpdir(),
        projectBasePath: tmpdir(),
    });
    const ragCreateCollectionTool = createRAGCollectionCreateTool(mockContext);
    const schema = ragCreateCollectionTool.inputSchema;

    describe("description is required", () => {
        it("should fail when description is missing", () => {
            const result = schema.safeParse({ name: "my_collection" });
            expect(result.success).toBe(false);
        });

        it("should fail when description is empty", () => {
            const result = schema.safeParse({ name: "my_collection", description: "" });
            expect(result.success).toBe(false);
        });

        it("should fail when description is whitespace-only", () => {
            const result = schema.safeParse({ name: "my_collection", description: "   " });
            expect(result.success).toBe(false);
        });

        it("should pass with a valid description", () => {
            const result = schema.safeParse({ name: "my_collection", description: "Create embeddings collection", schema: null });
            expect(result.success).toBe(true);
        });
    });
});
