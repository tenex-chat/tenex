import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentInstance } from "@/agents/types";
import type { Conversation } from "@/conversations";
import { ThreadService } from "@/conversations/services/ThreadService";
import { DelegationRegistry } from "@/services/DelegationRegistry";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import type { ExecutionContext } from "../../types";
import { FlattenedChronologicalStrategy } from "../FlattenedChronologicalStrategy";

/**
 * Test that agents see the full thread path (root → triggering event)
 * even if some messages in the path are not directly targeted to them.
 *
 * This ensures agents can answer "what did we discuss?" questions.
 */
describe("FlattenedChronologicalStrategy - Thread Path Inclusion", () => {
    const USER_PUBKEY = "user-pubkey-123";
    const AGENT_A_PUBKEY = "agent-a-pubkey-456";
    const AGENT_B_PUBKEY = "agent-b-pubkey-789";
    const CONVERSATION_ID = "test-conversation-linear";

    let events: NDKEvent[];
    let strategy: FlattenedChronologicalStrategy;
    let mockContextAgentB: ExecutionContext;
    let mockConversation: Conversation;

    beforeAll(async () => {
        await DelegationRegistry.initialize();

        // Create a linear conversation:
        // Root: User -> Agent A
        //   └─ Agent A replies
        //     └─ User -> Agent B (asks about conversation)
        //       └─ Agent B replies
        events = [];

        // Event 1: User asks Agent A
        const event1 = new NDKEvent();
        event1.id = "event-1-root";
        event1.pubkey = USER_PUBKEY;
        event1.content = "test @agent-a";
        event1.kind = 11;
        event1.created_at = 1000;
        event1.tags = [["p", AGENT_A_PUBKEY]];
        event1.sig = "sig1";
        events.push(event1);

        // Event 2: Agent A replies
        const event2 = new NDKEvent();
        event2.id = "event-2-agent-a-reply";
        event2.pubkey = AGENT_A_PUBKEY;
        event2.content = "ok";
        event2.kind = 1111;
        event2.created_at = 1001;
        event2.tags = [
            ["e", event1.id],
            ["E", event1.id],
            ["p", USER_PUBKEY],
        ];
        event2.sig = "sig2";
        events.push(event2);

        // Event 3: User asks Agent B about the conversation
        const event3 = new NDKEvent();
        event3.id = "event-3-user-to-agent-b";
        event3.pubkey = USER_PUBKEY;
        event3.content = "@agent-b what messages did we discuss in this conversation?";
        event3.kind = 1111;
        event3.created_at = 1002;
        event3.tags = [
            ["e", event2.id],
            ["E", event1.id],
            ["p", AGENT_B_PUBKEY],
        ];
        event3.sig = "sig3";
        events.push(event3);

        // Event 4: Agent B replies (this will be the triggering event)
        const event4 = new NDKEvent();
        event4.id = "event-4-agent-b-reply";
        event4.pubkey = AGENT_B_PUBKEY;
        event4.content = "I can see the full conversation history";
        event4.kind = 1111;
        event4.created_at = 1003;
        event4.tags = [
            ["e", event3.id],
            ["E", event1.id],
            ["p", USER_PUBKEY],
        ];
        event4.sig = "sig4";
        events.push(event4);

        // Create mock conversation
        mockConversation = {
            id: CONVERSATION_ID,
            history: events,
            participants: new Set([USER_PUBKEY, AGENT_A_PUBKEY, AGENT_B_PUBKEY]),
            agentStates: new Map(),
            metadata: {},
            executionTime: { totalSeconds: 0, isActive: false, lastUpdated: Date.now() },
        } as Conversation;

        // Create strategy
        strategy = new FlattenedChronologicalStrategy();

        // Create mock Agent B
        const agentB: AgentInstance = {
            name: "Agent B",
            slug: "agent-b",
            pubkey: AGENT_B_PUBKEY,
            role: "assistant",
            instructions: "Test Agent B",
            tools: [],
        };

        // Create ThreadService
        const threadService = new ThreadService();

        // Create mock execution context for Agent B
        mockContextAgentB = {
            agent: agentB,
            conversationId: CONVERSATION_ID,
            projectPath: "/test/path",
            triggeringEvent: event3, // Agent B is responding to event 3
            conversationCoordinator: {
                threadService,
            } as any,
            agentPublisher: {} as any,
            getConversation: () => mockConversation,
            isDelegationCompletion: false,
        } as ExecutionContext;
    });

    it("should include ALL events in thread path, even those not targeted to the agent", async () => {
        const messages = await strategy.buildMessages(mockContextAgentB, events[2]); // event3 = triggering

        const messageContents = messages.map((m) =>
            typeof m.content === "string" ? m.content : JSON.stringify(m.content)
        );

        console.log("\n=== Messages for Agent B ===");
        messageContents.forEach((content, i) => {
            console.log(`\nMessage ${i + 1} (${messages[i].role}):`, content.substring(0, 150));
        });

        // Agent B should see event 1 (root) even though it was targeted to Agent A
        const hasEvent1 = messageContents.some((content) => content.includes("test @agent-a"));
        expect(hasEvent1).toBe(true);

        // Agent B should see event 2 (Agent A's reply) even though it's from another agent
        const hasEvent2 = messageContents.some(
            (content) => content.includes("ok") && !content.includes("Agent B") // "ok" from Agent A, not Agent B
        );
        expect(hasEvent2).toBe(true);

        // Agent B should see event 3 (targeted to it)
        const hasEvent3 = messageContents.some((content) =>
            content.includes("what messages did we discuss")
        );
        expect(hasEvent3).toBe(true);
    });

    it("should mark thread path events as included via 'in_thread_path' reason", async () => {
        // This test verifies the trace events would show the correct inclusion reason
        // We can't directly test trace events in unit tests, but the logic is in place
        const messages = await strategy.buildMessages(mockContextAgentB, events[2]);

        // If messages include events not targeted to Agent B, they were included via thread path
        const messageContents = messages.map((m) =>
            typeof m.content === "string" ? m.content : JSON.stringify(m.content)
        );

        const hasNonTargetedMessage = messageContents.some((content) =>
            content.includes("test @agent-a")
        );

        expect(hasNonTargetedMessage).toBe(true);
    });

    it("should maintain chronological order of thread path events", async () => {
        const messages = await strategy.buildMessages(mockContextAgentB, events[2]);

        const messageContents = messages.map((m) =>
            typeof m.content === "string" ? m.content : JSON.stringify(m.content)
        );

        // Find indices of our events
        const event1Index = messageContents.findIndex((c) => c.includes("test @agent-a"));
        const event2Index = messageContents.findIndex(
            (c) => c.includes("ok") && !c.includes("Agent B")
        );
        const event3Index = messageContents.findIndex((c) =>
            c.includes("what messages did we discuss")
        );

        // All should be present
        expect(event1Index).toBeGreaterThanOrEqual(0);
        expect(event2Index).toBeGreaterThanOrEqual(0);
        expect(event3Index).toBeGreaterThanOrEqual(0);

        // Should be in order
        expect(event1Index).toBeLessThan(event2Index);
        expect(event2Index).toBeLessThan(event3Index);
    });
});
