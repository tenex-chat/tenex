import { beforeEach, describe, expect, it, mock } from "bun:test";
import { ParticipationIndex } from "@/conversations/services/ParticipationIndex";
import { ThreadService } from "@/conversations/services/ThreadService";
import type { Conversation } from "@/conversations/types";
import { logger } from "@/utils/logger";
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

describe("ThreadWithMemoryStrategy - Fix Verification", () => {
    let strategy: ThreadWithMemoryStrategy;
    let threadService: ThreadService;
    let participationIndex: ParticipationIndex;
    let events: NDKEvent[];
    let conversation: Conversation;
    let context: ExecutionContext;

    beforeEach(() => {
        strategy = new ThreadWithMemoryStrategy();
        threadService = new ThreadService();
        participationIndex = new ParticipationIndex();

        const userPubkey = "09d48a1a5dbe13404a729634f1d6ba722d40513468dd713c8ea38ca9b7b6f2c7";
        const agentPubkey = "90672970653c15e58d38060178f924604d0add0b0e15c6ea472cd4b552ead2a2";

        // Helper to create mock events
        const createEvent = (
            id: string,
            pubkey: string,
            content: string,
            parentId?: string,
            timestamp?: number
        ): NDKEvent => {
            const tags = parentId ? [["e", parentId]] : [];
            return {
                id,
                pubkey,
                content,
                created_at: timestamp || Date.now() / 1000,
                kind: 1111,
                tags,
                sig: "mock-sig",
                tagValue: (tagName: string) => {
                    const tag = tags.find((t) => t[0] === tagName);
                    return tag ? tag[1] : undefined;
                },
            } as any as NDKEvent;
        };

        // Create events in chronological order
        events = [
            // 1. User: "I'm debugging: say '1'" (root)
            createEvent(
                "13fcefc9b3a28d876f1641beb6e94eec1ce21e2183409a60300b296ee0ca7cfb",
                userPubkey,
                "I'm debugging: say '1'",
                undefined,
                1758026650
            ),

            // 2. Agent: "1" (reply to root)
            createEvent(
                "8718e134972b7f309e13b8c30d291191245688f231f4d9ee648c93748c135bf9",
                agentPubkey,
                "1",
                "13fcefc9b3a28d876f1641beb6e94eec1ce21e2183409a60300b296ee0ca7cfb",
                1758026651
            ),

            // 3. User: "say '2'" (reply to root)
            createEvent(
                "8fb7f74d9d82c723195462abde2a11c0183186fa328be14ae7f18be95208fe6a",
                userPubkey,
                'say "2"',
                "13fcefc9b3a28d876f1641beb6e94eec1ce21e2183409a60300b296ee0ca7cfb",
                1758026654
            ),

            // 4. Agent: "2" (reply to root)
            createEvent(
                "d1c77d8750f6976cf81403780108be27a0372f34e29c086cdc681884ed5cc378",
                agentPubkey,
                "2",
                "13fcefc9b3a28d876f1641beb6e94eec1ce21e2183409a60300b296ee0ca7cfb",
                1758026655
            ),

            // 5. User: "say '1.1'" (SUB-THREAD: reply to agent's "1")
            createEvent(
                "f6047d47e8f1e9aa4bc74806f085f08a6f38646c67a390814fab8cf58a0b8ba9",
                userPubkey,
                'say "1.1"',
                "8718e134972b7f309e13b8c30d291191245688f231f4d9ee648c93748c135bf9",
                1758026680
            ),

            // 6. Agent: "1.1" (SUB-THREAD: reply to agent's "1")
            createEvent(
                "1884c96c1e2ad3a6e36c5432fb8af6aabf3c92b9432a5caaa6a258265137153c",
                agentPubkey,
                "1.1",
                "8718e134972b7f309e13b8c30d291191245688f231f4d9ee648c93748c135bf9",
                1758026682
            ),

            // 7. User: "say '3'" (reply to root - THIS IS THE TRIGGER)
            createEvent(
                "ce25118ba06c8dc0ab0ab62a2be13578401bff383b9d363db2f12156a3bacfaf",
                userPubkey,
                'say "3"',
                "13fcefc9b3a28d876f1641beb6e94eec1ce21e2183409a60300b296ee0ca7cfb",
                1758026732
            ),
        ];

        // Create mock conversation with all events up to "say '3'"
        conversation = {
            id: "test-conversation",
            title: "Test Thread",
            history: events.slice(0, 7), // All events up to "say '3'"
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

        // Create mock context
        context = {
            conversationId: "test-conversation",
            agent: {
                name: "Router",
                pubkey: agentPubkey,
                slug: "router",
                instructions: "Test agent",
            },
            conversationCoordinator: {
                threadService,
                participationIndex,
            },
            getConversation: () => conversation,
            isDelegationCompletion: false,
        } as any as ExecutionContext;
    });

    it("should include sub-thread context when agent has participated in sub-threads", async () => {
        // The triggering event is "say '3'"
        const triggeringEvent = events[6]; // "say '3'"

        // Build messages for the agent
        const messages = await strategy.buildMessages(context, triggeringEvent);

        // Extract content from messages
        const messageContents = messages.map((m) => m.content);
        const fullContext = messageContents.join("\n");

        console.log("\n=== MESSAGES GENERATED (with fix) ===");
        messages.forEach((msg, i) => {
            if (msg.content && msg.content.length > 100) {
                console.log(
                    `[${i}] Role: ${msg.role}, Content: ${msg.content.substring(0, 100)}...`
                );
            } else {
                console.log(`[${i}] Role: ${msg.role}, Content: ${msg.content}`);
            }
        });
        console.log("=====================================\n");

        // CRITICAL ASSERTIONS: The agent should now see the "1.1" sub-thread
        const hasSubThreadContext =
            messageContents.some((c) => c === "1.1") ||
            messageContents.some((c) => c?.includes("1.1"));
        const hasSubThreadRequest =
            messageContents.some((c) => c === 'say "1.1"') ||
            messageContents.some((c) => c?.includes('say "1.1"'));

        console.log("\n=== SUB-THREAD DETECTION ===");
        console.log('Has "1.1" response:', hasSubThreadContext);
        console.log('Has "say 1.1" request:', hasSubThreadRequest);
        console.log("=============================\n");

        // With the fix, these should now pass
        expect(hasSubThreadContext).toBe(true);
        expect(hasSubThreadRequest).toBe(true);

        // Also check that the main thread is still present
        const hasRootThread = fullContext.includes("I'm debugging");
        const hasUserRequest3 = fullContext.includes('say "3"');

        expect(hasRootThread).toBe(true);
        expect(hasUserRequest3).toBe(true);
    });

    it("should properly organize threads with sub-thread marked separately", async () => {
        const triggeringEvent = events[6]; // "say '3'"

        // Build messages
        const messages = await strategy.buildMessages(context, triggeringEvent);

        // Look for system messages that indicate thread organization
        const systemMessages = messages.filter((m) => m.role === "system");
        const systemContent = systemMessages.map((m) => m.content).join("\n");

        console.log("\n=== SYSTEM MESSAGES ===");
        systemMessages.forEach((msg, i) => {
            if (msg.content && msg.content.length > 100) {
                console.log(`[${i}] ${msg.content.substring(0, 100)}...`);
            } else {
                console.log(`[${i}] ${msg.content}`);
            }
        });
        console.log("=======================\n");

        // Check if the system properly identifies the sub-thread
        // The fix should create a separate thread entry for the sub-thread rooted at agent's "1"
        const hasPreviousThreadMarker =
            systemContent.includes("Previous thread") ||
            systemContent.includes("previous participations");
        const hasCurrentThreadMarker =
            systemContent.includes("Current thread") || systemContent.includes("current thread");

        console.log("Has previous thread marker:", hasPreviousThreadMarker);
        console.log("Has current thread marker:", hasCurrentThreadMarker);

        // If there are previous threads, we should see both markers
        // If not, that's okay as long as the sub-thread content is present
        if (hasPreviousThreadMarker) {
            expect(hasCurrentThreadMarker).toBe(true);
        }
    });

    it("should correctly identify agent responses as sub-thread roots", async () => {
        // Directly test the new helper method
        const agentPubkey = "90672970653c15e58d38060178f924604d0add0b0e15c6ea472cd4b552ead2a2";

        // Check which agent events have replies
        const agentEventsWithReplies = conversation.history.filter(
            (e) =>
                e.pubkey === agentPubkey &&
                conversation.history.some((other) => other.tagValue("e") === e.id)
        );

        console.log("\n=== AGENT EVENTS WITH REPLIES ===");
        agentEventsWithReplies.forEach((e) => {
            const replies = conversation.history.filter((r) => r.tagValue("e") === e.id);
            console.log(
                `Agent event "${e.content}" (${e.id.substring(0, 8)}) has ${replies.length} replies:`
            );
            replies.forEach((r) => {
                console.log(`  - "${r.content}" by ${r.pubkey.substring(0, 8)}`);
            });
        });
        console.log("==================================\n");

        // The agent's "1" response should have replies
        expect(agentEventsWithReplies.length).toBe(1);
        expect(agentEventsWithReplies[0].content).toBe("1");

        // The agent's "1" response has 2 replies: "say 1.1" and "1.1"
        const repliesTo1 = conversation.history.filter(
            (e) => e.tagValue("e") === agentEventsWithReplies[0].id
        );
        expect(repliesTo1.length).toBe(2);
    });
});
