import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as projectsModule from "@/services/projects";
import { RAGService } from "@/services/rag/RAGService";
import type { ToolExecutionContext } from "@/tools/types";
import { createRAGAddDocumentsTool } from "../rag_add_documents";

// Mock dependencies before imports
mock.module("@/utils/logger", () => ({
    logger: {
        info: () => {},
        debug: () => {},
        warn: () => {},
        error: () => {},
    },
}));

// We need to test the coerceToDocumentMetadata function
// Since it's internal, we'll test it through the mergeWithProvenance behavior
// by creating documents with various metadata types

let captureAddDocuments: (collection: string, docs: unknown[]) => Promise<void> = async () => {};

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
    let isProjectContextInitializedSpy: ReturnType<typeof spyOn>;
    let getProjectContextSpy: ReturnType<typeof spyOn>;
    let getInstanceSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        captureAddDocuments = async () => {};
        isProjectContextInitializedSpy = spyOn(
            projectsModule,
            "isProjectContextInitialized"
        ).mockReturnValue(false as never);
        getProjectContextSpy = spyOn(projectsModule, "getProjectContext").mockImplementation(
            () => {
                throw new Error("Not initialized");
            }
        );
        getInstanceSpy = spyOn(RAGService, "getInstance").mockReturnValue({
            addDocuments: (collection: string, docs: unknown[]) =>
                captureAddDocuments(collection, docs),
        } as never);
    });

    afterEach(() => {
        isProjectContextInitializedSpy?.mockRestore();
        getProjectContextSpy?.mockRestore();
        getInstanceSpy?.mockRestore();
    });

    describe("coerceToDocumentMetadata (through tool execution)", () => {
        it("should handle string metadata values", async () => {
            const capturedDocs: any[] = [];
            captureAddDocuments = async (_col: string, docs: unknown[]) => {
                capturedDocs.push(...docs);
            };
            const tool = createRAGAddDocumentsTool(createMockContext());

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
            captureAddDocuments = async (_col: string, docs: unknown[]) => {
                capturedDocs.push(...docs);
            };
            const tool = createRAGAddDocumentsTool(createMockContext());

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
            captureAddDocuments = async (_col: string, docs: unknown[]) => {
                capturedDocs.push(...docs);
            };
            const tool = createRAGAddDocumentsTool(createMockContext());

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
            captureAddDocuments = async (_col: string, docs: unknown[]) => {
                capturedDocs.push(...docs);
            };
            const tool = createRAGAddDocumentsTool(createMockContext());

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
            captureAddDocuments = async (_col: string, docs: unknown[]) => {
                capturedDocs.push(...docs);
            };
            const tool = createRAGAddDocumentsTool(createMockContext());

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
            captureAddDocuments = async (_col: string, docs: unknown[]) => {
                capturedDocs.push(...docs);
            };
            const tool = createRAGAddDocumentsTool(createMockContext());

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
            captureAddDocuments = async (_col: string, docs: unknown[]) => {
                capturedDocs.push(...docs);
            };
            const context = createMockContext();
            const tool = createRAGAddDocumentsTool(context);

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
            captureAddDocuments = async (_col: string, docs: unknown[]) => {
                capturedDocs.push(...docs);
            };
            const context = createMockContext();
            const tool = createRAGAddDocumentsTool(context);

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
