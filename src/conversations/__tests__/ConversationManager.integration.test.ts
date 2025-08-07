import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { ConversationManager } from "../ConversationManager";
import { FileSystemAdapter } from "../persistence";
import type { Conversation } from "../types";
import {
    createConversationEvent,
    createReplyEvent,
    createAgentMessageEvent,
} from "@/test-utils/mocks/events";
import { ensureDirectory, removeDirectory, fileExists, readFile } from "@/lib/fs";
import { createTempDir, cleanupTempDir } from "@/test-utils";
import path from "node:path";

describe("ConversationManager Integration Tests", () => {
    let manager: ConversationManager;
    let testDir: string;
    let conversationsDir: string;

    beforeEach(async () => {
        // Create temporary test directory
        testDir = await createTempDir("tenex-conversation-test-");
        conversationsDir = path.join(testDir, ".tenex", "conversations");

        // Initialize manager with real file system
        manager = new ConversationManager(testDir);
        await manager.initialize();
    });

    afterEach(async () => {
        // Clean up
        await manager.cleanup();

        // Remove test directory
        await cleanupTempDir(testDir);
    });

    describe("Persistence to File System", () => {
        it("should persist conversations to disk", async () => {
            const event = createConversationEvent("conv-123", "Test conversation", "Test Title");
            const conversation = await manager.createConversation(event);

            // Verify conversation file exists
            const convFile = path.join(conversationsDir, "active", `${conversation.id}.json`);
            expect(await fileExists(convFile)).toBe(true);

            // Read and verify content
            const content = await readFile(convFile, "utf-8");
            const saved = JSON.parse(content);

            expect(saved.id).toBe("conv-123");
            expect(saved.title).toBe("Test Title");
            expect(saved.phase).toBe("chat");
            expect(saved.history).toHaveLength(1);
        });

        it("should persist conversation updates", async () => {
            const event = createConversationEvent("conv-123");
            const _conversation = await manager.createConversation(event);

            // Add events and update phase
            const reply1 = createReplyEvent("conv-123", "User message");
            const reply2 = createAgentMessageEvent("conv-123", "agent-pubkey", "Agent response");

            await manager.addEvent("conv-123", reply1);
            await manager.addEvent("conv-123", reply2);
            await manager.updatePhase("conv-123", "plan", "Moving to planning phase");

            // Force save
            await manager.saveConversation("conv-123");

            // Read from disk
            const convFile = path.join(conversationsDir, "active", "conv-123.json");
            const content = await readFile(convFile, "utf-8");
            const saved = JSON.parse(content);

            expect(saved.phase).toBe("plan");
            expect(saved.history).toHaveLength(3);
            expect(saved.metadata.chat_summary).toBe("Moving to planning phase");
        });

        it("should load conversations on startup", async () => {
            // Create conversations with first manager
            const _conv1 = await manager.createConversation(
                createConversationEvent("conv-1", "First", "Conversation 1")
            );
            const _conv2 = await manager.createConversation(
                createConversationEvent("conv-2", "Second", "Conversation 2")
            );

            // Update one conversation
            await manager.updatePhase("conv-1", "execute");
            await manager.saveConversation("conv-1");
            await manager.saveConversation("conv-2");

            // Create new manager instance
            const newManager = new ConversationManager(testDir);
            await newManager.initialize();

            // Verify conversations were loaded
            const loaded1 = newManager.getConversation("conv-1");
            const loaded2 = newManager.getConversation("conv-2");

            expect(loaded1).toBeDefined();
            expect(loaded1?.title).toBe("Conversation 1");
            expect(loaded1?.phase).toBe("execute");

            expect(loaded2).toBeDefined();
            expect(loaded2?.title).toBe("Conversation 2");
            expect(loaded2?.phase).toBe("chat");

            await newManager.cleanup();
        });
    });

    describe("Archival System", () => {
        it("should archive conversations to separate directory", async () => {
            const event = createConversationEvent("conv-archive", "To be archived", "Archive Test");
            const _conversation = await manager.createConversation(event);

            // Add some history
            await manager.addEvent("conv-archive", createReplyEvent("conv-archive", "Message 1"));
            await manager.addEvent("conv-archive", createReplyEvent("conv-archive", "Message 2"));

            // Archive the conversation
            await manager.archiveConversation("conv-archive");

            // Verify moved to archive
            const activeFile = path.join(conversationsDir, "active", "conv-archive.json");
            const archiveFile = path.join(conversationsDir, "archive", "conv-archive.json");

            expect(await fileExists(activeFile)).toBe(false);
            expect(await fileExists(archiveFile)).toBe(true);

            // Verify conversation is no longer in memory
            expect(manager.getConversation("conv-archive")).toBeUndefined();

            // Verify archived content is intact
            const archivedContent = await readFile(archiveFile, "utf-8");
            const archived = JSON.parse(archivedContent);
            expect(archived.title).toBe("Archive Test");
            expect(archived.history).toHaveLength(3);
        });

        it("should not load archived conversations on startup", async () => {
            // Create and archive a conversation
            await manager.createConversation(createConversationEvent("conv-archived"));
            await manager.archiveConversation("conv-archived");

            // Create active conversation
            await manager.createConversation(createConversationEvent("conv-active"));

            // New manager instance
            const newManager = new ConversationManager(testDir);
            await newManager.initialize();

            expect(newManager.getConversation("conv-active")).toBeDefined();
            expect(newManager.getConversation("conv-archived")).toBeUndefined();

            await newManager.cleanup();
        });
    });

    describe("Search Functionality", () => {
        it("should search conversations by title", async () => {
            // Create test conversations
            await manager.createConversation(
                createConversationEvent("conv-1", "Content", "Build Express API")
            );
            await manager.createConversation(
                createConversationEvent("conv-2", "Content", "React Tutorial")
            );
            await manager.createConversation(
                createConversationEvent("conv-3", "Content", "Express Middleware Guide")
            );

            // Search for "Express"
            const results = await manager.searchConversations("Express");

            expect(results).toHaveLength(2);
            expect(results.map((c) => c.title)).toContain("Build Express API");
            expect(results.map((c) => c.title)).toContain("Express Middleware Guide");
        });

        it("should handle case-insensitive search", async () => {
            await manager.createConversation(
                createConversationEvent("conv-1", "Content", "UPPERCASE TITLE")
            );
            await manager.createConversation(
                createConversationEvent("conv-2", "Content", "lowercase title")
            );
            await manager.createConversation(
                createConversationEvent("conv-3", "Content", "MiXeD CaSe TiTlE")
            );

            const results = await manager.searchConversations("title");

            expect(results).toHaveLength(3);
        });
    });

    describe("Autosave Mechanism", () => {
        it("should autosave conversations periodically", async () => {
            jest.useFakeTimers();

            const event = createConversationEvent("conv-autosave");
            const _conversation = await manager.createConversation(event);

            // Clear initial save
            const convFile = path.join(conversationsDir, "active", "conv-autosave.json");
            const initialMtime = (await fs.stat(convFile)).mtime;

            // Add an event but don't save manually
            await manager.addEvent(
                "conv-autosave",
                createReplyEvent("conv-autosave", "New message")
            );

            // Fast-forward 30 seconds to trigger autosave
            jest.advanceTimersByTime(30000);

            // Wait for autosave to complete
            await new Promise((resolve) => setImmediate(resolve));

            // Check if file was updated
            const newMtime = (await fs.stat(convFile)).mtime;
            expect(newMtime.getTime()).toBeGreaterThan(initialMtime.getTime());

            // Verify the new message was saved
            const content = await readFile(convFile, "utf-8");
            const saved = JSON.parse(content);
            expect(saved.history).toHaveLength(2);
            expect(saved.history[1].content).toBe("New message");

            jest.useRealTimers();
        });
    });

    describe("Concurrent Operations", () => {
        it("should handle concurrent conversation creation", async () => {
            const promises = [];

            // Create 10 conversations concurrently
            for (let i = 0; i < 10; i++) {
                const event = createConversationEvent(
                    `conv-concurrent-${i}`,
                    `Content ${i}`,
                    `Title ${i}`
                );
                promises.push(manager.createConversation(event));
            }

            const conversations = await Promise.all(promises);

            // Verify all were created
            expect(conversations).toHaveLength(10);

            // Verify all exist in manager
            for (let i = 0; i < 10; i++) {
                const conv = manager.getConversation(`conv-concurrent-${i}`);
                expect(conv).toBeDefined();
                expect(conv?.title).toBe(`Title ${i}`);
            }

            // Verify all were persisted
            const files = await fs.readdir(path.join(conversationsDir, "active"));
            expect(files.filter((f) => f.startsWith("conv-concurrent-"))).toHaveLength(10);
        });

        it("should handle concurrent updates to same conversation", async () => {
            const event = createConversationEvent("conv-updates");
            await manager.createConversation(event);

            // Perform concurrent updates
            const updates = [];
            for (let i = 0; i < 5; i++) {
                updates.push(
                    manager.addEvent(
                        "conv-updates",
                        createReplyEvent("conv-updates", `Message ${i}`)
                    )
                );
            }

            await Promise.all(updates);

            const conversation = manager.getConversation("conv-updates");
            expect(conversation?.history).toHaveLength(6); // Original + 5 updates
        });
    });

    describe("Error Recovery", () => {
        it("should handle corrupted conversation files gracefully", async () => {
            // Create a corrupted file
            const corruptedFile = path.join(conversationsDir, "active", "corrupted.json");
            await ensureDirectory(path.join(conversationsDir, "active"));
            await fs.writeFile(corruptedFile, "{ invalid json");

            // Create a valid conversation
            await manager.createConversation(createConversationEvent("valid-conv"));

            // Reload manager - should skip corrupted file
            const newManager = new ConversationManager(testDir);
            await newManager.initialize();

            expect(newManager.getConversation("valid-conv")).toBeDefined();
            expect(newManager.getAllConversations()).toHaveLength(1);

            await newManager.cleanup();
        });

        it("should recover from file system errors during save", async () => {
            const event = createConversationEvent("conv-error");
            const _conversation = await manager.createConversation(event);

            // Make directory read-only to cause save error
            const activeDir = path.join(conversationsDir, "active");
            await fs.chmod(activeDir, 0o444);

            // Try to save - should not throw
            try {
                await manager.saveConversation("conv-error");
            } catch (_error) {
                // Expected to fail, but shouldn't crash
            }

            // Restore permissions
            await fs.chmod(activeDir, 0o755);

            // Conversation should still be in memory
            expect(manager.getConversation("conv-error")).toBeDefined();
        });
    });

    describe("Metadata Persistence", () => {
        it("should persist and load conversation metadata", async () => {
            const event = createConversationEvent("conv-meta");
            const _conversation = await manager.createConversation(event);

            // Add various metadata
            await manager.updateMetadata("conv-meta", {
                plan: "Build a web application",
                tools_used: ["read_path", "analyze"],
                agent_notes: {
                    developer: "Started implementation",
                    reviewer: "Code looks good",
                },
                custom_field: "custom_value",
            });

            await manager.saveConversation("conv-meta");

            // Load in new manager
            const newManager = new ConversationManager(testDir);
            await newManager.initialize();

            const loaded = newManager.getConversation("conv-meta");
            expect(loaded?.metadata.plan).toBe("Build a web application");
            expect(loaded?.metadata.tools_used).toEqual(["read_path", "analyze"]);
            expect(loaded?.metadata.agent_notes).toEqual({
                developer: "Started implementation",
                reviewer: "Code looks good",
            });
            expect(loaded?.metadata.custom_field).toBe("custom_value");

            await newManager.cleanup();
        });
    });
});
