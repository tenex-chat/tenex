import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { FileSystemAdapter } from "../FileSystemAdapter";
import { createTempDir, cleanupTempDir, createMockConversation } from "@/test-utils";
import path from "node:path";
import * as fs from "node:fs/promises";
import { pathExists } from "@/lib/fs/filesystem";

describe("FileSystemAdapter", () => {
    let adapter: FileSystemAdapter;
    let tempDir: string;
    let basePath: string;
    
    beforeEach(async () => {
        tempDir = await createTempDir("fs-adapter-test-");
        basePath = path.join(tempDir, "conversations");
        adapter = new FileSystemAdapter(basePath);
        await adapter.initialize();
    });
    
    afterEach(async () => {
        await cleanupTempDir(tempDir);
    });
    
    describe("initialize", () => {
        it("should create the base directory if it doesn't exist", async () => {
            const newPath = path.join(tempDir, "new-conversations");
            const newAdapter = new FileSystemAdapter(newPath);
            
            await newAdapter.initialize();
            
            const exists = await pathExists(newPath);
            expect(exists).toBe(true);
        });
        
        it("should handle existing directory", async () => {
            // Initialize again - should not throw
            await adapter.initialize();
            
            const exists = await pathExists(basePath);
            expect(exists).toBe(true);
        });
    });
    
    describe("save", () => {
        it("should save a conversation to disk", async () => {
            const conversation = createMockConversation({
                id: "test-conv-123",
                title: "Test Conversation"
            });
            
            await adapter.save(conversation);
            
            // Check the conversations subdirectory
            const conversationsDir = path.join(basePath, "conversations");
            const dirExists = await pathExists(conversationsDir);
            
            if (dirExists) {
                const files = await fs.readdir(conversationsDir);
                expect(files.length).toBeGreaterThan(0);
            } else {
                // Check base directory
                const files = await fs.readdir(basePath);
                expect(files.length).toBeGreaterThan(0);
            }
            
            // The adapter might sanitize the filename
            const savedFile = files.find(f => f.includes("test-conv-123"));
            expect(savedFile).toBeTruthy();
            
            if (savedFile) {
                const filePath = path.join(basePath, savedFile);
                const content = await fs.readFile(filePath, "utf-8");
                const saved = JSON.parse(content);
                expect(saved.id).toBe("test-conv-123");
                expect(saved.title).toBe("Test Conversation");
            }
        });
        
        it("should overwrite existing conversation", async () => {
            const conversation = createMockConversation({
                id: "test-conv-456",
                title: "Original Title"
            });
            
            await adapter.save(conversation);
            
            // Update and save again
            conversation.title = "Updated Title";
            await adapter.save(conversation);
            
            const filePath = path.join(basePath, "test-conv-456.json");
            const content = await fs.readFile(filePath, "utf-8");
            const saved = JSON.parse(content);
            expect(saved.title).toBe("Updated Title");
        });
        
        it("should handle special characters in conversation ID", async () => {
            const conversation = createMockConversation({
                id: "test/conv:with-special*chars",
                title: "Special Characters Test"
            });
            
            await adapter.save(conversation);
            
            // Should sanitize the filename
            const files = await fs.readdir(basePath);
            expect(files).toHaveLength(1);
            expect(files[0]).toContain("test_conv_with-special_chars");
        });
    });
    
    describe("load", () => {
        it("should load a saved conversation", async () => {
            const original = createMockConversation({
                id: "test-load-123",
                title: "Load Test",
                phase: "PLAN"
            });
            
            await adapter.save(original);
            
            const loaded = await adapter.load("test-load-123");
            expect(loaded).toBeTruthy();
            expect(loaded?.id).toBe("test-load-123");
            expect(loaded?.title).toBe("Load Test");
            expect(loaded?.phase).toBe("PLAN");
        });
        
        it("should return null for non-existent conversation", async () => {
            const loaded = await adapter.load("does-not-exist");
            expect(loaded).toBeNull();
        });
        
        it("should handle corrupted files gracefully", async () => {
            const filePath = path.join(basePath, "corrupted.json");
            await fs.writeFile(filePath, "{ invalid json");
            
            const loaded = await adapter.load("corrupted");
            expect(loaded).toBeNull();
        });
    });
    
    describe("list", () => {
        it("should list all saved conversations", async () => {
            const conv1 = createMockConversation({ id: "list-1", title: "First" });
            const conv2 = createMockConversation({ id: "list-2", title: "Second" });
            const conv3 = createMockConversation({ id: "list-3", title: "Third" });
            
            await adapter.save(conv1);
            await adapter.save(conv2);
            await adapter.save(conv3);
            
            const list = await adapter.list();
            expect(list).toHaveLength(3);
            
            const ids = list.map(c => c.id).sort();
            expect(ids).toEqual(["list-1", "list-2", "list-3"]);
        });
        
        it("should return empty array when no conversations exist", async () => {
            const list = await adapter.list();
            expect(list).toEqual([]);
        });
        
        it("should skip non-JSON files", async () => {
            const conv = createMockConversation({ id: "valid", title: "Valid" });
            await adapter.save(conv);
            
            // Add a non-JSON file
            await fs.writeFile(path.join(basePath, "README.md"), "# README");
            
            const list = await adapter.list();
            expect(list).toHaveLength(1);
            expect(list[0].id).toBe("valid");
        });
        
        it("should sort by creation time (newest first)", async () => {
            const conv1 = createMockConversation({ 
                id: "old", 
                startTime: new Date("2024-01-01")
            });
            const conv2 = createMockConversation({ 
                id: "new", 
                startTime: new Date("2024-01-03")
            });
            const conv3 = createMockConversation({ 
                id: "middle", 
                startTime: new Date("2024-01-02")
            });
            
            await adapter.save(conv1);
            await adapter.save(conv2);
            await adapter.save(conv3);
            
            const list = await adapter.list();
            expect(list[0].id).toBe("new");
            expect(list[1].id).toBe("middle");
            expect(list[2].id).toBe("old");
        });
    });
    
    describe("delete", () => {
        it("should delete a conversation", async () => {
            const conv = createMockConversation({ id: "to-delete" });
            await adapter.save(conv);
            
            // Verify it exists
            let loaded = await adapter.load("to-delete");
            expect(loaded).toBeTruthy();
            
            // Delete it
            await adapter.delete("to-delete");
            
            // Verify it's gone
            loaded = await adapter.load("to-delete");
            expect(loaded).toBeNull();
        });
        
        it("should not throw when deleting non-existent conversation", async () => {
            // Should not throw
            await adapter.delete("does-not-exist");
        });
    });
    
    describe("edge cases", () => {
        it("should handle very large conversations", async () => {
            const largeConv = createMockConversation({
                id: "large",
                title: "Large Conversation"
            });
            
            // Add lots of phase transitions
            for (let i = 0; i < 1000; i++) {
                largeConv.phaseTransitions.push({
                    from: "CHAT",
                    to: "PLAN",
                    timestamp: new Date(),
                    reason: `Transition ${i}`
                });
            }
            
            await adapter.save(largeConv);
            const loaded = await adapter.load("large");
            
            expect(loaded).toBeTruthy();
            expect(loaded?.phaseTransitions).toHaveLength(1000);
        });
        
        it("should handle concurrent operations", async () => {
            const promises = [];
            
            // Save 10 conversations concurrently
            for (let i = 0; i < 10; i++) {
                const conv = createMockConversation({ id: `concurrent-${i}` });
                promises.push(adapter.save(conv));
            }
            
            await Promise.all(promises);
            
            const list = await adapter.list();
            expect(list).toHaveLength(10);
        });
    });
});