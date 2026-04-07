import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConversationCatalogService } from "@/conversations/ConversationCatalogService";
import { IndexingStateManager, EMBEDDING_CONTENT_VERSION } from "../IndexingStateManager";

describe("IndexingStateManager", () => {
    let projectsBasePath: string;

    beforeEach(() => {
        projectsBasePath = mkdtempSync(join(tmpdir(), "tenex-index-state-"));
        ConversationCatalogService.resetAll();
    });

    afterEach(() => {
        ConversationCatalogService.resetAll();
        if (existsSync(projectsBasePath)) {
            rmSync(projectsBasePath, { recursive: true, force: true });
        }
    });

    it("persists indexed state in the conversation catalog and reloads it", () => {
        const projectId = "project-1";
        const conversationId = "conv-1";
        const metadataPath = createConversation(projectsBasePath, projectId, conversationId, {
            title: "Title 1",
            summary: "Summary 1",
            lastUserMessage: "Message 1",
            lastActivity: 1000,
        });

        ConversationCatalogService.getInstance(projectId, metadataPath).reconcile();

        const manager1 = new IndexingStateManager(projectsBasePath);
        expect(manager1.needsIndexing(projectsBasePath, projectId, conversationId)).toBe(true);
        manager1.markIndexed(projectsBasePath, projectId, conversationId);
        manager1.saveNow();

        const manager2 = new IndexingStateManager(projectsBasePath);
        expect(manager2.needsIndexing(projectsBasePath, projectId, conversationId)).toBe(false);
        expect(manager2.getStats().totalEntries).toBe(1);
    });

    it("detects metadata changes after the catalog reconciles external transcript edits", () => {
        const projectId = "project-1";
        const conversationId = "conv-1";
        const metadataPath = createConversation(projectsBasePath, projectId, conversationId, {
            title: "Original title",
            summary: "Original summary",
            lastUserMessage: "Original message",
            lastActivity: 1000,
        });

        const catalog = ConversationCatalogService.getInstance(projectId, metadataPath);
        catalog.reconcile();

        const manager = new IndexingStateManager(projectsBasePath);
        manager.markIndexed(projectsBasePath, projectId, conversationId);
        expect(manager.needsIndexing(projectsBasePath, projectId, conversationId)).toBe(false);

        updateConversation(projectsBasePath, projectId, conversationId, {
            title: "Updated title",
            summary: "Updated summary",
            lastUserMessage: "Original message",
            lastActivity: 1000,
        });
        catalog.reconcile();

        expect(manager.needsIndexing(projectsBasePath, projectId, conversationId)).toBe(true);
    });

    it("re-checks no-content conversations when activity advances", () => {
        const projectId = "project-1";
        const conversationId = "conv-1";
        const metadataPath = createConversation(projectsBasePath, projectId, conversationId, {
            title: undefined,
            summary: undefined,
            lastUserMessage: undefined,
            lastActivity: 1000,
        });

        const catalog = ConversationCatalogService.getInstance(projectId, metadataPath);
        catalog.reconcile();

        const manager = new IndexingStateManager(projectsBasePath);
        expect(manager.needsIndexing(projectsBasePath, projectId, conversationId)).toBe(true);

        manager.markIndexed(projectsBasePath, projectId, conversationId, true);
        expect(manager.needsIndexing(projectsBasePath, projectId, conversationId)).toBe(false);

        updateConversation(projectsBasePath, projectId, conversationId, {
            title: undefined,
            summary: undefined,
            lastUserMessage: undefined,
            lastActivity: 2000,
        });
        catalog.reconcile();

        expect(manager.needsIndexing(projectsBasePath, projectId, conversationId)).toBe(true);
    });

    it("clears individual and global indexing state", () => {
        const metadataPath1 = createConversation(projectsBasePath, "project-1", "conv-1", {
            title: "Title 1",
            summary: "Summary 1",
            lastUserMessage: "Message 1",
            lastActivity: 1000,
        });
        const metadataPath2 = createConversation(projectsBasePath, "project-2", "conv-2", {
            title: "Title 2",
            summary: "Summary 2",
            lastUserMessage: "Message 2",
            lastActivity: 2000,
        });

        ConversationCatalogService.getInstance("project-1", metadataPath1).reconcile();
        ConversationCatalogService.getInstance("project-2", metadataPath2).reconcile();

        const manager = new IndexingStateManager(projectsBasePath);
        manager.markIndexed(projectsBasePath, "project-1", "conv-1");
        manager.markIndexed(projectsBasePath, "project-2", "conv-2");
        expect(manager.getStats().totalEntries).toBe(2);

        manager.clearState("project-1", "conv-1");
        expect(manager.getStats().totalEntries).toBe(1);

        manager.clearAllState();
        expect(manager.getStats().totalEntries).toBe(0);
    });
    it("version bump triggers re-indexing regardless of metadata hash match", () => {
        const projectId = "project-1";
        const conversationId = "conv-1";
        const metadataPath = createConversation(projectsBasePath, projectId, conversationId, {
            title: "Title",
            summary: "Summary",
            lastUserMessage: "Message",
            lastActivity: 1000,
        });

        const catalog = ConversationCatalogService.getInstance(projectId, metadataPath);
        catalog.reconcile();

        const manager = new IndexingStateManager(projectsBasePath);
        manager.markIndexed(projectsBasePath, projectId, conversationId);
        expect(manager.needsIndexing(projectsBasePath, projectId, conversationId)).toBe(false);

        // Simulate a stale content_version by writing state with an old version
        catalog.setEmbeddingState(conversationId, {
            metadataHash: (catalog.getEmbeddingState(conversationId) as { metadataHash: string }).metadataHash,
            lastIndexedAt: Date.now(),
            noContent: false,
            contentVersion: "v1", // old version — should trigger re-index
        });

        expect(manager.needsIndexing(projectsBasePath, projectId, conversationId)).toBe(true);
    });

    it("EMBEDDING_CONTENT_VERSION constant has expected value", () => {
        expect(EMBEDDING_CONTENT_VERSION).toBe("v2");
    });
});

function createConversation(
    projectsBasePath: string,
    projectId: string,
    conversationId: string,
    metadata: {
        title?: string;
        summary?: string;
        lastUserMessage?: string;
        lastActivity: number;
    }
): string {
    const metadataPath = join(projectsBasePath, projectId);
    mkdirSync(join(metadataPath, "conversations"), { recursive: true });
    writeConversationFile(join(metadataPath, "conversations", `${conversationId}.json`), metadata);
    return metadataPath;
}

function updateConversation(
    projectsBasePath: string,
    projectId: string,
    conversationId: string,
    metadata: {
        title?: string;
        summary?: string;
        lastUserMessage?: string;
        lastActivity: number;
    }
): void {
    writeConversationFile(
        join(projectsBasePath, projectId, "conversations", `${conversationId}.json`),
        metadata
    );
}

function writeConversationFile(filePath: string, metadata: {
    title?: string;
    summary?: string;
    lastUserMessage?: string;
    lastActivity: number;
}): void {
    writeFileSync(filePath, JSON.stringify({
        activeRal: {},
        nextRalNumber: {},
        injections: [],
        messages: [
            {
                pubkey: "user-pubkey",
                content: "hello",
                messageType: "text",
                timestamp: metadata.lastActivity,
            },
        ],
        metadata: {
            ...(metadata.title ? { title: metadata.title } : {}),
            ...(metadata.summary ? { summary: metadata.summary } : {}),
            ...(metadata.lastUserMessage ? { lastUserMessage: metadata.lastUserMessage } : {}),
        },
        agentTodos: {},
        todoNudgedAgents: [],
        blockedAgents: [],
        executionTime: { totalSeconds: 0, isActive: false, lastUpdated: Date.now() },
    }, null, 2));
}
