import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentInstance } from "@/agents/types";
import type { Conversation } from "@/conversations";
import { ThreadService } from "@/conversations/services/ThreadService";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import type { ExecutionContext } from "../../types";
import { FlattenedChronologicalStrategy } from "../FlattenedChronologicalStrategy";
import "./test-mocks"; // Import shared mocks

/**
 * Test public broadcast handling:
 * - User messages with no agent targets should be seen by all agents
 * - Targeted messages should only be seen by thread path or targeted agents
 */
describe("FlattenedChronologicalStrategy - Public Broadcasts", () => {
    const USER_PUBKEY = "user-pubkey-123";
    const AGENT_A_PUBKEY = "agent-a-pubkey-456";
    const AGENT_B_PUBKEY = "agent-b-pubkey-789";
    const CONVERSATION_ID = "test-conversation-broadcast";

    let events: NDKEvent[];
    let strategy: FlattenedChronologicalStrategy;
    let mockConversation: Conversation;

    beforeAll(async () => {
        events = [];

        // Event 1: Public broadcast from user (no p-tags to agents)
        const event1 = new NDKEvent();
        event1.id = "event-1-public-broadcast";
        event1.pubkey = USER_PUBKEY;
        event1.content = "Hello everyone! General announcement.";
        event1.kind = 11;
        event1.created_at = 1000;
        event1.tags = []; // No p-tags = public broadcast
        event1.sig = "sig1";
        events.push(event1);

        // Event 2: Branch A - User asks Agent A specifically
        const event2 = new NDKEvent();
        event2.id = "event-2-targeted-to-a";
        event2.pubkey = USER_PUBKEY;
        event2.content = "@agent-a what do you think?";
        event2.kind = 1111;
        event2.created_at = 1001;
        event2.tags = [
            ["e", event1.id],
            ["E", event1.id],
            ["p", AGENT_A_PUBKEY],
        ];
        event2.sig = "sig2";
        events.push(event2);

        // Event 3: Agent A replies
        const event3 = new NDKEvent();
        event3.id = "event-3-agent-a-reply";
        event3.pubkey = AGENT_A_PUBKEY;
        event3.content = "I think it's great!";
        event3.kind = 1111;
        event3.created_at = 1002;
        event3.tags = [
            ["e", event2.id],
            ["E", event1.id],
            ["p", USER_PUBKEY],
        ];
        event3.sig = "sig3";
        events.push(event3);

        // Event 4: Branch B - User asks Agent B specifically
        const event4 = new NDKEvent();
        event4.id = "event-4-targeted-to-b";
        event4.pubkey = USER_PUBKEY;
        event4.content = "@agent-b your thoughts?";
        event4.kind = 1111;
        event4.created_at = 1003;
        event4.tags = [
            ["e", event1.id],
            ["E", event1.id],
            ["p", AGENT_B_PUBKEY],
        ];
        event4.sig = "sig4";
        events.push(event4);

        // Event 5: Agent B replies
        const event5 = new NDKEvent();
        event5.id = "event-5-agent-b-reply";
        event5.pubkey = AGENT_B_PUBKEY;
        event5.content = "Sounds good to me!";
        event5.kind = 1111;
        event5.created_at = 1004;
        event5.tags = [
            ["e", event4.id],
            ["E", event1.id],
            ["p", USER_PUBKEY],
        ];
        event5.sig = "sig5";
        events.push(event5);

        // Create mock conversation
        mockConversation = {
            id: CONVERSATION_ID,
            history: events,
            participants: new Set([USER_PUBKEY, AGENT_A_PUBKEY, AGENT_B_PUBKEY]),
            agentStates: new Map(),
            metadata: {},
            executionTime: { totalSeconds: 0, isActive: false, lastUpdated: Date.now() },
        } as Conversation;

        strategy = new FlattenedChronologicalStrategy();
    });

    it("Agent A should see public broadcast in its thread path", async () => {
        const agentA: AgentInstance = {
            name: "Agent A",
            slug: "agent-a",
            pubkey: AGENT_A_PUBKEY,
            role: "assistant",
            instructions: "Test Agent A",
            tools: [],
        };

        const threadService = new ThreadService();

        const mockContext: ExecutionContext = {
            agent: agentA,
            conversationId: CONVERSATION_ID,
            projectPath: "/test/path",
            triggeringEvent: events[1], // event2 = User asking Agent A
            conversationCoordinator: {
                threadService,
            } as any,
            agentPublisher: {} as any,
            getConversation: () => mockConversation,
            isDelegationCompletion: false,
        } as ExecutionContext;

        const messages = await strategy.buildMessages(mockContext, events[1]);

        const messageContents = messages.map((m) =>
            typeof m.content === "string" ? m.content : JSON.stringify(m.content)
        );

        console.log("\n=== Messages for Agent A ===");
        messageContents.forEach((content, i) => {
            console.log(`Message ${i + 1}:`, content.substring(0, 100));
        });

        // Should see public broadcast (it's in thread path to root)
        expect(messageContents.some((c) => c.includes("Hello everyone"))).toBe(true);

        // Should see message targeted to it
        expect(messageContents.some((c) => c.includes("@agent-a what do you think"))).toBe(true);
    });

    it("Agent B should see public broadcast in its thread path", async () => {
        const agentB: AgentInstance = {
            name: "Agent B",
            slug: "agent-b",
            pubkey: AGENT_B_PUBKEY,
            role: "assistant",
            instructions: "Test Agent B",
            tools: [],
        };

        const threadService = new ThreadService();

        const mockContext: ExecutionContext = {
            agent: agentB,
            conversationId: CONVERSATION_ID,
            projectPath: "/test/path",
            triggeringEvent: events[3], // event4 = User asking Agent B
            conversationCoordinator: {
                threadService,
            } as any,
            agentPublisher: {} as any,
            getConversation: () => mockConversation,
            isDelegationCompletion: false,
        } as ExecutionContext;

        const messages = await strategy.buildMessages(mockContext, events[3]);

        const messageContents = messages.map((m) =>
            typeof m.content === "string" ? m.content : JSON.stringify(m.content)
        );

        console.log("\n=== Messages for Agent B ===");
        messageContents.forEach((content, i) => {
            console.log(`Message ${i + 1}:`, content.substring(0, 100));
        });

        // Should see public broadcast (it's in thread path to root)
        expect(messageContents.some((c) => c.includes("Hello everyone"))).toBe(true);

        // Should see message targeted to it
        expect(messageContents.some((c) => c.includes("@agent-b your thoughts"))).toBe(true);

        // WILL see root-level sibling (event2: user asking Agent A)
        // Root-level conversations are collaborative - all agents see root-level siblings
        expect(messageContents.some((c) => c.includes("@agent-a what do you think"))).toBe(true);

        // Should NOT see Agent A's deeper reply (event3 is depth 3, parent=event2)
        expect(messageContents.some((c) => c.includes("I think it's great"))).toBe(false);
    });

    it("Agent A sees Agent B's branch due to root-level sibling inclusion", async () => {
        const agentA: AgentInstance = {
            name: "Agent A",
            slug: "agent-a",
            pubkey: AGENT_A_PUBKEY,
            role: "assistant",
            instructions: "Test Agent A",
            tools: [],
        };

        const threadService = new ThreadService();

        const mockContext: ExecutionContext = {
            agent: agentA,
            conversationId: CONVERSATION_ID,
            projectPath: "/test/path",
            triggeringEvent: events[1], // event2 = User asking Agent A
            conversationCoordinator: {
                threadService,
            } as any,
            agentPublisher: {} as any,
            getConversation: () => mockConversation,
            isDelegationCompletion: false,
        } as ExecutionContext;

        const messages = await strategy.buildMessages(mockContext, events[1]);

        const messageContents = messages.map((m) =>
            typeof m.content === "string" ? m.content : JSON.stringify(m.content)
        );

        // WILL see Branch B start (event4: root-level sibling)
        expect(messageContents.some((c) => c.includes("@agent-b your thoughts"))).toBe(true);

        // Should NOT see Agent B's deeper reply (event5 is depth 3, parent=event4)
        expect(messageContents.some((c) => c.includes("Sounds good to me"))).toBe(false);
    });
});
