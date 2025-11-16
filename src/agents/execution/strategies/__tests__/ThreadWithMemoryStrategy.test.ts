import { beforeEach, describe, expect, it, mock } from "bun:test";
import { ParticipationIndex } from "@/conversations/services/ParticipationIndex";
import { ThreadService } from "@/conversations/services/ThreadService";
import type { Conversation } from "@/conversations/types";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { ExecutionContext } from "../../types";
import { ThreadWithMemoryStrategy } from "../ThreadWithMemoryStrategy";

// Note: For this test we'll work with the real strategy but simplified context
// since mocking is complex in Bun and we want to test the actual logic

describe("ThreadWithMemoryStrategy", () => {
    let strategy: ThreadWithMemoryStrategy;
    let threadService: ThreadService;
    let participationIndex: ParticipationIndex;

    beforeEach(() => {
        strategy = new ThreadWithMemoryStrategy();
        threadService = new ThreadService();
        participationIndex = new ParticipationIndex();
    });

    // Helper to create mock events
    const createMockEvent = (
        id: string,
        pubkey: string,
        parentId?: string,
        content?: string
    ): NDKEvent => {
        const tags = parentId ? [["e", parentId]] : [];
        return {
            id,
            pubkey,
            created_at: Date.now() / 1000,
            kind: 1,
            tags,
            content: content || `Message ${id}`,
            sig: "mock-sig",
            tagValue: (tagName: string) => {
                const tag = tags.find((t) => t[0] === tagName);
                return tag ? tag[1] : undefined;
            },
        } as any as NDKEvent;
    };

    describe("Example scenario from discussion", () => {
        it("should build correct message context for Agent 2 responding to 4.2", async () => {
            const userPubkey = "user";
            const agent1Pubkey = "agent1";
            const agent2Pubkey = "agent2";
            const agent3Pubkey = "agent3";
            const agent4Pubkey = "agent4";
            const agent5Pubkey = "agent5";
            const agent6Pubkey = "agent6";

            // Build the conversation history with two separate root threads
            const events: NDKEvent[] = [
                // First root thread where Agent 2 participates
                createMockEvent("root1", userPubkey, undefined, "User: first topic"),
                createMockEvent("reply1", agent1Pubkey, "root1", "Agent 1: responding to first"),
                createMockEvent(
                    "reply2",
                    agent2Pubkey,
                    "root1",
                    "Agent 2: also responding to first"
                ),
                createMockEvent("followup1", userPubkey, "reply2", "User: followup to Agent 2"),

                // Second root thread where Agent 2 also participates
                createMockEvent("root2", userPubkey, undefined, "User: second topic"),
                createMockEvent("reply3", agent6Pubkey, "root2", "Agent 6: responding to second"),
                createMockEvent(
                    "reply4",
                    userPubkey,
                    "reply3",
                    "User: asking about implementation"
                ),
                createMockEvent("reply5", agent2Pubkey, "reply3", "Agent 2: I can help with that"),
            ];

            // Build participation index
            participationIndex.buildIndex("conv1", events);

            // Create mock conversation
            const conversation: Conversation = {
                id: "conv1",
                history: events,
                title: "Test conversation",
                createdAt: Date.now(),
                agentStates: new Map(),
            };

            // Create mock context for Agent 2 responding to 4.2
            const context: ExecutionContext = {
                conversationId: "conv1",
                agent: {
                    name: "Agent 2",
                    pubkey: agent2Pubkey,
                    slug: "agent2",
                    instructions: "Test agent",
                    tools: [],
                } as any,
                triggeringEvent: events.find((e) => e.id === "reply5")!,
                conversationCoordinator: {
                    threadService,
                    participationIndex,
                    getConversation: () => conversation,
                } as any,
                isDelegationCompletion: false,
            };

            // Build messages
            const messages = await strategy.buildMessages(context, context.triggeringEvent);

            // Verify structure
            const messageContents = messages.map((m) => m.content);

            // Debug output
            console.log("Messages generated for Agent 2:");
            messages.forEach((m, i) => {
                console.log(`[${i}] Role: ${m.role}, Content: ${m.content.substring(0, 100)}...`);
            });

            // Should have system prompt
            expect(messageContents[0]).toContain("Agent 2");

            // Debug: log messages to see what's actually generated
            console.log(
                "Generated messages:",
                messages
                    .map(
                        (m, i) =>
                            `[${i}] Role: ${m.role}, Content: ${m.content?.substring(0, 100)}...`
                    )
                    .join("\n")
            );

            // Should have memory from first thread (root1)
            const previousThreadIndex = messageContents.findIndex(
                (c) =>
                    c.includes("You were active in these other related subthreads") ||
                    c.includes("[Previous thread") ||
                    c.includes("previous participation")
            );
            expect(previousThreadIndex).toBeGreaterThan(-1);

            // Should show full context of first thread where Agent 2 participated
            const previousThreadMessages = messageContents.slice(previousThreadIndex + 1);
            expect(previousThreadMessages.some((m) => m.includes("User: first topic"))).toBe(true);
            expect(
                previousThreadMessages.some((m) => m.includes("Agent 1: responding to first"))
            ).toBe(true);
            expect(
                previousThreadMessages.some((m) => m.includes("Agent 2: also responding to first"))
            ).toBe(true);
            // Note: followup1 may not appear as it's after Agent 2's message in that thread

            // Should have current thread marker
            const currentThreadIndex = messageContents.findIndex((c) =>
                c.includes("Current thread")
            );
            expect(currentThreadIndex).toBeGreaterThan(previousThreadIndex);

            // Should have full current thread (root2 -> reply3 -> reply5)
            const currentThreadMessages = messageContents.slice(currentThreadIndex + 1);
            expect(currentThreadMessages.some((m) => m.includes("User: second topic"))).toBe(true);
            expect(
                currentThreadMessages.some((m) => m.includes("Agent 6: responding to second"))
            ).toBe(true);
            expect(
                currentThreadMessages.some((m) => m.includes("Agent 2: I can help with that"))
            ).toBe(true);

            // Should NOT include thread 3.x since Agent 2 wasn't there
            expect(messageContents.some((m) => m.includes("Agent 3: 3"))).toBe(false);
            expect(messageContents.some((m) => m.includes("Agent 4: 3.2"))).toBe(false);
        });

        it.skip("should build correct message context for Agent 4 responding to 3.2.2", async () => {
            const userPubkey = "user";
            const agent1Pubkey = "agent1";
            const agent3Pubkey = "agent3";
            const agent4Pubkey = "agent4";

            // Simplified history for Agent 4's case
            const events: NDKEvent[] = [
                createMockEvent("1", userPubkey, undefined, "User: 1"),
                createMockEvent("2", agent1Pubkey, "1", "Agent 1: 2"),
                createMockEvent("3", agent3Pubkey, "1", "Agent 3: 3"),
                createMockEvent("3.1", userPubkey, "3", "User: 3.1"),
                createMockEvent("3.2", agent4Pubkey, "3", "Agent 4: 3.2"),
                createMockEvent("3.2.1", userPubkey, "3.2", "User: 3.2.1"),
                createMockEvent("3.2.2", agent4Pubkey, "3.2", "Agent 4: 3.2.2"),
            ];

            participationIndex.buildIndex("conv1", events);

            const conversation: Conversation = {
                id: "conv1",
                history: events,
                title: "Test conversation",
                createdAt: Date.now(),
                agentStates: new Map(),
            };

            const context: ExecutionContext = {
                conversationId: "conv1",
                agent: {
                    name: "Agent 4",
                    pubkey: agent4Pubkey,
                    slug: "agent4",
                    instructions: "Test agent",
                    tools: [],
                } as any,
                triggeringEvent: events.find((e) => e.id === "3.2.2")!,
                conversationCoordinator: {
                    threadService,
                    participationIndex,
                    getConversation: () => conversation,
                } as any,
                isDelegationCompletion: false,
            };

            const messages = await strategy.buildMessages(context, context.triggeringEvent);

            const messageContents = messages.map((m) => m.content);

            // Should have current thread only (no other participations)
            const currentThreadIndex = messageContents.findIndex((c) =>
                c.includes("Current thread")
            );
            expect(currentThreadIndex).toBeGreaterThan(-1);

            // Should NOT have previous participations section
            const prevParticipationIndex = messageContents.findIndex((c) =>
                c.includes("previous participation")
            );
            expect(prevParticipationIndex).toBe(-1);

            // Current thread should be: 1 -> 2 -> 3 -> 3.1 -> 3.2 -> 3.2.1 -> 3.2.2
            const currentThreadMessages = messageContents.slice(currentThreadIndex + 1);
            expect(currentThreadMessages.some((m) => m.includes("User: 1"))).toBe(true);
            expect(currentThreadMessages.some((m) => m.includes("Agent 1: 2"))).toBe(true);
            expect(currentThreadMessages.some((m) => m.includes("Agent 3: 3"))).toBe(true);
            expect(currentThreadMessages.some((m) => m.includes("User: 3.1"))).toBe(true);
            expect(currentThreadMessages.some((m) => m.includes("Agent 4: 3.2"))).toBe(true);
            expect(currentThreadMessages.some((m) => m.includes("User: 3.2.1"))).toBe(true);
            expect(currentThreadMessages.some((m) => m.includes("Agent 4: 3.2.2"))).toBe(true);
        });
    });
});
