import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentInstance } from "@/agents/types";
import type { Conversation } from "@/conversations";
import { ThreadService } from "@/conversations/services/ThreadService";
import { DelegationRegistry } from "@/services/DelegationRegistry";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import type { ExecutionContext } from "../../types";
import "./test-mocks"; // Import shared mocks
import { FlattenedChronologicalStrategy } from "../FlattenedChronologicalStrategy";
import "./test-mocks"; // Import shared mocks

/**
 * Test filtering in branching conversations:
 * - Agent should see its own branch (thread path)
 * - Agent should see messages where it's directly involved in other branches
 * - Agent should NOT see unrelated branches
 */
describe("FlattenedChronologicalStrategy - Branching Conversations", () => {
    const USER_PUBKEY = "user-pubkey-123";
    const AGENT_A_PUBKEY = "agent-a-pubkey-456";
    const AGENT_B_PUBKEY = "agent-b-pubkey-789";
    const AGENT_C_PUBKEY = "agent-c-pubkey-abc";
    const CONVERSATION_ID = "test-conversation-branching";

    let events: NDKEvent[];
    let strategy: FlattenedChronologicalStrategy;
    let mockConversation: Conversation;

    beforeAll(async () => {
        await DelegationRegistry.initialize();

        // Create a branching conversation:
        // Root: User asks a question
        //   ├─ Branch A: User -> Agent A -> Agent A replies
        //   │    └─ Agent A -> Agent B (mentions Agent B)
        //   │         └─ Agent B replies
        //   └─ Branch C: User -> Agent C -> Agent C replies (parallel, unrelated)

        events = [];

        // Event 1: Root - User asks general question
        const event1 = new NDKEvent();
        event1.id = "event-1-root";
        event1.pubkey = USER_PUBKEY;
        event1.content = "I need help with something";
        event1.kind = 11;
        event1.created_at = 1000;
        event1.tags = [];
        event1.sig = "sig1";
        events.push(event1);

        // Event 2: Branch A - User asks Agent A
        const event2 = new NDKEvent();
        event2.id = "event-2-branch-a-start";
        event2.pubkey = USER_PUBKEY;
        event2.content = "@agent-a can you help?";
        event2.kind = 1111;
        event2.created_at = 1001;
        event2.tags = [
            ["e", event1.id],
            ["E", event1.id],
            ["p", AGENT_A_PUBKEY],
        ];
        event2.sig = "sig2";
        events.push(event2);

        // Event 3: Branch A - Agent A replies
        const event3 = new NDKEvent();
        event3.id = "event-3-agent-a-reply";
        event3.pubkey = AGENT_A_PUBKEY;
        event3.content = "Sure, let me check with @agent-b";
        event3.kind = 1111;
        event3.created_at = 1002;
        event3.tags = [
            ["e", event2.id],
            ["E", event1.id],
            ["p", USER_PUBKEY],
            ["p", AGENT_B_PUBKEY],
        ];
        event3.sig = "sig3";
        events.push(event3);

        // Event 4: Branch A continues - Agent B replies to Agent A
        const event4 = new NDKEvent();
        event4.id = "event-4-agent-b-reply";
        event4.pubkey = AGENT_B_PUBKEY;
        event4.content = "I can help with that";
        event4.kind = 1111;
        event4.created_at = 1003;
        event4.tags = [
            ["e", event3.id],
            ["E", event1.id],
            ["p", AGENT_A_PUBKEY],
            ["p", USER_PUBKEY],
        ];
        event4.sig = "sig4";
        events.push(event4);

        // Event 5: Branch C (parallel, unrelated) - User asks Agent C
        const event5 = new NDKEvent();
        event5.id = "event-5-branch-c-start";
        event5.pubkey = USER_PUBKEY;
        event5.content = "@agent-c different question";
        event5.kind = 1111;
        event5.created_at = 1004;
        event5.tags = [
            ["e", event1.id],
            ["E", event1.id],
            ["p", AGENT_C_PUBKEY],
        ];
        event5.sig = "sig5";
        events.push(event5);

        // Event 6: Branch C - Agent C replies
        const event6 = new NDKEvent();
        event6.id = "event-6-agent-c-reply";
        event6.pubkey = AGENT_C_PUBKEY;
        event6.content = "Here's the answer";
        event6.kind = 1111;
        event6.created_at = 1005;
        event6.tags = [
            ["e", event5.id],
            ["E", event1.id],
            ["p", USER_PUBKEY],
        ];
        event6.sig = "sig6";
        events.push(event6);

        // Create mock conversation
        mockConversation = {
            id: CONVERSATION_ID,
            history: events,
            participants: new Set([USER_PUBKEY, AGENT_A_PUBKEY, AGENT_B_PUBKEY, AGENT_C_PUBKEY]),
            agentStates: new Map(),
            metadata: {},
            executionTime: { totalSeconds: 0, isActive: false, lastUpdated: Date.now() },
        } as Conversation;

        strategy = new FlattenedChronologicalStrategy();
    });

    it("Agent B should see its thread path (root -> branch A)", async () => {
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
            triggeringEvent: events[3], // event4 = Agent B's reply
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
            console.log(`Message ${i + 1} (${messages[i].role}):`, content.substring(0, 100));
        });

        // Should see root
        expect(messageContents.some((c) => c.includes("I need help with something"))).toBe(true);

        // Should see branch A start
        expect(messageContents.some((c) => c.includes("@agent-a can you help"))).toBe(true);

        // Should see Agent A's reply (mentions Agent B)
        expect(messageContents.some((c) => c.includes("let me check with @agent-b"))).toBe(true);

        // Should see its own reply
        expect(messageContents.some((c) => c.includes("I can help with that"))).toBe(true);
    });

    it("Agent B should NOT see unrelated Branch C", async () => {
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
            triggeringEvent: events[3], // event4 = Agent B's reply
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

        // Should NOT see Branch C messages
        expect(messageContents.some((c) => c.includes("@agent-c different question"))).toBe(false);
        expect(messageContents.some((c) => c.includes("Here's the answer"))).toBe(false);
    });

    it("Agent C should see its own branch but NOT Branch A details", async () => {
        const agentC: AgentInstance = {
            name: "Agent C",
            slug: "agent-c",
            pubkey: AGENT_C_PUBKEY,
            role: "assistant",
            instructions: "Test Agent C",
            tools: [],
        };

        const threadService = new ThreadService();

        const mockContext: ExecutionContext = {
            agent: agentC,
            conversationId: CONVERSATION_ID,
            projectPath: "/test/path",
            triggeringEvent: events[4], // event5 = User asking Agent C
            conversationCoordinator: {
                threadService,
            } as any,
            agentPublisher: {} as any,
            getConversation: () => mockConversation,
            isDelegationCompletion: false,
        } as ExecutionContext;

        const messages = await strategy.buildMessages(mockContext, events[4]);

        const messageContents = messages.map((m) =>
            typeof m.content === "string" ? m.content : JSON.stringify(m.content)
        );

        console.log("\n=== Messages for Agent C ===");
        messageContents.forEach((content, i) => {
            console.log(`Message ${i + 1} (${messages[i].role}):`, content.substring(0, 100));
        });

        // Should see root (in thread path)
        expect(messageContents.some((c) => c.includes("I need help with something"))).toBe(true);

        // Should see message targeted to it
        expect(messageContents.some((c) => c.includes("@agent-c different question"))).toBe(true);

        // WILL see Branch A start (root-level sibling) because of root-level sibling inclusion
        // This is correct behavior - root-level conversations are collaborative
        expect(messageContents.some((c) => c.includes("@agent-a can you help"))).toBe(true);

        // Should NOT see deeper Branch A messages (Agent A -> Agent B exchange)
        // because Agent C's triggering event is at root level, it only sees root-level siblings
        // Event3 ("let me check...") is depth 3 (parent=event2), Event4 is depth 4
        expect(messageContents.some((c) => c.includes("let me check with @agent-b"))).toBe(false);
        expect(messageContents.some((c) => c.includes("I can help with that"))).toBe(false);
    });

    it("Agent A should see messages where it participated across branches", async () => {
        const agentA: AgentInstance = {
            name: "Agent A",
            slug: "agent-a",
            pubkey: AGENT_A_PUBKEY,
            role: "assistant",
            instructions: "Test Agent A",
            tools: [],
        };

        const threadService = new ThreadService();

        // Agent A responding to its own branch
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

        // Should see its own branch
        expect(messageContents.some((c) => c.includes("@agent-a can you help"))).toBe(true);

        // WILL see Branch C because of root-level sibling inclusion
        // All root-level replies are visible to agents responding at root level
        expect(messageContents.some((c) => c.includes("@agent-c different question"))).toBe(true);
    });
});
