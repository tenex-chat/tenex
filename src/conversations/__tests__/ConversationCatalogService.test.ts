import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConversationCatalogService } from "@/conversations/ConversationCatalogService";
import { ConversationStore } from "@/conversations/ConversationStore";

const PROJECT_ID = "catalog-project";
const CONVERSATION_ID = "catalog-conversation";
const AGENT_PUBKEY = "a".repeat(64);
const USER_PUBKEY = "b".repeat(64);

describe("ConversationCatalogService", () => {
    let testBasePath: string;
    let metadataPath: string;

    beforeEach(() => {
        testBasePath = mkdtempSync(join(tmpdir(), "tenex-catalog-"));
        metadataPath = join(testBasePath, PROJECT_ID);
        mkdirSync(join(metadataPath, "conversations"), { recursive: true });

        ConversationStore.reset();
        ConversationCatalogService.resetAll();
        ConversationStore.initialize(metadataPath, [AGENT_PUBKEY]);
    });

    afterEach(() => {
        ConversationCatalogService.resetAll();
        ConversationStore.reset();

        if (existsSync(testBasePath)) {
            rmSync(testBasePath, { recursive: true, force: true });
        }
    });

    it("bootstraps the catalog from existing transcript JSON", () => {
        writeConversationFile(join(metadataPath, "conversations", `${CONVERSATION_ID}.json`), {
            metadata: {
                title: "Bootstrap title",
                summary: "Bootstrap summary",
                lastUserMessage: "Bootstrap user message",
                statusLabel: "active",
                statusCurrentActivity: "Working",
            },
            messages: [
                {
                    pubkey: USER_PUBKEY,
                    content: "hello",
                    messageType: "text",
                    timestamp: 100,
                    senderPrincipal: {
                        id: `nostr:${USER_PUBKEY}`,
                        transport: "nostr",
                        linkedPubkey: USER_PUBKEY,
                        kind: "human",
                    },
                },
                {
                    pubkey: AGENT_PUBKEY,
                    content: "world",
                    messageType: "text",
                    timestamp: 200,
                    senderPrincipal: {
                        id: `nostr:${AGENT_PUBKEY}`,
                        transport: "nostr",
                        linkedPubkey: AGENT_PUBKEY,
                        kind: "agent",
                    },
                },
            ],
        });

        const service = ConversationCatalogService.getInstance(PROJECT_ID, metadataPath, [AGENT_PUBKEY]);
        service.initialize();

        const preview = service.getPreview(CONVERSATION_ID);
        expect(preview).not.toBeNull();
        expect(preview?.title).toBe("Bootstrap title");
        expect(preview?.summary).toBe("Bootstrap summary");
        expect(preview?.lastUserMessage).toBe("Bootstrap user message");
        expect(preview?.messageCount).toBe(2);
        expect(preview?.createdAt).toBe(100);
        expect(preview?.lastActivity).toBe(200);
        expect(service.hasParticipant(CONVERSATION_ID, AGENT_PUBKEY)).toBe(true);
    });

    it("updates catalog rows from ConversationStore.save and reconciles external edits", async () => {
        const store = new ConversationStore(testBasePath);
        store.load(PROJECT_ID, CONVERSATION_ID);
        store.addMessage({
            pubkey: USER_PUBKEY,
            content: "External user",
            messageType: "text",
            timestamp: 100,
            senderPrincipal: {
                id: "telegram:user:42",
                transport: "telegram",
                displayName: "Pablo Telegram",
                username: "pablo",
                linkedPubkey: USER_PUBKEY,
                kind: "human",
            },
        });
        store.addMessage({
            pubkey: AGENT_PUBKEY,
            content: "Agent reply",
            messageType: "text",
            timestamp: 200,
            senderPrincipal: {
                id: `nostr:${AGENT_PUBKEY}`,
                transport: "nostr",
                linkedPubkey: AGENT_PUBKEY,
                kind: "agent",
            },
        });
        store.addDelegationMarker({
            delegationConversationId: "delegation-1",
            recipientPubkey: AGENT_PUBKEY,
            parentConversationId: CONVERSATION_ID,
            initiatedAt: 210,
            status: "pending",
        }, AGENT_PUBKEY);
        store.updateMetadata({
            title: "Saved title",
            summary: "Saved summary",
            lastUserMessage: "Saved user message",
            statusLabel: "working",
            statusCurrentActivity: "Reviewing",
        });

        await store.save();

        const service = ConversationCatalogService.getInstance(PROJECT_ID, metadataPath, [AGENT_PUBKEY]);
        const preview = service.getPreview(CONVERSATION_ID);
        expect(preview?.title).toBe("Saved title");
        expect(preview?.summary).toBe("Saved summary");
        expect(preview?.messageCount).toBe(3);

        const [listedConversation] = service.listConversations({});
        expect(listedConversation.participants.some((participant) =>
            participant.displayName === "Pablo Telegram" && participant.transport === "telegram"
        )).toBe(true);
        expect(listedConversation.participants.some((participant) => participant.isAgent)).toBe(true);
        expect(listedConversation.delegationIds).toEqual(["delegation-1"]);

        writeConversationFile(join(metadataPath, "conversations", `${CONVERSATION_ID}.json`), {
            metadata: {
                title: "Edited title",
                summary: "Edited summary",
                lastUserMessage: "Edited last user message",
            },
            messages: store.getAllMessages(),
        });
        service.reconcile();

        const editedPreview = service.getPreview(CONVERSATION_ID);
        expect(editedPreview?.title).toBe("Edited title");
        expect(editedPreview?.summary).toBe("Edited summary");
        expect(editedPreview?.lastUserMessage).toBe("Edited last user message");
    });

    it("prunes deleted transcripts and cascades embedding state", async () => {
        const store = new ConversationStore(testBasePath);
        store.load(PROJECT_ID, CONVERSATION_ID);
        store.addMessage({
            pubkey: USER_PUBKEY,
            content: "hello",
            messageType: "text",
            timestamp: 100,
        });
        await store.save();

        const service = ConversationCatalogService.getInstance(PROJECT_ID, metadataPath, [AGENT_PUBKEY]);
        service.setEmbeddingState(CONVERSATION_ID, {
            metadataHash: "hash-1",
            lastIndexedAt: Date.now(),
            noContent: false,
        });
        expect(service.getEmbeddingState(CONVERSATION_ID)?.metadataHash).toBe("hash-1");

        unlinkSync(join(metadataPath, "conversations", `${CONVERSATION_ID}.json`));
        service.reconcile();

        expect(service.getPreview(CONVERSATION_ID)).toBeNull();
        expect(service.getEmbeddingState(CONVERSATION_ID)).toBeNull();
        expect(service.listConversations({})).toHaveLength(0);
    });

    it("keeps ConversationStore preview compatibility methods backed by the catalog", async () => {
        const store = new ConversationStore(testBasePath);
        store.load(PROJECT_ID, CONVERSATION_ID);
        store.addMessage({
            pubkey: AGENT_PUBKEY,
            content: "Agent message",
            messageType: "text",
            timestamp: 100,
            senderPrincipal: {
                id: `nostr:${AGENT_PUBKEY}`,
                transport: "nostr",
                linkedPubkey: AGENT_PUBKEY,
                kind: "agent",
            },
        });
        await store.save();

        const preview = ConversationStore.readConversationPreviewForProject(
            CONVERSATION_ID,
            AGENT_PUBKEY,
            PROJECT_ID
        );

        expect(preview).not.toBeNull();
        expect(preview?.agentParticipated).toBe(true);
        expect(preview?.lastActivity).toBe(100);
    });
});

function writeConversationFile(filePath: string, data: {
    metadata?: Record<string, unknown>;
    messages?: unknown[];
}): void {
    writeFileSync(filePath, JSON.stringify({
        activeRal: {},
        nextRalNumber: {},
        injections: [],
        messages: data.messages ?? [],
        metadata: data.metadata ?? {},
        agentTodos: {},
        todoNudgedAgents: [],
        blockedAgents: [],
        executionTime: { totalSeconds: 0, isActive: false, lastUpdated: Date.now() },
    }, null, 2));
}
