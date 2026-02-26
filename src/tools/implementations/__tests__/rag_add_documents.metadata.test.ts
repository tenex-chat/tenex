import { describe, expect, it, mock } from "bun:test";

// Mock dependencies before imports
mock.module("@/utils/logger", () => ({
    logger: {
        info: () => {},
        debug: () => {},
        warn: () => {},
        error: () => {},
    },
}));

mock.module("@/services/rag/RAGService", () => ({
    RAGService: {
        getInstance: () => ({
            addDocuments: mock().mockResolvedValue(undefined),
        }),
    },
}));

mock.module("@/services/projects", () => ({
    isProjectContextInitialized: () => false,
    getProjectContext: () => {
        throw new Error("Not initialized");
    },
}));

// We need to test the coerceToDocumentMetadata function
// Since it's internal, we'll test it through the mergeWithProvenance behavior
// by creating documents with various metadata types

import type { ToolExecutionContext } from "@/tools/types";

// Create minimal mock context
const createMockContext = (): ToolExecutionContext => ({
    agent: {
        name: "test-agent",
        slug: "test-agent",
        pubkey: "test-pubkey-hex",
        llmConfig: { model: "test" },
        tools: [],
        eventId: "test-event-id",
    },
    workingDirectory: "/test/working/dir",
    conversationId: "test-conv-id",
    conversation: {} as any,
});

describe("rag_add_documents metadata handling", () => {
    describe("coerceToDocumentMetadata (through tool execution)", () => {
        it("should handle string metadata values", async () => {
            const capturedDocs: any[] = [];
            mock.module("@/services/rag/RAGService", () => ({
                RAGService: {
                    getInstance: () => ({
                        addDocuments: mock((_col: string, docs: any[]) => {
                            capturedDocs.push(...docs);
                            return Promise.resolve();
                        }),
                    }),
                },
            }));

            // Re-import after mock update
            const { createRAGAddDocumentsTool: createTool } = await import("../rag_add_documents");
            const tool = createTool(createMockContext());
            
            await tool.execute({
                description: "Add test documents with string metadata",
                collection: "test",
                documents: [{
                    content: "test content",
                    metadata: { title: "Test Title", author: "Test Author" },
                }],
            });

            expect(capturedDocs.length).toBeGreaterThan(0);
            const doc = capturedDocs[0];
            expect(doc.metadata.title).toBe("Test Title");
            expect(doc.metadata.author).toBe("Test Author");
        });

        it("should handle numeric metadata values", async () => {
            const capturedDocs: any[] = [];
            mock.module("@/services/rag/RAGService", () => ({
                RAGService: {
                    getInstance: () => ({
                        addDocuments: mock((_col: string, docs: any[]) => {
                            capturedDocs.push(...docs);
                            return Promise.resolve();
                        }),
                    }),
                },
            }));

            const { createRAGAddDocumentsTool: createTool } = await import("../rag_add_documents");
            const tool = createTool(createMockContext());
            
            await tool.execute({
                description: "Add test documents with numeric metadata",
                collection: "test",
                documents: [{
                    content: "test content",
                    metadata: { version: 42, score: 0.95 },
                }],
            });

            expect(capturedDocs.length).toBeGreaterThan(0);
            const doc = capturedDocs[0];
            expect(doc.metadata.version).toBe(42);
            expect(doc.metadata.score).toBe(0.95);
        });

        it("should handle boolean metadata values", async () => {
            const capturedDocs: any[] = [];
            mock.module("@/services/rag/RAGService", () => ({
                RAGService: {
                    getInstance: () => ({
                        addDocuments: mock((_col: string, docs: any[]) => {
                            capturedDocs.push(...docs);
                            return Promise.resolve();
                        }),
                    }),
                },
            }));

            const { createRAGAddDocumentsTool: createTool } = await import("../rag_add_documents");
            const tool = createTool(createMockContext());
            
            await tool.execute({
                description: "Add test documents with boolean metadata",
                collection: "test",
                documents: [{
                    content: "test content",
                    metadata: { isPublic: true, isDeleted: false },
                }],
            });

            expect(capturedDocs.length).toBeGreaterThan(0);
            const doc = capturedDocs[0];
            expect(doc.metadata.isPublic).toBe(true);
            expect(doc.metadata.isDeleted).toBe(false);
        });

        it("should handle null metadata values", async () => {
            const capturedDocs: any[] = [];
            mock.module("@/services/rag/RAGService", () => ({
                RAGService: {
                    getInstance: () => ({
                        addDocuments: mock((_col: string, docs: any[]) => {
                            capturedDocs.push(...docs);
                            return Promise.resolve();
                        }),
                    }),
                },
            }));

            const { createRAGAddDocumentsTool: createTool } = await import("../rag_add_documents");
            const tool = createTool(createMockContext());
            
            await tool.execute({
                description: "Add test documents with null metadata",
                collection: "test",
                documents: [{
                    content: "test content",
                    metadata: { deletedAt: null },
                }],
            });

            expect(capturedDocs.length).toBeGreaterThan(0);
            const doc = capturedDocs[0];
            expect(doc.metadata.deletedAt).toBe(null);
        });

        it("should handle nested object metadata", async () => {
            const capturedDocs: any[] = [];
            mock.module("@/services/rag/RAGService", () => ({
                RAGService: {
                    getInstance: () => ({
                        addDocuments: mock((_col: string, docs: any[]) => {
                            capturedDocs.push(...docs);
                            return Promise.resolve();
                        }),
                    }),
                },
            }));

            const { createRAGAddDocumentsTool: createTool } = await import("../rag_add_documents");
            const tool = createTool(createMockContext());
            
            await tool.execute({
                description: "Add test documents with nested metadata",
                collection: "test",
                documents: [{
                    content: "test content",
                    metadata: {
                        nested: { key: "value", count: 5 },
                    },
                }],
            });

            expect(capturedDocs.length).toBeGreaterThan(0);
            const doc = capturedDocs[0];
            expect(doc.metadata.nested).toEqual({ key: "value", count: 5 });
        });

        it("should handle array metadata", async () => {
            const capturedDocs: any[] = [];
            mock.module("@/services/rag/RAGService", () => ({
                RAGService: {
                    getInstance: () => ({
                        addDocuments: mock((_col: string, docs: any[]) => {
                            capturedDocs.push(...docs);
                            return Promise.resolve();
                        }),
                    }),
                },
            }));

            const { createRAGAddDocumentsTool: createTool } = await import("../rag_add_documents");
            const tool = createTool(createMockContext());
            
            await tool.execute({
                description: "Add test documents with array metadata",
                collection: "test",
                documents: [{
                    content: "test content",
                    metadata: {
                        tags: ["tag1", "tag2", "tag3"],
                    },
                }],
            });

            expect(capturedDocs.length).toBeGreaterThan(0);
            const doc = capturedDocs[0];
            expect(doc.metadata.tags).toEqual(["tag1", "tag2", "tag3"]);
        });

        it("should auto-inject agent_pubkey from context", async () => {
            const capturedDocs: any[] = [];
            mock.module("@/services/rag/RAGService", () => ({
                RAGService: {
                    getInstance: () => ({
                        addDocuments: mock((_col: string, docs: any[]) => {
                            capturedDocs.push(...docs);
                            return Promise.resolve();
                        }),
                    }),
                },
            }));

            const { createRAGAddDocumentsTool: createTool } = await import("../rag_add_documents");
            const context = createMockContext();
            const tool = createTool(context);
            
            await tool.execute({
                description: "Add test documents for agent pubkey injection",
                collection: "test",
                documents: [{
                    content: "test content",
                    metadata: {},
                }],
            });

            expect(capturedDocs.length).toBeGreaterThan(0);
            const doc = capturedDocs[0];
            expect(doc.metadata.agent_pubkey).toBe(context.agent.pubkey);
        });

        it("should allow user metadata to override base provenance", async () => {
            const capturedDocs: any[] = [];
            mock.module("@/services/rag/RAGService", () => ({
                RAGService: {
                    getInstance: () => ({
                        addDocuments: mock((_col: string, docs: any[]) => {
                            capturedDocs.push(...docs);
                            return Promise.resolve();
                        }),
                    }),
                },
            }));

            const { createRAGAddDocumentsTool: createTool } = await import("../rag_add_documents");
            const context = createMockContext();
            const tool = createTool(context);
            
            // User explicitly provides their own agent_pubkey
            await tool.execute({
                description: "Add test documents with custom pubkey",
                collection: "test",
                documents: [{
                    content: "test content",
                    metadata: { agent_pubkey: "custom-pubkey" },
                }],
            });

            expect(capturedDocs.length).toBeGreaterThan(0);
            const doc = capturedDocs[0];
            // User-provided value should override
            expect(doc.metadata.agent_pubkey).toBe("custom-pubkey");
        });
    });
});
