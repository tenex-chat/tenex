import { beforeEach, describe, expect, it, mock } from "bun:test";

// Mock logger
mock.module("@/utils/logger", () => ({
    logger: {
        info: () => {},
        debug: () => {},
        warn: () => {},
        error: () => {},
    },
}));

// Track RAG service calls
let mockCollections: string[] = [];
let addDocumentsCalls: Array<{ collection: string; docs: any[] }> = [];
let deleteDocumentCalls: Array<{ collection: string; id: string }> = [];
let queryWithFilterCalls: Array<{ collection: string; query: string; topK: number; filter?: string }> = [];
let queryWithFilterResults: any[] = [];
let createCollectionCalled = false;
let addDocumentsShouldThrow = false;
let queryWithFilterShouldThrow = false;

// Mock RAGService - single mock that uses flags for behavior variation
mock.module("@/services/rag/RAGService", () => ({
    RAGService: {
        getInstance: () => ({
            listCollections: async () => mockCollections,
            createCollection: async (name: string) => {
                createCollectionCalled = true;
                mockCollections.push(name);
                return { name, created_at: Date.now(), updated_at: Date.now() };
            },
            addDocuments: async (collection: string, docs: any[]) => {
                if (addDocumentsShouldThrow) {
                    throw new Error("RAG write failed");
                }
                addDocumentsCalls.push({ collection, docs });
            },
            deleteDocumentById: async (collection: string, id: string) => {
                deleteDocumentCalls.push({ collection, id });
            },
            queryWithFilter: async (collection: string, query: string, topK: number, filter?: string) => {
                if (queryWithFilterShouldThrow) {
                    throw new Error("Search failed");
                }
                queryWithFilterCalls.push({ collection, query, topK, filter });
                return queryWithFilterResults;
            },
            deleteCollection: async (name: string) => {
                mockCollections = mockCollections.filter((c) => c !== name);
            },
        }),
    },
}));

import { ReportEmbeddingService } from "../ReportEmbeddingService";

describe("ReportEmbeddingService", () => {
    let service: ReportEmbeddingService;

    beforeEach(() => {
        // Reset all tracking state
        mockCollections = [];
        addDocumentsCalls = [];
        deleteDocumentCalls = [];
        queryWithFilterCalls = [];
        queryWithFilterResults = [];
        createCollectionCalled = false;
        addDocumentsShouldThrow = false;
        queryWithFilterShouldThrow = false;

        // Reset singleton
        ReportEmbeddingService.resetInstance();
        service = ReportEmbeddingService.getInstance();
    });

    describe("initialization", () => {
        it("should create the project_reports collection on first init", async () => {
            await service.initialize();

            expect(createCollectionCalled).toBe(true);
            expect(mockCollections).toContain("project_reports");
        });

        it("should not recreate collection if it already exists", async () => {
            mockCollections = ["project_reports"];

            await service.initialize();

            expect(createCollectionCalled).toBe(false);
        });
    });

    describe("indexReport", () => {
        it("should index a report with correct document structure", async () => {
            const report = {
                slug: "architecture-doc",
                title: "Architecture Documentation",
                summary: "Overview of system architecture",
                content: "The system uses a microservices architecture...",
                hashtags: ["architecture", "design"],
            };

            const result = await service.indexReport(
                report,
                "31933:pubkey:project-slug",
                "agent-pubkey-abc",
                "claude-code"
            );

            expect(result).toBe(true);
            expect(addDocumentsCalls.length).toBe(1);

            const call = addDocumentsCalls[0];
            expect(call.collection).toBe("project_reports");
            expect(call.docs.length).toBe(1);

            const doc = call.docs[0];
            expect(doc.id).toBe("report_31933:pubkey:project-slug_architecture-doc");
            expect(doc.content).toContain("Title: Architecture Documentation");
            expect(doc.content).toContain("Summary: Overview of system architecture");
            expect(doc.content).toContain("Content: The system uses a microservices");
            expect(doc.content).toContain("Tags: architecture, design");
            expect(doc.metadata.slug).toBe("architecture-doc");
            expect(doc.metadata.projectId).toBe("31933:pubkey:project-slug");
            expect(doc.metadata.agentPubkey).toBe("agent-pubkey-abc");
            expect(doc.metadata.agentName).toBe("claude-code");
            expect(doc.metadata.type).toBe("report");
            expect(doc.source).toBe("report");
        });

        it("should upsert: delete existing before inserting", async () => {
            const report = {
                slug: "test-report",
                title: "Test Report",
                content: "Some content",
            };

            await service.indexReport(report, "project-id", "agent-pubkey");

            // Should have called delete first (upsert semantics)
            expect(deleteDocumentCalls.length).toBe(1);
            expect(deleteDocumentCalls[0].id).toBe("report_project-id_test-report");
            expect(deleteDocumentCalls[0].collection).toBe("project_reports");

            // Then add
            expect(addDocumentsCalls.length).toBe(1);
        });

        it("should return false for empty content", async () => {
            const report = {
                slug: "empty-report",
                title: "",
                content: "",
            };

            const result = await service.indexReport(report, "project-id", "agent-pubkey");

            expect(result).toBe(false);
            expect(addDocumentsCalls.length).toBe(0);
        });

        it("should truncate very long content", async () => {
            const longContent = "x".repeat(3000);
            const report = {
                slug: "long-report",
                title: "Long Report",
                content: longContent,
            };

            await service.indexReport(report, "project-id", "agent-pubkey");

            const doc = addDocumentsCalls[0].docs[0];
            // Content should be truncated to 2000 chars + "..."
            expect(doc.content).toContain("...");
            expect(doc.content.length).toBeLessThan(longContent.length + 200);
        });

        it("should not throw on RAG failure and return false", async () => {
            addDocumentsShouldThrow = true;

            const result = await service.indexReport(
                { slug: "test", title: "Test", content: "content" },
                "project-id",
                "agent-pubkey"
            );

            expect(result).toBe(false);
        });
    });

    describe("removeReport", () => {
        it("should delete a report document by project-scoped ID", async () => {
            await service.removeReport("test-slug", "project-id");

            expect(deleteDocumentCalls.length).toBe(1);
            expect(deleteDocumentCalls[0].collection).toBe("project_reports");
            expect(deleteDocumentCalls[0].id).toBe("report_project-id_test-slug");
        });
    });

    describe("semanticSearch - project isolation", () => {
        it("should apply project filter during vector search", async () => {
            queryWithFilterResults = [];

            await service.semanticSearch("architecture", {
                projectId: "31933:pubkey:my-project",
            });

            expect(queryWithFilterCalls.length).toBe(1);
            const call = queryWithFilterCalls[0];
            expect(call.collection).toBe("project_reports");
            expect(call.query).toBe("architecture");
            expect(call.filter).toBe(
                'metadata LIKE \'%"projectId":"31933:pubkey:my-project"%\''
            );
        });

        it("should NOT apply filter when projectId is 'ALL'", async () => {
            queryWithFilterResults = [];

            await service.semanticSearch("architecture", {
                projectId: "ALL",
            });

            expect(queryWithFilterCalls.length).toBe(1);
            expect(queryWithFilterCalls[0].filter).toBeUndefined();
        });

        it("should NOT apply filter when projectId is omitted", async () => {
            queryWithFilterResults = [];

            await service.semanticSearch("architecture");

            expect(queryWithFilterCalls.length).toBe(1);
            expect(queryWithFilterCalls[0].filter).toBeUndefined();
        });

        it("should filter results by minScore", async () => {
            queryWithFilterResults = [
                {
                    document: {
                        id: "report_proj_high",
                        content: "High relevance",
                        metadata: {
                            slug: "high-score",
                            projectId: "proj",
                            title: "High Score Report",
                            agentPubkey: "agent1",
                        },
                    },
                    score: 0.9,
                },
                {
                    document: {
                        id: "report_proj_low",
                        content: "Low relevance",
                        metadata: {
                            slug: "low-score",
                            projectId: "proj",
                            title: "Low Score Report",
                            agentPubkey: "agent2",
                        },
                    },
                    score: 0.1,
                },
            ];

            const results = await service.semanticSearch("test", {
                projectId: "proj",
                minScore: 0.3,
            });

            expect(results.length).toBe(1);
            expect(results[0].slug).toBe("high-score");
            expect(results[0].relevanceScore).toBe(0.9);
        });

        it("should respect limit parameter", async () => {
            queryWithFilterResults = Array.from({ length: 10 }, (_, i) => ({
                document: {
                    id: `report_proj_doc${i}`,
                    content: `Content ${i}`,
                    metadata: {
                        slug: `report-${i}`,
                        projectId: "proj",
                        title: `Report ${i}`,
                        agentPubkey: "agent1",
                    },
                },
                score: 0.9 - i * 0.05,
            }));

            const results = await service.semanticSearch("test", {
                projectId: "proj",
                limit: 3,
            });

            expect(results.length).toBe(3);
        });

        it("should transform results correctly", async () => {
            queryWithFilterResults = [
                {
                    document: {
                        id: "report_proj_test",
                        content: "Test content",
                        metadata: {
                            slug: "test-report",
                            projectId: "project-abc",
                            title: "Test Report",
                            summary: "A test report",
                            agentPubkey: "author-pubkey",
                            hashtags: ["testing", "docs"],
                            publishedAt: 1234567890,
                        },
                    },
                    score: 0.85,
                },
            ];

            const results = await service.semanticSearch("test", {
                projectId: "project-abc",
            });

            expect(results.length).toBe(1);
            expect(results[0]).toEqual({
                slug: "test-report",
                projectId: "project-abc",
                title: "Test Report",
                summary: "A test report",
                author: "author-pubkey",
                publishedAt: 1234567890,
                hashtags: ["testing", "docs"],
                relevanceScore: 0.85,
            });
        });

        it("should return empty array on search error", async () => {
            queryWithFilterShouldThrow = true;

            const results = await service.semanticSearch("test", {
                projectId: "proj",
            });

            expect(results).toEqual([]);
        });
    });

    describe("project boundary enforcement", () => {
        it("should create documents with projectId in metadata", async () => {
            const projectA = "31933:pubkey:project-a";
            const projectB = "31933:pubkey:project-b";

            await service.indexReport(
                { slug: "shared-slug", title: "Report A", content: "Content A" },
                projectA,
                "agent-a"
            );

            await service.indexReport(
                { slug: "shared-slug", title: "Report B", content: "Content B" },
                projectB,
                "agent-b"
            );

            // Both should be indexed with different document IDs
            expect(addDocumentsCalls.length).toBe(2);
            expect(addDocumentsCalls[0].docs[0].id).toBe(
                `report_${projectA}_shared-slug`
            );
            expect(addDocumentsCalls[1].docs[0].id).toBe(
                `report_${projectB}_shared-slug`
            );

            // Metadata should have different projectIds
            expect(addDocumentsCalls[0].docs[0].metadata.projectId).toBe(projectA);
            expect(addDocumentsCalls[1].docs[0].metadata.projectId).toBe(projectB);
        });

        it("should generate different document IDs for same slug in different projects", () => {
            // Access private method via any for testing
            const svc = service as any;
            const idA = svc.buildDocumentId("project-a", "my-report");
            const idB = svc.buildDocumentId("project-b", "my-report");

            expect(idA).not.toBe(idB);
            expect(idA).toBe("report_project-a_my-report");
            expect(idB).toBe("report_project-b_my-report");
        });

        it("should build correct project filter for SQL prefilter", () => {
            const svc = service as any;

            // Normal projectId
            const filter = svc.buildProjectFilter("31933:pubkey:my-project");
            expect(filter).toBe('metadata LIKE \'%"projectId":"31933:pubkey:my-project"%\'');

            // ALL = no filter
            expect(svc.buildProjectFilter("ALL")).toBeUndefined();
            expect(svc.buildProjectFilter("all")).toBeUndefined();

            // Empty = no filter
            expect(svc.buildProjectFilter("")).toBeUndefined();
            expect(svc.buildProjectFilter(undefined)).toBeUndefined();
        });

        it("should escape single quotes in projectId for SQL safety", () => {
            const svc = service as any;
            const filter = svc.buildProjectFilter("project's-id");
            expect(filter).toBe('metadata LIKE \'%"projectId":"project\'\'s-id"%\'');
        });
    });

    describe("indexExistingReports", () => {
        it("should skip deleted reports", async () => {
            const reports = [
                {
                    id: "1",
                    slug: "active",
                    title: "Active",
                    content: "Content",
                    author: "agent1",
                    isDeleted: false,
                },
                {
                    id: "2",
                    slug: "deleted",
                    title: "Deleted",
                    content: "Content",
                    author: "agent2",
                    isDeleted: true,
                },
            ];

            const count = await service.indexExistingReports(reports as any, "project-id");

            expect(count).toBe(1);
            expect(addDocumentsCalls.length).toBe(1);
            expect(addDocumentsCalls[0].docs[0].metadata.slug).toBe("active");
        });

        it("should skip reports without content", async () => {
            const reports = [
                {
                    id: "1",
                    slug: "with-content",
                    title: "Has Content",
                    content: "Actual content",
                    author: "agent1",
                },
                {
                    id: "2",
                    slug: "no-content",
                    title: "No Content",
                    content: undefined,
                    author: "agent2",
                },
            ];

            const count = await service.indexExistingReports(reports as any, "project-id");

            expect(count).toBe(1);
        });
    });

    describe("clearIndex", () => {
        it("should delete the collection and reset state", async () => {
            // Initialize first
            await service.initialize();
            expect(mockCollections).toContain("project_reports");

            await service.clearIndex();

            expect(mockCollections).not.toContain("project_reports");
        });
    });

    describe("getCollectionName", () => {
        it("should return project_reports", () => {
            expect(service.getCollectionName()).toBe("project_reports");
        });
    });
});
