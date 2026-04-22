/**
 * Tests for ConversationIndexingJob
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as constantsModule from "@/constants";
import * as conversationEmbeddingServiceModule from "../ConversationEmbeddingService";
import { RAGService } from "@/services/rag/RAGService";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { ConversationCatalogService } from "@/conversations/ConversationCatalogService";

const mockInitialize = vi.fn().mockResolvedValue(undefined);
const mockBuildDocument = vi.fn().mockReturnValue({ kind: "ok", document: { id: "doc-1", content: "test" } });
const mockGetCollectionName = vi.fn().mockReturnValue("conversation_embeddings");
const mockBulkUpsert = vi.fn().mockResolvedValue({ upsertedCount: 1, failedIndices: [] });
import { ConversationIndexingJob } from "../ConversationIndexingJob";
import * as conversationDiskReader from "@/conversations/ConversationDiskReader";

describe("ConversationIndexingJob", () => {
    const testBasePath = "/tmp/tenex-test-indexing/projects";

    beforeEach(() => {
        ConversationCatalogService.resetAll();

        // Clean up test directory
        if (existsSync(testBasePath)) {
            rmSync(testBasePath, { recursive: true, force: true });
        }

        vi.restoreAllMocks();
        vi.spyOn(constantsModule, "getTenexBasePath").mockReturnValue("/tmp/tenex-test-indexing");
        vi.spyOn(
            conversationEmbeddingServiceModule,
            "getConversationEmbeddingService"
        ).mockReturnValue({
            initialize: mockInitialize,
            buildDocument: mockBuildDocument,
            getCollectionName: mockGetCollectionName,
        } as any);
        vi.spyOn(RAGService, "getInstance").mockReturnValue({
            bulkUpsert: mockBulkUpsert,
        } as any);

        // Reset mocks
        mockInitialize.mockReset().mockResolvedValue(undefined);
        mockBuildDocument.mockReset().mockReturnValue({ kind: "ok", document: { id: "doc-1", content: "test" } });
        mockGetCollectionName.mockReset().mockReturnValue("conversation_embeddings");
        mockBulkUpsert.mockReset().mockResolvedValue({ upsertedCount: 1, failedIndices: [] });

        // Reset singleton
        ConversationIndexingJob.resetInstance();
    });

    afterEach(() => {
        ConversationCatalogService.resetAll();

        // Clean up
        if (existsSync(testBasePath)) {
            rmSync(testBasePath, { recursive: true, force: true });
        }

        // Reset singleton
        ConversationIndexingJob.resetInstance();
        vi.restoreAllMocks();
    });

    describe("Multi-project discovery", () => {
        it("should discover and index conversations across multiple projects", async () => {
            // Set up multi-project structure
            const project1 = join(testBasePath, "project1");
            const project2 = join(testBasePath, "project2");

            mkdirSync(join(project1, "conversations"), { recursive: true });
            mkdirSync(join(project2, "conversations"), { recursive: true });

            // Create test conversations
            const conv1 = "conv1-id";
            const conv2 = "conv2-id";
            const conv3 = "conv3-id";

            writeConversationFile(project1, conv1, "Test Conversation 1");
            writeConversationFile(project1, conv2, "Test Conversation 2");
            writeConversationFile(project2, conv3, "Test Conversation 3");

            // Mock disk reader functions
            vi.spyOn(conversationDiskReader, "listProjectIdsFromDisk").mockReturnValue([
                "project1",
                "project2",
            ]);

            vi.spyOn(
                conversationDiskReader,
                "listConversationIdsFromDiskForProject"
            ).mockImplementation((_basePath, projectId) => {
                if (projectId === "project1") return [conv1, conv2];
                if (projectId === "project2") return [conv3];
                return [];
            });

            vi.spyOn(conversationDiskReader, "readLightweightMetadata").mockImplementation(
                () => {
                    return {
                        metadata: {
                            title: "Test",
                            summary: "Test summary",
                            lastActivity: Date.now(),
                        },
                    } as any;
                }
            );

            // Return unique documents for each conversation
            let docCounter = 0;
            mockBuildDocument.mockImplementation(() => {
                docCounter++;
                return { kind: "ok", document: { id: `doc-${docCounter}`, content: "test" } };
            });

            const job = ConversationIndexingJob.getInstance();
            await job.indexPendingConversations();

            // Verify all conversations were built and flushed via bulkUpsert
            expect(mockBuildDocument).toHaveBeenCalledTimes(3);
            expect(mockBulkUpsert).toHaveBeenCalledTimes(1);
            expect(mockBulkUpsert).toHaveBeenCalledWith(
                "conversation_embeddings",
                expect.arrayContaining([expect.objectContaining({ content: "test" })])
            );
        });

        it("should handle projects with no conversations gracefully", async () => {
            const project1 = join(testBasePath, "project1");
            const emptyProject = join(testBasePath, "empty-project");

            mkdirSync(join(project1, "conversations"), { recursive: true });
            mkdirSync(join(emptyProject, "conversations"), { recursive: true });

            const conv1 = "conv1-id";
            writeConversationFile(project1, conv1, "Test Conversation 1");

            vi.spyOn(conversationDiskReader, "listProjectIdsFromDisk").mockReturnValue([
                "project1",
                "empty-project",
            ]);

            vi.spyOn(
                conversationDiskReader,
                "listConversationIdsFromDiskForProject"
            ).mockImplementation((_basePath, projectId) => {
                if (projectId === "project1") return [conv1];
                return [];
            });

            vi.spyOn(conversationDiskReader, "readLightweightMetadata").mockReturnValue({
                metadata: {
                    title: "Test",
                    summary: "Test",
                    lastActivity: Date.now(),
                },
            } as any);

            const job = ConversationIndexingJob.getInstance();
            await job.indexPendingConversations();

            // Only one conversation should be built
            expect(mockBuildDocument).toHaveBeenCalledTimes(1);
        });
    });

    describe("Re-indexing on metadata changes", () => {
        it("should re-index when conversation metadata changes", async () => {
            const projectId = "test-project";
            const conversationId = "test-conv";
            const projectPath = join(testBasePath, projectId);

            mkdirSync(join(projectPath, "conversations"), { recursive: true });
            writeConversationFile(projectPath, conversationId, "Initial Title");

            vi.spyOn(conversationDiskReader, "listProjectIdsFromDisk").mockReturnValue([projectId]);
            vi.spyOn(
                conversationDiskReader,
                "listConversationIdsFromDiskForProject"
            ).mockReturnValue([conversationId]);

            let metadataVersion = 1;
            vi.spyOn(conversationDiskReader, "readLightweightMetadata").mockImplementation(() => ({
                metadata: {
                    title: `Title v${metadataVersion}`,
                    summary: `Summary v${metadataVersion}`,
                    lastActivity: Date.now(),
                },
            })) as any;

            const job = ConversationIndexingJob.getInstance();
            await job.indexPendingConversations();

            expect(mockBuildDocument).toHaveBeenCalledTimes(1);

            // Change metadata
            metadataVersion = 2;
            writeConversationFile(projectPath, conversationId, "Updated Title");

            await job.indexPendingConversations();

            // Should be called again (once more) because metadata changed
            expect(mockBuildDocument).toHaveBeenCalledTimes(2);
        });

        it("should skip conversations with unchanged metadata", async () => {
            const projectId = "test-project";
            const conversationId = "test-conv";
            const projectPath = join(testBasePath, projectId);

            mkdirSync(join(projectPath, "conversations"), { recursive: true });
            writeConversationFile(projectPath, conversationId, "Test");

            vi.spyOn(conversationDiskReader, "listProjectIdsFromDisk").mockReturnValue([projectId]);
            vi.spyOn(
                conversationDiskReader,
                "listConversationIdsFromDiskForProject"
            ).mockReturnValue([conversationId]);

            const metadata = {
                metadata: {
                    title: "Unchanged Title",
                    summary: "Unchanged Summary",
                    lastActivity: 1000000,
                },
            };

            vi.spyOn(conversationDiskReader, "readLightweightMetadata").mockReturnValue(
                metadata as any
            );

            const job = ConversationIndexingJob.getInstance();
            await job.indexPendingConversations();

            // Indexed once
            expect(mockBuildDocument).toHaveBeenCalledTimes(1);

            await job.indexPendingConversations();

            // Should NOT be indexed again (skipped due to unchanged metadata)
            expect(mockBuildDocument).toHaveBeenCalledTimes(1);
        });
    });

    describe("Overlapping batch prevention", () => {
        it("should prevent overlapping batches", async () => {
            const projectId = "test-project";
            const projectPath = join(testBasePath, projectId);

            mkdirSync(join(projectPath, "conversations"), { recursive: true });
            writeConversationFile(projectPath, "conv1", "Conversation 1");
            writeConversationFile(projectPath, "conv2", "Conversation 2");
            writeConversationFile(projectPath, "conv3", "Conversation 3");

            vi.spyOn(conversationDiskReader, "listProjectIdsFromDisk").mockReturnValue([projectId]);
            vi.spyOn(
                conversationDiskReader,
                "listConversationIdsFromDiskForProject"
            ).mockReturnValue(["conv1", "conv2", "conv3"]);

            vi.spyOn(conversationDiskReader, "readLightweightMetadata").mockReturnValue({
                metadata: {
                    title: "Test",
                    summary: "Test",
                    lastActivity: Date.now(),
                },
            } as any);

            // Make bulkUpsert slow to simulate a long-running batch
            mockBulkUpsert.mockImplementation(
                () => new Promise((resolve) => setTimeout(() => resolve({ upsertedCount: 3, failedIndices: [] }), 100))
            );

            const job = ConversationIndexingJob.getInstance();
            const firstBatch = job.indexPendingConversations();
            await job.indexPendingConversations();
            await firstBatch;

            const status = job.getStatus();

            // Should not have started multiple batches concurrently
            expect(status.isBatchRunning).toBe(false);
        });
    });

    describe("Error handling", () => {
        it("should clear batch-running state after batch errors", async () => {
            const projectId = "test-project";
            const projectPath = join(testBasePath, projectId);

            mkdirSync(join(projectPath, "conversations"), { recursive: true });
            writeConversationFile(projectPath, "conv1", "Conversation 1");

            vi.spyOn(conversationDiskReader, "listProjectIdsFromDisk").mockReturnValue([projectId]);
            vi.spyOn(
                conversationDiskReader,
                "listConversationIdsFromDiskForProject"
            ).mockReturnValue(["conv1"]);

            vi.spyOn(conversationDiskReader, "readLightweightMetadata").mockReturnValue({
                metadata: {
                    title: "Test",
                    summary: "Test",
                    lastActivity: Date.now(),
                },
            } as any);

            mockBulkUpsert.mockRejectedValueOnce(new Error("RAG write failed"));

            const job = ConversationIndexingJob.getInstance();

            await expect(job.indexPendingConversations()).rejects.toThrow("RAG write failed");

            const status = job.getStatus();
            expect(status.isBatchRunning).toBe(false);
        });

        it("should clear batch-running state after project discovery errors", async () => {
            const listProjectsSpy = vi.spyOn(conversationDiskReader, "listProjectIdsFromDisk").mockImplementation(() => {
                throw new Error("Disk read error");
            });

            const job = ConversationIndexingJob.getInstance();

            await expect(job.indexPendingConversations()).rejects.toThrow("Disk read error");
            expect(mockBuildDocument).not.toHaveBeenCalled();

            listProjectsSpy.mockRestore();
            expect(job.getStatus().isBatchRunning).toBe(false);
        });
    });

    describe("State management", () => {
        it("should provide accurate status information", () => {
            const job = ConversationIndexingJob.getInstance();

            const statusBefore = job.getStatus();
            expect(statusBefore.isBatchRunning).toBe(false);
            expect(statusBefore.stateStats.totalEntries).toBe(0);
        });
    });
});

/**
 * Helper to write a test conversation file
 */
function writeConversationFile(projectPath: string, conversationId: string, title: string): void {
    const conversationPath = join(projectPath, "conversations", `${conversationId}.json`);
    const conversationData = {
        id: conversationId,
        metadata: {
            title,
            summary: `Summary for ${title}`,
            lastActivity: Date.now(),
        },
        messages: [
            {
                timestamp: Date.now(),
                role: "user",
                content: "Test message",
            },
        ],
    };

    writeFileSync(conversationPath, JSON.stringify(conversationData, null, 2), "utf-8");
}
