import { beforeEach, describe, expect, it, mock } from "bun:test";
import { ParticipationIndex } from "@/conversations/services/ParticipationIndex";
import { ThreadService } from "@/conversations/services/ThreadService";
import type { Conversation } from "@/conversations/types";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { ExecutionContext } from "../../types";
import { ThreadWithMemoryStrategy } from "../ThreadWithMemoryStrategy";

import "./test-mocks"; // Import shared mocks
// Mock dependencies
mock.module("@/conversations/persistence/ToolMessageStorage", () => ({
    toolMessageStorage: {
        load: async () => null,
    },
}));

mock.module("@/conversations/processors/NostrEntityProcessor", () => ({
    NostrEntityProcessor: {
        extractEntities: () => [],
    },
}));

mock.module("@/conversations/processors/EventToModelMessage", () => ({
    EventToModelMessage: {
        transform: async (event: NDKEvent, content: string, agentPubkey: string) => {
            return {
                role: event.pubkey === agentPubkey ? "assistant" : "user",
                content: content,
            };
        },
    },
}));

mock.module("@/services", () => ({
    getProjectContext: () => null,
    isProjectContextInitialized: () => false,
}));

mock.module("@/prompts/utils/systemPromptBuilder", () => ({
    buildSystemPromptMessages: () => [],
}));

mock.module("@/prompts/core/PromptBuilder", () => ({
    PromptBuilder: class {
        add() {
            return this;
        }
        build() {
            return "";
        }
    },
}));

mock.module("@/prompts/fragments/debug-mode", () => ({
    isDebugMode: () => false,
}));

mock.module("@/prompts/fragments/20-voice-mode", () => ({
    isVoiceMode: () => false,
}));

mock.module("@/services/PubkeyNameRepository", () => ({
    getPubkeyNameRepository: () => ({
        getName: async (pubkey: string) => `User ${pubkey.substring(0, 8)}`,
    }),
}));

mock.module("@/nostr", () => ({
    getNDK: () => ({
        fetchEvent: async () => null,
    }),
}));

describe("ThreadWithMemoryStrategy - Triggering Event Marker", () => {
    let strategy: ThreadWithMemoryStrategy;
    let threadService: ThreadService;
    let participationIndex: ParticipationIndex;

    beforeEach(() => {
        strategy = new ThreadWithMemoryStrategy();
        threadService = new ThreadService();
        participationIndex = new ParticipationIndex();
    });

    it("should add a clear marker before the triggering event", async () => {
        const userPubkey = "user123";
        const agentPubkey = "agent456";

        // Helper to create mock events
        const createEvent = (
            id: string,
            pubkey: string,
            content: string,
            parentId?: string
        ): NDKEvent => {
            const tags = parentId ? [["e", parentId]] : [];
            return {
                id,
                pubkey,
                content,
                created_at: Date.now() / 1000,
                kind: 1111,
                tags,
                sig: "mock-sig",
                tagValue: (tagName: string) => {
                    const tag = tags.find((t) => t[0] === tagName);
                    return tag ? tag[1] : undefined;
                },
            } as any as NDKEvent;
        };

        // Create a simple conversation
        const events = [
            createEvent("root", userPubkey, "Hello agent"),
            createEvent("reply1", agentPubkey, "Hello user", "root"),
            createEvent("reply2", userPubkey, "How are you?", "root"),
            createEvent("reply3", agentPubkey, "I am doing well", "root"),
            createEvent("trigger", userPubkey, "What can you help with?", "root"), // This is the triggering event
        ];

        const conversation: Conversation = {
            id: "test-conv",
            title: "Test",
            history: events,
            agentStates: new Map(),
            metadata: {},
            executionTime: {
                totalSeconds: 0,
                isActive: false,
                lastUpdated: Date.now(),
            },
        };

        // Build participation index
        participationIndex.buildIndex(conversation.id, conversation.history);

        const context: ExecutionContext = {
            conversationId: "test-conv",
            agent: {
                name: "TestAgent",
                pubkey: agentPubkey,
                slug: "test-agent",
                instructions: "Test agent",
            },
            conversationCoordinator: {
                threadService,
                participationIndex,
                getConversation: () => conversation,
            },
            isDelegationCompletion: false,
        } as any as ExecutionContext;

        // The triggering event is the last user message
        const triggeringEvent = events[4];

        // Build messages
        const messages = await strategy.buildMessages(context, triggeringEvent);

        // Find the marker message
        const markerIndex = messages.findIndex(
            (m) => m.role === "system" && m.content?.includes("RESPOND TO THE FOLLOWING MESSAGE")
        );

        console.log("\n=== MESSAGES WITH MARKER ===");
        messages.forEach((msg, i) => {
            if (msg.content && msg.content.length > 100) {
                console.log(`[${i}] ${msg.role}: ${msg.content.substring(0, 100)}...`);
            } else {
                console.log(`[${i}] ${msg.role}: ${msg.content}`);
            }
        });
        console.log("=============================\n");

        // Verify the marker exists
        expect(markerIndex).toBeGreaterThan(-1);

        // Verify the marker comes right before the triggering event
        const nextMessage = messages[markerIndex + 1];
        expect(nextMessage.content).toBe("What can you help with?");
        expect(nextMessage.role).toBe("user");

        // Verify the marker is not added for agent's own messages
        const agentMessageIndices = messages
            .map((m, i) => (m.role === "assistant" ? i : -1))
            .filter((i) => i !== -1);

        // Check no marker appears before agent messages
        for (const agentIndex of agentMessageIndices) {
            const prevMessage = messages[agentIndex - 1];
            if (prevMessage?.role === "system") {
                expect(prevMessage.content).not.toContain("RESPOND TO THE FOLLOWING MESSAGE");
            }
        }
    });

    it("should add marker for sub-thread triggering events too", async () => {
        const userPubkey = "user123";
        const agentPubkey = "agent456";

        // Helper to create mock events
        const createEvent = (
            id: string,
            pubkey: string,
            content: string,
            parentId?: string
        ): NDKEvent => {
            const tags = parentId ? [["e", parentId]] : [];
            return {
                id,
                pubkey,
                content,
                created_at: Date.now() / 1000,
                kind: 1111,
                tags,
                sig: "mock-sig",
                tagValue: (tagName: string) => {
                    const tag = tags.find((t) => t[0] === tagName);
                    return tag ? tag[1] : undefined;
                },
            } as any as NDKEvent;
        };

        // Create conversation with sub-thread
        const events = [
            createEvent("root", userPubkey, "Start conversation"),
            createEvent("agent1", agentPubkey, "Response 1", "root"),
            createEvent("subthread", userPubkey, "Reply to your response", "agent1"), // Sub-thread trigger
        ];

        const conversation: Conversation = {
            id: "test-conv",
            title: "Test",
            history: events,
            agentStates: new Map(),
            metadata: {},
            executionTime: {
                totalSeconds: 0,
                isActive: false,
                lastUpdated: Date.now(),
            },
        };

        // Build participation index
        participationIndex.buildIndex(conversation.id, conversation.history);

        const context: ExecutionContext = {
            conversationId: "test-conv",
            agent: {
                name: "TestAgent",
                pubkey: agentPubkey,
                slug: "test-agent",
                instructions: "Test agent",
            },
            conversationCoordinator: {
                threadService,
                participationIndex,
                getConversation: () => conversation,
            },
            isDelegationCompletion: false,
        } as any as ExecutionContext;

        // The triggering event is the sub-thread message
        const triggeringEvent = events[2];

        // Build messages
        const messages = await strategy.buildMessages(context, triggeringEvent);

        console.log("\n=== SUB-THREAD MESSAGES ===");
        messages.forEach((msg, i) => {
            console.log(`[${i}] ${msg.role}: ${msg.content?.substring(0, 60) || msg.content}`);
        });
        console.log("===========================\n");

        // Find the marker
        const markerIndex = messages.findIndex(
            (m) => m.role === "system" && m.content?.includes("RESPOND TO THE FOLLOWING MESSAGE")
        );

        // Verify marker exists and is followed by the triggering event
        expect(markerIndex).toBeGreaterThan(-1);
        expect(messages[markerIndex + 1].content).toBe("Reply to your response");
    });
});
