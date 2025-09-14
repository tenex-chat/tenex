import { describe, it, expect } from "bun:test";
import { ThreadService } from "@/conversations/services/ThreadService";
import { ParticipationIndex } from "@/conversations/services/ParticipationIndex";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

describe("ThreadWithMemoryStrategy Integration", () => {
    // Helper to create mock events
    const createMockEvent = (
        id: string,
        pubkey: string,
        parentId?: string,
        content?: string
    ): NDKEvent => ({
        id,
        pubkey,
        created_at: Date.now() / 1000,
        kind: 1,
        tags: parentId ? [['e', parentId]] : [],
        content: content || `Message ${id}`,
        sig: 'mock-sig',
    } as NDKEvent);

    describe("Example scenario verification", () => {
        it("should correctly identify threads for Agent 2 at message 4.2", () => {
            const userPubkey = "user";
            const agent1Pubkey = "agent1";
            const agent2Pubkey = "agent2";
            const agent3Pubkey = "agent3";
            const agent6Pubkey = "agent6";

            // Build the conversation history
            // The parent chain represents the actual thread structure
            const events: NDKEvent[] = [
                // Root
                createMockEvent("1", userPubkey, undefined, "User: 1"),

                // First branch (Agent 1's response and its thread)
                createMockEvent("2", agent1Pubkey, "1", "Agent 1: 2"),
                createMockEvent("2.1", userPubkey, "2", "User: 2.1"),
                createMockEvent("2.2", agent2Pubkey, "2.1", "Agent 2: 2.2"),
                createMockEvent("2.3", userPubkey, "2.2", "User: 2.3"),

                // Second branch (Agent 3's response)
                createMockEvent("3", agent3Pubkey, "2", "Agent 3: 3"),

                // Third branch (Agent 6's response and its thread)
                createMockEvent("4", agent6Pubkey, "3", "Agent 6: 4"),
                createMockEvent("4.1", userPubkey, "4", "User: 4.1"),
                createMockEvent("4.2", agent2Pubkey, "4.1", "Agent 2: 4.2"),
            ];

            const threadService = new ThreadService();
            const participationIndex = new ParticipationIndex();

            // Build participation index
            participationIndex.buildIndex("conv1", events);

            // Get current thread for 4.2
            const currentThread = threadService.getThreadToEvent("4.2", events);

            // Verify current thread: 1 -> 2 -> 3 -> 4 -> 4.1 -> 4.2 (direct parent chain)
            expect(currentThread.map(e => e.id)).toEqual(["1", "2", "3", "4", "4.1", "4.2"]);

            // Get Agent 2's participations
            const agent2Participations = participationIndex.getAgentParticipations("conv1", agent2Pubkey);
            expect(agent2Participations).toContain("2.2");
            expect(agent2Participations).toContain("4.2");

            // Get thread for Agent 2's previous participation
            const previousThread = threadService.getThreadToEvent("2.2", events);

            // Verify previous thread: 1 -> 2 -> 2.1 -> 2.2
            expect(previousThread.map(e => e.id)).toEqual(["1", "2", "2.1", "2.2"]);

            // Verify Agent 2 sees both threads
            const agent2ThreadRoots = participationIndex.getAgentThreadRoots(
                "conv1",
                agent2Pubkey,
                events,
                threadService
            );

            // Agent 2 participated in two different threads (rooted at "1")
            expect(agent2ThreadRoots).toContain("1");
        });

        it("should correctly identify threads for Agent 4 at message 3.2.2", () => {
            const userPubkey = "user";
            const agent1Pubkey = "agent1";
            const agent3Pubkey = "agent3";
            const agent4Pubkey = "agent4";

            const events: NDKEvent[] = [
                createMockEvent("1", userPubkey, undefined, "User: 1"),
                createMockEvent("2", agent1Pubkey, "1", "Agent 1: 2"),
                createMockEvent("3", agent3Pubkey, "2", "Agent 3: 3"),
                createMockEvent("3.1", userPubkey, "3", "User: 3.1"),
                createMockEvent("3.2", agent4Pubkey, "3.1", "Agent 4: 3.2"),
                createMockEvent("3.2.1", userPubkey, "3.2", "User: 3.2.1"),
                createMockEvent("3.2.2", agent4Pubkey, "3.2.1", "Agent 4: 3.2.2"),
            ];

            const threadService = new ThreadService();
            const participationIndex = new ParticipationIndex();

            participationIndex.buildIndex("conv1", events);

            // Get current thread for 3.2.2
            const currentThread = threadService.getThreadToEvent("3.2.2", events);

            // Verify thread: 1 -> 2 -> 3 -> 3.1 -> 3.2 -> 3.2.1 -> 3.2.2
            expect(currentThread.map(e => e.id)).toEqual(["1", "2", "3", "3.1", "3.2", "3.2.1", "3.2.2"]);

            // Get Agent 4's participations
            const agent4Participations = participationIndex.getAgentParticipations("conv1", agent4Pubkey);
            expect(agent4Participations).toContain("3.2");
            expect(agent4Participations).toContain("3.2.2");

            // Both participations are in the same thread
            const agent4ThreadRoots = participationIndex.getAgentThreadRoots(
                "conv1",
                agent4Pubkey,
                events,
                threadService
            );

            // Agent 4 only participated in one thread root
            expect(agent4ThreadRoots).toEqual(["1"]);
        });

        it("should correctly build thread when Agent 2 responds to 2.3 after having responded to 4.2", () => {
            const userPubkey = "user";
            const agent1Pubkey = "agent1";
            const agent2Pubkey = "agent2";
            const agent6Pubkey = "agent6";

            const events: NDKEvent[] = [
                createMockEvent("1", userPubkey, undefined, "User: 1"),
                createMockEvent("2", agent1Pubkey, "1", "Agent 1: 2"),
                createMockEvent("2.1", userPubkey, "2", "User: 2.1"),
                createMockEvent("2.2", agent2Pubkey, "2.1", "Agent 2: 2.2"),
                createMockEvent("3", agent6Pubkey, "2", "Agent 6: 4"),
                createMockEvent("4.1", userPubkey, "3", "User: 4.1"),
                createMockEvent("4.2", agent2Pubkey, "4.1", "Agent 2: 4.2"),
                createMockEvent("2.3", userPubkey, "2.2", "User: 2.3"),
            ];

            const threadService = new ThreadService();
            const participationIndex = new ParticipationIndex();

            participationIndex.buildIndex("conv1", events);

            // Get thread for responding to 2.3
            const currentThread = threadService.getThreadToEvent("2.3", events);

            // Should be: 1 -> 2 -> 2.1 -> 2.2 -> 2.3
            expect(currentThread.map(e => e.id)).toEqual(["1", "2", "2.1", "2.2", "2.3"]);

            // Agent 2's participations
            const agent2Events = participationIndex.getAgentParticipations("conv1", agent2Pubkey);
            expect(agent2Events).toContain("2.2"); // Previous in same thread
            expect(agent2Events).toContain("4.2"); // In different thread

            // When building messages for Agent 2 responding to 2.3:
            // - Current thread already includes 2.2 (Agent 2's earlier response)
            // - Should also show thread 4.x participation (4.2) as memory
            const thread4 = threadService.getThreadToEvent("4.2", events);
            expect(thread4.map(e => e.id)).toEqual(["1", "2", "3", "4.1", "4.2"]);

            // So Agent 2 would see:
            // 1. Memory: Thread with 4.2 (1 -> 3 -> 4.1 -> 4.2)
            // 2. Current: Thread with 2.3 (1 -> 2 -> 2.1 -> 2.2 -> 2.3)
        });
    });
});