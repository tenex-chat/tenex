/**
 * Tests for IndexingStateManager
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "path";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { IndexingStateManager } from "../IndexingStateManager";
import * as conversationDiskReader from "@/conversations/ConversationDiskReader";

// Mock logger
vi.mock("@/utils/logger", () => ({
    logger: {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

describe("IndexingStateManager", () => {
    const testBasePath = "/tmp/tenex-test-state-manager";

    beforeEach(() => {
        // Clean up test directory
        if (existsSync(testBasePath)) {
            rmSync(testBasePath, { recursive: true, force: true });
        }
        mkdirSync(testBasePath, { recursive: true });

        // Reset mocks
        vi.clearAllMocks();
    });

    afterEach(() => {
        // Clean up
        if (existsSync(testBasePath)) {
            rmSync(testBasePath, { recursive: true, force: true });
        }
    });

    describe("Persistence", () => {
        it("should persist state to disk and reload it", () => {
            const projectId = "test-project";
            const conversationId = "test-conv";

            // Mock metadata
            vi.spyOn(conversationDiskReader, "readLightweightMetadata").mockReturnValue({
                id: conversationId,
                title: "Test Title",
                summary: "Test Summary",
                lastActivity: 12345,
            });

            // Create manager and mark as indexed
            const manager1 = new IndexingStateManager(testBasePath);
            manager1.markIndexed(testBasePath, projectId, conversationId);
            manager1.saveNow();

            // Verify state file exists
            const stateFile = join(testBasePath, "indexing-state.json");
            expect(existsSync(stateFile)).toBe(true);

            // Create new manager and verify it loaded the state
            const manager2 = new IndexingStateManager(testBasePath);
            const needsIndexing = manager2.needsIndexing(testBasePath, projectId, conversationId);

            // Should not need indexing because it was already indexed
            expect(needsIndexing).toBe(false);
        });

        it("should handle missing state file gracefully", () => {
            const manager = new IndexingStateManager(testBasePath);

            const stats = manager.getStats();
            expect(stats.totalEntries).toBe(0);
        });

        it("should handle corrupted state file", () => {
            const stateFile = join(testBasePath, "indexing-state.json");
            writeFileSync(stateFile, "{ corrupted json", "utf-8");

            // Should not throw
            const manager = new IndexingStateManager(testBasePath);
            const stats = manager.getStats();
            expect(stats.totalEntries).toBe(0);
        });
    });

    describe("Change detection", () => {
        it("should detect when conversation has never been indexed", () => {
            const projectId = "test-project";
            const conversationId = "test-conv";

            vi.spyOn(conversationDiskReader, "readLightweightMetadata").mockReturnValue({
                id: conversationId,
                title: "Test",
                summary: "Test",
                lastActivity: 12345,
            });

            const manager = new IndexingStateManager(testBasePath);
            const needsIndexing = manager.needsIndexing(testBasePath, projectId, conversationId);

            expect(needsIndexing).toBe(true);
        });

        it("should detect title changes", () => {
            const projectId = "test-project";
            const conversationId = "test-conv";

            let currentTitle = "Original Title";
            vi.spyOn(conversationDiskReader, "readLightweightMetadata").mockImplementation(() => ({
                id: conversationId,
                title: currentTitle,
                summary: "Summary",
                lastActivity: 12345,
            }));

            const manager = new IndexingStateManager(testBasePath);

            // Mark as indexed with original title
            manager.markIndexed(testBasePath, projectId, conversationId);
            expect(manager.needsIndexing(testBasePath, projectId, conversationId)).toBe(false);

            // Change title
            currentTitle = "Updated Title";
            expect(manager.needsIndexing(testBasePath, projectId, conversationId)).toBe(true);
        });

        it("should detect summary changes", () => {
            const projectId = "test-project";
            const conversationId = "test-conv";

            let currentSummary = "Original Summary";
            vi.spyOn(conversationDiskReader, "readLightweightMetadata").mockImplementation(() => ({
                id: conversationId,
                title: "Title",
                summary: currentSummary,
                lastActivity: 12345,
            }));

            const manager = new IndexingStateManager(testBasePath);

            manager.markIndexed(testBasePath, projectId, conversationId);
            expect(manager.needsIndexing(testBasePath, projectId, conversationId)).toBe(false);

            currentSummary = "Updated Summary";
            expect(manager.needsIndexing(testBasePath, projectId, conversationId)).toBe(true);
        });

        it("should detect lastActivity changes", () => {
            const projectId = "test-project";
            const conversationId = "test-conv";

            let currentActivity = 12345;
            vi.spyOn(conversationDiskReader, "readLightweightMetadata").mockImplementation(() => ({
                id: conversationId,
                title: "Title",
                summary: "Summary",
                lastActivity: currentActivity,
            }));

            const manager = new IndexingStateManager(testBasePath);

            manager.markIndexed(testBasePath, projectId, conversationId);
            expect(manager.needsIndexing(testBasePath, projectId, conversationId)).toBe(false);

            currentActivity = 99999;
            expect(manager.needsIndexing(testBasePath, projectId, conversationId)).toBe(true);
        });

        it("should not need re-indexing when metadata unchanged", () => {
            const projectId = "test-project";
            const conversationId = "test-conv";

            vi.spyOn(conversationDiskReader, "readLightweightMetadata").mockReturnValue({
                id: conversationId,
                title: "Title",
                summary: "Summary",
                lastActivity: 12345,
            });

            const manager = new IndexingStateManager(testBasePath);

            manager.markIndexed(testBasePath, projectId, conversationId);
            expect(manager.needsIndexing(testBasePath, projectId, conversationId)).toBe(false);

            // Check again - should still be false
            expect(manager.needsIndexing(testBasePath, projectId, conversationId)).toBe(false);
        });

        it("should handle missing metadata gracefully", () => {
            const projectId = "test-project";
            const conversationId = "test-conv";

            vi.spyOn(conversationDiskReader, "readLightweightMetadata").mockReturnValue(null);

            const manager = new IndexingStateManager(testBasePath);
            const needsIndexing = manager.needsIndexing(testBasePath, projectId, conversationId);

            // Cannot determine - should skip
            expect(needsIndexing).toBe(false);
        });

        it("should detect hash changes across batches without forceFullReindex", () => {
            const projectId = "test-project";
            const conv1 = "conv-1";
            const conv2 = "conv-2";

            // Initial metadata state
            const metadataState = new Map([
                [
                    conv1,
                    {
                        id: conv1,
                        title: "Conversation 1",
                        summary: "Summary 1",
                        lastActivity: 1000,
                    },
                ],
                [
                    conv2,
                    {
                        id: conv2,
                        title: "Conversation 2",
                        summary: "Summary 2",
                        lastActivity: 2000,
                    },
                ],
            ]);

            vi.spyOn(conversationDiskReader, "readLightweightMetadata").mockImplementation(
                (_basePath, _projectId, conversationId) => {
                    return metadataState.get(conversationId) || null;
                }
            );

            const manager = new IndexingStateManager(testBasePath);

            // BATCH 1: Both conversations need indexing (never indexed before)
            expect(manager.needsIndexing(testBasePath, projectId, conv1)).toBe(true);
            expect(manager.needsIndexing(testBasePath, projectId, conv2)).toBe(true);

            // Mark both as indexed
            manager.markIndexed(testBasePath, projectId, conv1);
            manager.markIndexed(testBasePath, projectId, conv2);

            // BATCH 2: No changes - neither should need indexing
            expect(manager.needsIndexing(testBasePath, projectId, conv1)).toBe(false);
            expect(manager.needsIndexing(testBasePath, projectId, conv2)).toBe(false);

            // CHANGE: Update conv1's summary (simulating metadata change between batches)
            metadataState.set(conv1, {
                id: conv1,
                title: "Conversation 1",
                summary: "UPDATED Summary 1",
                lastActivity: 1000,
            });

            // BATCH 3: Only conv1 should need re-indexing (hash changed)
            expect(manager.needsIndexing(testBasePath, projectId, conv1)).toBe(true);
            expect(manager.needsIndexing(testBasePath, projectId, conv2)).toBe(false);

            // Mark conv1 as indexed again
            manager.markIndexed(testBasePath, projectId, conv1);

            // CHANGE: Update conv2's lastActivity (simulating new message)
            metadataState.set(conv2, {
                id: conv2,
                title: "Conversation 2",
                summary: "Summary 2",
                lastActivity: 3000, // advanced
            });

            // BATCH 4: Only conv2 should need re-indexing (activity advanced)
            expect(manager.needsIndexing(testBasePath, projectId, conv1)).toBe(false);
            expect(manager.needsIndexing(testBasePath, projectId, conv2)).toBe(true);
        });
    });

    describe("Memory management", () => {
        it("should evict old entries when reaching max size", () => {
            const manager = new IndexingStateManager(testBasePath);

            vi.spyOn(conversationDiskReader, "readLightweightMetadata").mockImplementation(
                (_basePath, _projectId, conversationId) => ({
                    id: conversationId,
                    title: "Test",
                    summary: "Test",
                    lastActivity: 12345,
                })
            );

            // Add entries up to max + 1
            const maxEntries = 10000;
            for (let i = 0; i < maxEntries + 500; i++) {
                manager.markIndexed(testBasePath, "project", `conv-${i}`);
            }

            manager.saveNow();

            const stats = manager.getStats();

            // Should have evicted some entries
            expect(stats.totalEntries).toBeLessThanOrEqual(maxEntries);
            expect(stats.totalEntries).toBeGreaterThan(maxEntries - 1000);
        });

        it("should provide accurate statistics", () => {
            const manager = new IndexingStateManager(testBasePath);

            vi.spyOn(conversationDiskReader, "readLightweightMetadata").mockImplementation(
                (_basePath, _projectId, conversationId) => ({
                    id: conversationId,
                    title: "Test",
                    summary: "Test",
                    lastActivity: 12345,
                })
            );

            const stats1 = manager.getStats();
            expect(stats1.totalEntries).toBe(0);
            expect(stats1.isDirty).toBe(false);

            manager.markIndexed(testBasePath, "project1", "conv1");

            const stats2 = manager.getStats();
            expect(stats2.totalEntries).toBe(1);
            expect(stats2.isDirty).toBe(true);

            manager.saveNow();

            const stats3 = manager.getStats();
            expect(stats3.isDirty).toBe(false);
        });
    });

    describe("State manipulation", () => {
        it("should clear individual conversation state", () => {
            const projectId = "test-project";
            const conversationId = "test-conv";

            vi.spyOn(conversationDiskReader, "readLightweightMetadata").mockReturnValue({
                id: conversationId,
                title: "Test",
                summary: "Test",
                lastActivity: 12345,
            });

            const manager = new IndexingStateManager(testBasePath);

            manager.markIndexed(testBasePath, projectId, conversationId);
            expect(manager.needsIndexing(testBasePath, projectId, conversationId)).toBe(false);

            manager.clearState(projectId, conversationId);
            expect(manager.needsIndexing(testBasePath, projectId, conversationId)).toBe(true);
        });

        it("should clear all state", () => {
            vi.spyOn(conversationDiskReader, "readLightweightMetadata").mockImplementation(
                (_basePath, _projectId, conversationId) => ({
                    id: conversationId,
                    title: "Test",
                    summary: "Test",
                    lastActivity: 12345,
                })
            );

            const manager = new IndexingStateManager(testBasePath);

            manager.markIndexed(testBasePath, "project1", "conv1");
            manager.markIndexed(testBasePath, "project1", "conv2");
            manager.markIndexed(testBasePath, "project2", "conv3");

            expect(manager.getStats().totalEntries).toBe(3);

            manager.clearAllState();

            expect(manager.getStats().totalEntries).toBe(0);
        });
    });

    describe("No-content state handling", () => {
        it("should track conversations with no indexable content", () => {
            const projectId = "test-project";
            const conversationId = "test-conv";

            vi.spyOn(conversationDiskReader, "readLightweightMetadata").mockReturnValue({
                id: conversationId,
                title: "Empty Conversation",
                summary: undefined,
                lastActivity: 1000,
            });

            const manager = new IndexingStateManager(testBasePath);

            // First check - needs indexing
            expect(manager.needsIndexing(testBasePath, projectId, conversationId)).toBe(true);

            // Mark as indexed with no content
            manager.markIndexed(testBasePath, projectId, conversationId, true);

            // Should not need re-indexing if nothing changed
            expect(manager.needsIndexing(testBasePath, projectId, conversationId)).toBe(false);
        });

        it("should re-check no-content conversations if activity advances", () => {
            const projectId = "test-project";
            const conversationId = "test-conv";

            let currentActivity = 1000;
            vi.spyOn(conversationDiskReader, "readLightweightMetadata").mockImplementation(() => ({
                id: conversationId,
                title: "Initially Empty",
                summary: undefined,
                lastActivity: currentActivity,
            }));

            const manager = new IndexingStateManager(testBasePath);

            // Mark as indexed with no content
            manager.markIndexed(testBasePath, projectId, conversationId, true);
            expect(manager.needsIndexing(testBasePath, projectId, conversationId)).toBe(false);

            // Activity advances (e.g., new message added)
            currentActivity = 2000;

            // Should need re-indexing to check if content now exists
            expect(manager.needsIndexing(testBasePath, projectId, conversationId)).toBe(true);
        });

        it("should not repeatedly index conversations with persistent no-content", () => {
            const projectId = "test-project";
            const conversationId = "test-conv";

            vi.spyOn(conversationDiskReader, "readLightweightMetadata").mockReturnValue({
                id: conversationId,
                title: "Permanently Empty",
                summary: undefined,
                lastActivity: 1000,
            });

            const manager = new IndexingStateManager(testBasePath);

            // First index attempt
            expect(manager.needsIndexing(testBasePath, projectId, conversationId)).toBe(true);
            manager.markIndexed(testBasePath, projectId, conversationId, true);

            // Multiple checks should not require re-indexing
            for (let i = 0; i < 5; i++) {
                expect(manager.needsIndexing(testBasePath, projectId, conversationId)).toBe(false);
            }
        });
    });

    describe("Disposal", () => {
        it("should save state on dispose", () => {
            const projectId = "test-project";
            const conversationId = "test-conv";

            vi.spyOn(conversationDiskReader, "readLightweightMetadata").mockReturnValue({
                id: conversationId,
                title: "Test",
                summary: "Test",
                lastActivity: 12345,
            });

            const manager = new IndexingStateManager(testBasePath);
            manager.markIndexed(testBasePath, projectId, conversationId);

            // Dispose without explicit save
            manager.dispose();

            // Verify state was saved
            const stateFile = join(testBasePath, "indexing-state.json");
            expect(existsSync(stateFile)).toBe(true);

            const content = JSON.parse(readFileSync(stateFile, "utf-8"));
            expect(content.states).toHaveProperty(`${projectId}:${conversationId}`);
        });
    });
});
