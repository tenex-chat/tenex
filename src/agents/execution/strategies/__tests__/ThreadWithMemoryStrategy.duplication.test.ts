import type { ConversationCoordinator } from "@/conversations/coordinator/ConversationCoordinator";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { ExecutionContext } from "../../types";
import { ThreadWithMemoryStrategy } from "../ThreadWithMemoryStrategy";

import "./test-mocks"; // Import shared mocks
describe("ThreadWithMemoryStrategy - Context Duplication Fix", () => {
    let strategy: ThreadWithMemoryStrategy;
    let mockContext: ExecutionContext;
    let mockConversation: any;

    beforeEach(() => {
        strategy = new ThreadWithMemoryStrategy();

        // Create mock conversation with history
        mockConversation = {
            history: [] as NDKEvent[],
        };

        // Create mock context
        mockContext = {
            conversationId: "conv123",
            agent: {
                pubkey: "agent-pubkey",
                name: "test-agent",
                instructions: "Test instructions",
            },
            conversationCoordinator: {
                threadService: {
                    getThreadToEvent: mock(() => undefined),
                },
                participationIndex: {
                    getAgentParticipations: mock(() => []),
                },
            } as unknown as ConversationCoordinator,
            getConversation: mock(() => mockConversation),
            isDelegationCompletion: false,
        } as ExecutionContext;
    });

    const createMockEvent = (
        id: string,
        content: string,
        pubkey: string,
        parentId?: string,
        created_at?: number
    ): NDKEvent => {
        return {
            id,
            content,
            pubkey,
            created_at: created_at || Date.now() / 1000,
            tags: parentId ? [["e", parentId]] : [],
            tagValue: (tag: string) => {
                if (tag === "e" && parentId) return parentId;
                return undefined;
            },
        } as NDKEvent;
    };

    it('should NOT include the active thread in the "other threads" context', async () => {
        // Set up conversation history
        const events = [
            createMockEvent("root", "Initial question", "user1"),
            createMockEvent("reply1", "Agent first response", "agent-pubkey", "root", 1000),
            createMockEvent("reply2", "User follow-up", "user1", "reply1", 2000),
            createMockEvent("reply3", "Agent second response", "agent-pubkey", "reply2", 3000),
            createMockEvent("trigger", "What about this?", "user1", "reply3", 4000), // Triggering event
        ];

        mockConversation.history = events;

        // Mock the thread service to return the active thread
        const activeThread = events; // All events form the active thread
        (mockContext.conversationCoordinator.threadService.getThreadToEvent as any).mockReturnValue(
            activeThread
        );

        // Mock participation index to show agent participated
        (
            mockContext.conversationCoordinator.participationIndex.getAgentParticipations as any
        ).mockReturnValue(["reply1", "reply3"]);

        // Build messages
        const triggeringEvent = events[4]; // The 'trigger' event
        const messages = await strategy.buildMessages(mockContext, triggeringEvent);

        // Count how many times the agent's responses appear in messages
        const allContent = messages.map((m) => m.content).join("\n");

        // The agent's responses should appear only once (in the main thread)
        // NOT in both the main thread AND the "other threads" section
        const firstResponseCount = (allContent.match(/Agent first response/g) || []).length;
        const secondResponseCount = (allContent.match(/Agent second response/g) || []).length;

        // Each response should appear exactly once
        expect(firstResponseCount).toBe(1);
        expect(secondResponseCount).toBe(1);

        // Should NOT have "other related subthreads" message when all participation is in active thread
        const hasOtherThreadsMessage = allContent.includes(
            "You were active in these other related subthreads"
        );
        expect(hasOtherThreadsMessage).toBe(false);
    });

    it("should include other threads when agent participated in multiple branches", async () => {
        // Set up conversation with multiple branches
        const events = [
            // Main thread
            createMockEvent("root", "Initial question", "user1"),
            createMockEvent("branch1", "First branch", "user2", "root", 1000),
            createMockEvent(
                "agent-branch1",
                "Agent in first branch",
                "agent-pubkey",
                "branch1",
                1500
            ),

            // Active thread (different branch)
            createMockEvent("branch2", "Second branch", "user1", "root", 2000),
            createMockEvent("reply-branch2", "Continuing second", "user1", "branch2", 3000),
            createMockEvent("trigger", "Current question", "user1", "reply-branch2", 4000),
        ];

        mockConversation.history = events;

        // Active thread is: root -> branch2 -> reply-branch2 -> trigger
        const activeThread = [
            events[0], // root
            events[3], // branch2
            events[4], // reply-branch2
            events[5], // trigger
        ];
        (mockContext.conversationCoordinator.threadService.getThreadToEvent as any).mockReturnValue(
            activeThread
        );

        // Agent participated in branch1
        (
            mockContext.conversationCoordinator.participationIndex.getAgentParticipations as any
        ).mockReturnValue(["agent-branch1"]);

        // Build messages
        const triggeringEvent = events[5]; // The 'trigger' event
        const messages = await strategy.buildMessages(mockContext, triggeringEvent);

        const allContent = messages.map((m) => m.content).join("\n");

        // Should include the "other threads" message since agent was in a different branch
        const hasOtherThreadsMessage = allContent.includes(
            "You were active in these other related subthreads"
        );
        expect(hasOtherThreadsMessage).toBe(true);

        // Agent's response from branch1 should appear in other threads section
        expect(allContent).toContain("Agent in first branch");

        // But the active branch content should still be there
        expect(allContent).toContain("Second branch");
    });

    it("should handle sub-threads rooted at agent responses correctly", async () => {
        // Set up conversation where agent's response becomes a sub-thread root
        const events = [
            createMockEvent("root", "Initial question", "user1"),
            createMockEvent(
                "agent-reply",
                "Agent response that starts sub-thread",
                "agent-pubkey",
                "root",
                1000
            ),
            createMockEvent("other-branch", "Different discussion", "user2", "agent-reply", 2000),
            createMockEvent("other-continue", "Continuing other", "user2", "other-branch", 3000),

            // Active thread
            createMockEvent("main-branch", "Main discussion", "user1", "root", 2500),
            createMockEvent("trigger", "Current question", "user1", "main-branch", 4000),
        ];

        mockConversation.history = events;

        // Active thread is: root -> main-branch -> trigger
        const activeThread = [
            events[0], // root
            events[4], // main-branch
            events[5], // trigger
        ];
        (mockContext.conversationCoordinator.threadService.getThreadToEvent as any).mockReturnValue(
            activeThread
        );

        // Agent participated at agent-reply
        (
            mockContext.conversationCoordinator.participationIndex.getAgentParticipations as any
        ).mockReturnValue(["agent-reply"]);

        // Build messages
        const triggeringEvent = events[5]; // The 'trigger' event
        const messages = await strategy.buildMessages(mockContext, triggeringEvent);

        const allContent = messages.map((m) => m.content).join("\n");

        // Should include the other thread where agent participated
        const hasOtherThreadsMessage = allContent.includes(
            "You were active in these other related subthreads"
        );
        expect(hasOtherThreadsMessage).toBe(true);

        // Agent's response should appear in other threads
        expect(allContent).toContain("Agent response that starts sub-thread");

        // The continuation of that thread should also be included for context
        expect(allContent).toContain("Different discussion");
        expect(allContent).toContain("Continuing other");
    });
});
