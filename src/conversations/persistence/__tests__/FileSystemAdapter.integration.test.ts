import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { FileSystemAdapter } from "../FileSystemAdapter";
import { createTempDir, cleanupTempDir } from "@/test-utils";
import { logger } from "@/utils/logger";
import * as path from "path";
import * as fs from "fs/promises";
import type { Conversation } from "@/conversations/types";

describe("FileSystemAdapter Integration Test", () => {
    let testDir: string;
    let projectPath: string;
    let adapter: FileSystemAdapter;
    
    beforeEach(async () => {
        // Mock NDK to avoid initialization errors
        mock.module("@/nostr/ndkClient", () => ({
            getNDK: () => ({
                fetchEvents: async () => [],
                connect: async () => {},
                signer: { privateKey: () => "mock-private-key" }
            })
        }));
        
        // Create test directories
        testDir = await createTempDir("tenex-adapter-test-");
        projectPath = path.join(testDir, "test-project");
        await fs.mkdir(projectPath, { recursive: true });
        
        // Initialize adapter
        adapter = new FileSystemAdapter(projectPath);
        await adapter.initialize();
    });
    
    afterEach(async () => {
        // Cleanup
        if (testDir) {
            await cleanupTempDir(testDir);
        }
        mock.restore();
    });
    
    it("should save and load a conversation", async () => {
        const conversationId = "test-conv-1";
        const conversation: Conversation = {
            id: conversationId,
            title: "Test Conversation",
            phase: "CHAT",
            history: [], // Empty history
            agentContexts: new Map([
                ["orchestrator", {
                    agentSlug: "orchestrator",
                    messages: [],
                    tokenCount: 0,
                    lastUpdate: new Date()
                }]
            ]),
            phaseStartedAt: Date.now(),
            metadata: {
                summary: "Test summary",
                requirements: "Test requirements",
                continueCallCounts: {
                    CHAT: 1
                }
            },
            phaseTransitions: [
                { 
                    from: "CHAT", 
                    to: "PLAN", 
                    timestamp: Date.now(),
                    message: "Transitioning to planning phase",
                    agentPubkey: "mock-agent-pubkey",
                    agentName: "Orchestrator"
                }
            ],
            executionTime: {
                totalSeconds: 0,
                isActive: false,
                lastUpdated: Date.now()
            }
        };
        
        // Save conversation
        await adapter.save(conversation);
        
        // Verify file was created (files are saved as {id}.json, not in subdirectories)
        const conversationPath = path.join(
            projectPath,
            ".tenex",
            "conversations",
            `${conversationId}.json`
        );
        
        const fileExists = await fs.access(conversationPath).then(() => true).catch(() => false);
        expect(fileExists).toBe(true);
        
        // Load conversation
        const loaded = await adapter.load(conversationId);
        expect(loaded).toBeDefined();
        expect(loaded?.id).toBe(conversationId);
        expect(loaded?.title).toBe("Test Conversation");
        expect(loaded?.phase).toBe("chat"); // Schema transforms to lowercase
        expect(loaded?.metadata.continueCallCounts?.CHAT).toBe(1);
        
        // Verify agentContexts Map is properly restored
        expect(loaded?.agentContexts).toBeInstanceOf(Map);
        expect(loaded?.agentContexts.get("orchestrator")).toBeDefined();
    });
    
    it("should list all conversations", async () => {
        // Save multiple conversations
        const conversations: Conversation[] = [];
        for (let i = 0; i < 3; i++) {
            const conv: Conversation = {
                id: `test-conv-${i}`,
                title: `Test Conversation ${i}`,
                phase: "CHAT",
                history: [],
                agentContexts: new Map(),
                phaseStartedAt: Date.now(),
                metadata: {},
                phaseTransitions: [],
                executionTime: {
                    totalSeconds: 0,
                    isActive: false,
                    lastUpdated: Date.now()
                }
            };
            conversations.push(conv);
            await adapter.save(conv);
        }
        
        // List conversations
        const metadata = await adapter.list();
        expect(metadata).toHaveLength(3);
        expect(metadata.map(m => m.id).sort()).toEqual(["test-conv-0", "test-conv-1", "test-conv-2"]);
    });
    
    it("should search conversations by title", async () => {
        // Save conversations with different titles
        const conv1: Conversation = {
            id: "search-1",
            title: "Authentication System",
            phase: "BUILD",
            history: [],
            agentContexts: new Map(),
            phaseStartedAt: Date.now(),
            metadata: {},
            phaseTransitions: [],
            executionTime: {
                totalSeconds: 0,
                isActive: false,
                lastUpdated: Date.now()
            }
        };
        
        const conv2: Conversation = {
            id: "search-2",
            title: "Payment Processing",
            phase: "PLAN",
            history: [],
            agentContexts: new Map(),
            phaseStartedAt: Date.now(),
            metadata: {},
            phaseTransitions: [],
            executionTime: {
                totalSeconds: 0,
                isActive: false,
                lastUpdated: Date.now()
            }
        };
        
        await adapter.save(conv1);
        await adapter.save(conv2);
        
        // Search for authentication
        const results = await adapter.search({ title: "Authentication" });
        expect(results).toHaveLength(1);
        expect(results[0].id).toBe("search-1");
        expect(results[0].title).toBe("Authentication System");
    });
    
    it("should archive a conversation", async () => {
        const conversationId = "archive-test";
        const conversation: Conversation = {
            id: conversationId,
            title: "To Be Archived",
            phase: "VERIFICATION",
            history: [],
            agentContexts: new Map(),
            phaseStartedAt: Date.now(),
            metadata: {},
            phaseTransitions: [],
            executionTime: {
                totalSeconds: 0,
                isActive: false,
                lastUpdated: Date.now()
            }
        };
        
        // Save and then archive
        await adapter.save(conversation);
        await adapter.archive(conversationId);
        
        // Verify it's marked as archived
        const allList = await adapter.list();
        const archivedEntry = allList.find(m => m.id === conversationId);
        expect(archivedEntry?.archived).toBe(true);
        
        // Verify archive file exists (archived files are in archive/{id}.json)
        const archivePath = path.join(
            projectPath,
            ".tenex",
            "conversations",
            "archive",
            `${conversationId}.json`
        );
        
        const archiveExists = await fs.access(archivePath).then(() => true).catch(() => false);
        expect(archiveExists).toBe(true);
        
        // Verify metadata shows it as archived
        const metadata = await adapter.search({ includeArchived: true });
        const archived = metadata.find(m => m.id === conversationId);
        expect(archived).toBeDefined();
        expect(archived?.archived).toBe(true);
    });
    
    it("should handle concurrent saves correctly", async () => {
        const conversationId = "concurrent-test";
        const baseConversation: Conversation = {
            id: conversationId,
            title: "Concurrent Test",
            phase: "CHAT",
            history: [],
            agentContexts: new Map(),
            phaseStartedAt: Date.now(),
            metadata: {
                continueCallCounts: {
                    CHAT: 0
                }
            },
            phaseTransitions: [],
            executionTime: {
                totalSeconds: 0,
                isActive: false,
                lastUpdated: Date.now()
            }
        };
        
        // Save initial version
        await adapter.save(baseConversation);
        
        // Simulate concurrent updates
        const updatePromises = [];
        for (let i = 0; i < 5; i++) {
            const updated = {
                ...baseConversation,
                metadata: {
                    ...baseConversation.metadata,
                    continueCallCounts: {
                        CHAT: i + 1
                    }
                }
            };
            updatePromises.push(adapter.save(updated));
        }
        
        // Wait for all saves
        await Promise.all(updatePromises);
        
        // Load and verify final state
        const final = await adapter.load(conversationId);
        expect(final).toBeDefined();
        // Should have one of the concurrent values (race condition is expected)
        expect(final?.metadata.continueCallCounts?.CHAT).toBeGreaterThan(0);
        expect(final?.metadata.continueCallCounts?.CHAT).toBeLessThanOrEqual(5);
    });
}, { timeout: 30000 });