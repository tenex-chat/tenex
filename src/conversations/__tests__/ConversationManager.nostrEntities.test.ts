import { describe, it, expect, beforeEach, mock } from "bun:test";
import { ConversationManager } from "../ConversationManager";
import { FileSystemAdapter } from "../persistence";
import { getNDK } from "@/nostr";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import type { Agent } from "@/agents/types";
import { PHASES } from "@/conversations/phases";
import { getProjectContext } from "@/services";

// Mock dependencies
mock.module("@/nostr", () => ({
    getNDK: mock(() => ({}))
}));

mock.module("@/services", () => ({
    getProjectContext: mock(() => ({}))
}));

mock.module("../persistence", () => ({
    FileSystemAdapter: mock(() => ({}))
}));

describe("ConversationManager - Nostr Entity Processing", () => {
    let conversationManager: ConversationManager;
    let mockNDK: any;
    let mockProjectContext: any;
    let mockFetchEvent: any;
    let mockInitialize: any;
    let mockSave: any;
    let mockList: any;

    beforeEach(() => {
        // Setup mock NDK
        mockFetchEvent = mock(() => Promise.resolve(null));
        mockNDK = {
            fetchEvent: mockFetchEvent
        };
        const mockGetNDK = getNDK as any;
        mockGetNDK.mockReturnValue(mockNDK);

        // Setup mock project context
        mockProjectContext = {
            agents: new Map<string, Agent>([
                ["test-agent", {
                    pubkey: "test-agent-pubkey",
                    slug: "test-agent",
                    name: "Test Agent",
                    isOrchestrator: false,
                    tools: [],
                    phase: PHASES.CHAT
                } as Agent]
            ])
        };
        const mockGetProjectContext = getProjectContext as any;
        mockGetProjectContext.mockReturnValue(mockProjectContext);

        // Setup mock persistence
        mockInitialize = mock(() => Promise.resolve(undefined));
        mockSave = mock(() => Promise.resolve(undefined));
        mockList = mock(() => Promise.resolve([]));
        const mockPersistence = {
            initialize: mockInitialize,
            save: mockSave,
            list: mockList
        };
        const MockFileSystemAdapter = FileSystemAdapter as any;
        MockFileSystemAdapter.mockImplementation(() => mockPersistence);

        conversationManager = new ConversationManager("/test/path");
    });

    describe("processNostrEntities", () => {
        it("should process nevent entities and inline their content", async () => {
            // Setup mock event
            const mockFetchedEvent = {
                content: "This is the content of the referenced event",
                kind: 1
            };
            mockFetchEvent.mockResolvedValue(mockFetchedEvent);

            // Create a conversation
            const triggeringEvent = new NDKEvent();
            triggeringEvent.id = "conv-id";
            triggeringEvent.pubkey = "user-pubkey";
            triggeringEvent.content = "Check out this event: nostr:nevent1234567890abcdef";
            triggeringEvent.tags = [];

            await conversationManager.initialize();
            const conversation = await conversationManager.createConversation(triggeringEvent);

            // Build messages for an agent
            const testAgent: Agent = {
                pubkey: "test-agent-pubkey",
                slug: "test-agent",
                name: "Test Agent",
                isOrchestrator: false,
                tools: [],
                phase: PHASES.CHAT
            };

            const { messages } = await conversationManager.buildAgentMessages(
                conversation.id,
                testAgent,
                triggeringEvent
            );

            // Verify the nostr entity was processed
            const userMessage = messages.find(m => m.role === "user");
            expect(userMessage?.content).toContain('<nostr-event entity="nostr:nevent1234567890abcdef">This is the content of the referenced event</nostr-event>');
            expect(mockFetchEvent).toHaveBeenCalledWith("nostr:nevent1234567890abcdef");
        });

        it("should handle multiple nostr entities in a single message", async () => {
            // Setup mock events
            mockFetchEvent
                .mockResolvedValueOnce({ content: "First event content", kind: 1 })
                .mockResolvedValueOnce({ content: "Second event content", kind: 1 });

            // Create a conversation
            const triggeringEvent = new NDKEvent();
            triggeringEvent.id = "conv-id";
            triggeringEvent.pubkey = "user-pubkey";
            triggeringEvent.content = "Check these: nostr:nevent1111 and nostr:naddr2222";
            triggeringEvent.tags = [];

            await conversationManager.initialize();
            const conversation = await conversationManager.createConversation(triggeringEvent);

            // Build messages for an agent
            const testAgent: Agent = {
                pubkey: "test-agent-pubkey",
                slug: "test-agent",
                name: "Test Agent",
                isOrchestrator: false,
                tools: [],
                phase: PHASES.CHAT
            };

            const { messages } = await conversationManager.buildAgentMessages(
                conversation.id,
                testAgent,
                triggeringEvent
            );

            // Verify both entities were processed
            const userMessage = messages.find(m => m.role === "user");
            expect(userMessage?.content).toContain('<nostr-event entity="nostr:nevent1111">First event content</nostr-event>');
            expect(userMessage?.content).toContain('<nostr-event entity="nostr:naddr2222">Second event content</nostr-event>');
            expect(mockFetchEvent).toHaveBeenCalledTimes(2);
        });

        it("should handle when nostr entity cannot be fetched", async () => {
            // Setup mock to return null
            mockFetchEvent.mockResolvedValue(null);

            // Create a conversation
            const triggeringEvent = new NDKEvent();
            triggeringEvent.id = "conv-id";
            triggeringEvent.pubkey = "user-pubkey";
            triggeringEvent.content = "Check this: nostr:nevent1234567890abcdef";
            triggeringEvent.tags = [];

            await conversationManager.initialize();
            const conversation = await conversationManager.createConversation(triggeringEvent);

            // Build messages for an agent
            const testAgent: Agent = {
                pubkey: "test-agent-pubkey",
                slug: "test-agent",
                name: "Test Agent",
                isOrchestrator: false,
                tools: [],
                phase: PHASES.CHAT
            };

            const { messages } = await conversationManager.buildAgentMessages(
                conversation.id,
                testAgent,
                triggeringEvent
            );

            // Verify the entity remains unchanged when fetch fails
            const userMessage = messages.find(m => m.role === "user");
            expect(userMessage?.content).toBe("Check this: nostr:nevent1234567890abcdef");
            expect(mockFetchEvent).toHaveBeenCalledWith("nostr:nevent1234567890abcdef");
        });

        it("should leave messages without nostr entities unchanged", async () => {
            // Create a conversation
            const triggeringEvent = new NDKEvent();
            triggeringEvent.id = "conv-id";
            triggeringEvent.pubkey = "user-pubkey";
            triggeringEvent.content = "This is a regular message without any nostr entities";
            triggeringEvent.tags = [];

            await conversationManager.initialize();
            const conversation = await conversationManager.createConversation(triggeringEvent);

            // Build messages for an agent
            const testAgent: Agent = {
                pubkey: "test-agent-pubkey",
                slug: "test-agent",
                name: "Test Agent",
                isOrchestrator: false,
                tools: [],
                phase: PHASES.CHAT
            };

            const { messages } = await conversationManager.buildAgentMessages(
                conversation.id,
                testAgent,
                triggeringEvent
            );

            // Verify the message is unchanged
            const userMessage = messages.find(m => m.role === "user");
            expect(userMessage?.content).toBe("This is a regular message without any nostr entities");
            expect(mockFetchEvent).not.toHaveBeenCalled();
        });
    });
});