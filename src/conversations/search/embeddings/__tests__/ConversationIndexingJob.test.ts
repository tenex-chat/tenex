/**
 * Tests for ConversationIndexingJob
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { join } from "path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";

// Mock everything BEFORE imports
vi.mock("@/constants", () => ({
    getTenexBasePath: () => "/tmp/tenex-test-indexing",
}));

vi.mock("@/utils/logger", () => ({
    logger: {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

// Mock conversationEmbeddingService BEFORE importing
const mockIndexConversation = vi.fn().mockResolvedValue(true);
const mockInitialize = vi.fn().mockResolvedValue(undefined);

vi.mock("../ConversationEmbeddingService", () => ({
    conversationEmbeddingService: {
        initialize: mockInitialize,
        indexConversation: mockIndexConversation,
    },
}));

// Now import after mocks are set up
import { ConversationIndexingJob } from "../ConversationIndexingJob";
import * as conversationDiskReader from "@/conversations/ConversationDiskReader";

describe("ConversationIndexingJob", () => {
    const testBasePath = "/tmp/tenex-test-indexing/projects";

    beforeEach(() => {
        // Clean up test directory
        if (existsSync(testBasePath)) {
            rmSync(testBasePath, { recursive: true, force: true });
        }

        // Reset mocks
        vi.clearAllMocks();

        // Reset singleton
        ConversationIndexingJob.resetInstance();
    });

    afterEach(() => {
        // Clean up
        if (existsSync(testBasePath)) {
            rmSync(testBasePath, { recursive: true, force: true });
        }

        // Reset singleton
        ConversationIndexingJob.resetInstance();
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
            ).mockImplementation((basePath, projectId) => {
                if (projectId === "project1") return [conv1, conv2];
                if (projectId === "project2") return [conv3];
                return [];
            });

            vi.spyOn(conversationDiskReader, "readLightweightMetadata").mockImplementation(
                (basePath, projectId, conversationId) => {
                    return {
                        metadata: {
                            title: `Conversation ${conversationId}`,
                            summary: "Test summary",
                            lastActivity: Date.now(),
                        },
                    } as any;
                }
            );

            // Create job and run batch
            const job = ConversationIndexingJob.getInstance(100);
            job.start();

            // Wait for initial batch
            await new Promise((resolve) => setTimeout(resolve, 200));

            job.stop();

            // Verify all conversations were indexed
            expect(mockIndexConversation).toHaveBeenCalledTimes(3);
            expect(mockIndexConversation).toHaveBeenCalledWith(conv1, "project1");
            expect(mockIndexConversation).toHaveBeenCalledWith(conv2, "project1");
            expect(mockIndexConversation).toHaveBeenCalledWith(conv3, "project2");
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
            ).mockImplementation((basePath, projectId) => {
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

            const job = ConversationIndexingJob.getInstance(100);
            job.start();

            await new Promise((resolve) => setTimeout(resolve, 200));
            job.stop();

            // Only one conversation should be indexed
            expect(mockIndexConversation).toHaveBeenCalledTimes(1);
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

            // First run - initial indexing
            const job = ConversationIndexingJob.getInstance(100);
            job.start();

            await new Promise((resolve) => setTimeout(resolve, 200));

            expect(mockIndexConversation).toHaveBeenCalledTimes(1);

            // Change metadata
            metadataVersion = 2;

            // Trigger another batch manually
            await job.forceFullReindex();

            // Should be called again (once more) because metadata changed
            expect(mockIndexConversation).toHaveBeenCalledTimes(2);

            job.stop();
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

            const job = ConversationIndexingJob.getInstance(100);
            job.start();

            await new Promise((resolve) => setTimeout(resolve, 200));

            // Indexed once
            expect(mockIndexConversation).toHaveBeenCalledTimes(1);

            // Wait for next batch
            await new Promise((resolve) => setTimeout(resolve, 150));

            // Should NOT be indexed again (skipped due to unchanged metadata)
            expect(mockIndexConversation).toHaveBeenCalledTimes(1);

            job.stop();
        });
    });

    describe("Overlapping batch prevention", () => {
        it("should prevent overlapping batches", async () => {
            const projectId = "test-project";
            const projectPath = join(testBasePath, projectId);

            mkdirSync(join(projectPath, "conversations"), { recursive: true });

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

            // Make indexing slow
            vi.mocked(mockIndexConversation).mockImplementation(
                () => new Promise((resolve) => setTimeout(() => resolve(true), 100))
            );

            const job = ConversationIndexingJob.getInstance(50); // Very short interval
            job.start();

            // Wait for multiple intervals to pass
            await new Promise((resolve) => setTimeout(resolve, 250));

            job.stop();

            const status = job.getStatus();

            // Should not have started multiple batches concurrently
            expect(status.isBatchRunning).toBe(false);
        });
    });

    describe("Error handling", () => {
        it("should continue job after indexing errors", async () => {
            const projectId = "test-project";
            const projectPath = join(testBasePath, projectId);

            mkdirSync(join(projectPath, "conversations"), { recursive: true });

            vi.spyOn(conversationDiskReader, "listProjectIdsFromDisk").mockReturnValue([projectId]);
            vi.spyOn(
                conversationDiskReader,
                "listConversationIdsFromDiskForProject"
            ).mockReturnValue(["conv1", "conv2"]);

            vi.spyOn(conversationDiskReader, "readLightweightMetadata").mockReturnValue({
                metadata: {
                    title: "Test",
                    summary: "Test",
                    lastActivity: Date.now(),
                },
            } as any);

            // First call fails, second succeeds
            vi.mocked(mockIndexConversation)
                .mockRejectedValueOnce(new Error("Indexing failed"))
                .mockResolvedValueOnce(true);

            const job = ConversationIndexingJob.getInstance(100);
            job.start();

            await new Promise((resolve) => setTimeout(resolve, 200));

            job.stop();

            // Both conversations attempted
            expect(mockIndexConversation).toHaveBeenCalledTimes(2);

            // Job should still be in good state
            const status = job.getStatus();
            expect(status.isRunning).toBe(false);
            expect(status.isBatchRunning).toBe(false);
        });

        it("should handle project discovery errors gracefully", async () => {
            vi.spyOn(conversationDiskReader, "listProjectIdsFromDisk").mockImplementation(() => {
                throw new Error("Disk read error");
            });

            const job = ConversationIndexingJob.getInstance(100);
            job.start();

            await new Promise((resolve) => setTimeout(resolve, 200));

            job.stop();

            // Should not crash
            expect(mockIndexConversation).not.toHaveBeenCalled();
        });
    });

    describe("State management", () => {
        it("should provide accurate status information", () => {
            const job = ConversationIndexingJob.getInstance(5000);

            const statusBefore = job.getStatus();
            expect(statusBefore.isRunning).toBe(false);
            expect(statusBefore.isBatchRunning).toBe(false);
            expect(statusBefore.intervalMs).toBe(5000);
            expect(statusBefore.stateStats.totalEntries).toBe(0);

            job.start();

            const statusRunning = job.getStatus();
            expect(statusRunning.isRunning).toBe(true);

            job.stop();

            const statusAfter = job.getStatus();
            expect(statusAfter.isRunning).toBe(false);
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
