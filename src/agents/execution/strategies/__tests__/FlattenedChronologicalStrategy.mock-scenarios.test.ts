import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentInstance } from "@/agents/types";
import type { Conversation } from "@/conversations";
import { ThreadService } from "@/conversations/services/ThreadService";
import { DelegationRegistry } from "@/services/DelegationRegistry";
import type { ExecutionContext } from "../../types";
import "./test-mocks"; // Import shared mocks
import { FlattenedChronologicalStrategy } from "../FlattenedChronologicalStrategy";
import "./test-mocks"; // Import shared mocks
import { MOCK_AGENTS, MockEventGenerator } from "./mock-event-generator";

describe("FlattenedChronologicalStrategy - Mock Scenarios", () => {
    let strategy: FlattenedChronologicalStrategy;
    let generator: MockEventGenerator;

    beforeAll(async () => {
        await DelegationRegistry.initialize();
        strategy = new FlattenedChronologicalStrategy();
        generator = new MockEventGenerator();
    });

    describe("Complex Threading Scenario", () => {
        const events = new MockEventGenerator().generateComplexThreadingScenario();

        it("Bob should see Alice's task assignment and Charlie's review but not Diana's separate branch", async () => {
            const bob: AgentInstance = {
                name: MOCK_AGENTS.bob.name,
                slug: MOCK_AGENTS.bob.slug,
                pubkey: MOCK_AGENTS.bob.pubkey,
                role: "developer",
                instructions: "Test Bob",
                tools: [],
            };

            const mockConversation: Conversation = {
                id: "test-complex",
                history: events,
                participants: new Set(Object.values(MOCK_AGENTS).map((a) => a.pubkey)),
                agentStates: new Map(),
                metadata: {},
                executionTime: { totalSeconds: 0, isActive: false, lastUpdated: Date.now() },
            } as Conversation;

            // Bob's triggering event is Alice's task assignment
            const triggeringEvent = events.find((e) => e.id === "alice-tasks")!;

            const mockContext: ExecutionContext = {
                agent: bob,
                conversationId: "test-complex",
                projectPath: "/test/path",
                triggeringEvent,
                conversationCoordinator: {
                    threadService: new ThreadService(),
                } as any,
                agentPublisher: {} as any,
                getConversation: () => mockConversation,
                isDelegationCompletion: false,
            } as ExecutionContext;

            const messages = await strategy.buildMessages(mockContext, triggeringEvent);
            const messageContents = messages.map((m) =>
                typeof m.content === "string" ? m.content : JSON.stringify(m.content)
            );

            // Bob should see:
            // 1. Root announcement
            expect(messageContents.some((c) => c.includes("Starting new feature: Dark Mode"))).toBe(
                true
            );

            // 2. Alice's task assignment (his triggering event)
            expect(
                messageContents.some((c) => c.includes("please implement the dark mode toggle"))
            ).toBe(true);

            // 3. Diana's testing (root-level sibling)
            expect(
                messageContents.some((c) => c.includes("I'll start testing the dark mode"))
            ).toBe(true);

            // 4. Public broadcast (root-level sibling)
            expect(messageContents.some((c) => c.includes("Team meeting at 3pm"))).toBe(true);

            // Bob should NOT see Diana's bug report (depth 3 in different branch)
            expect(messageContents.some((c) => c.includes("Charts don't update colors"))).toBe(
                false
            );
        });

        it("Charlie should see Bob's implementation in his thread path", async () => {
            const charlie: AgentInstance = {
                name: MOCK_AGENTS.charlie.name,
                slug: MOCK_AGENTS.charlie.slug,
                pubkey: MOCK_AGENTS.charlie.pubkey,
                role: "reviewer",
                instructions: "Test Charlie",
                tools: [],
            };

            const mockConversation: Conversation = {
                id: "test-complex",
                history: events,
                participants: new Set(Object.values(MOCK_AGENTS).map((a) => a.pubkey)),
                agentStates: new Map(),
                metadata: {},
                executionTime: { totalSeconds: 0, isActive: false, lastUpdated: Date.now() },
            } as Conversation;

            // Charlie's triggering event is Bob's implementation
            const triggeringEvent = events.find((e) => e.id === "bob-implementation")!;

            const mockContext: ExecutionContext = {
                agent: charlie,
                conversationId: "test-complex",
                projectPath: "/test/path",
                triggeringEvent,
                conversationCoordinator: {
                    threadService: new ThreadService(),
                } as any,
                agentPublisher: {} as any,
                getConversation: () => mockConversation,
                isDelegationCompletion: false,
            } as ExecutionContext;

            const messages = await strategy.buildMessages(mockContext, triggeringEvent);
            const messageContents = messages.map((m) =>
                typeof m.content === "string" ? m.content : JSON.stringify(m.content)
            );

            // Charlie should see his thread path:
            // Root -> Alice's task -> Bob's implementation
            expect(messageContents.some((c) => c.includes("Starting new feature: Dark Mode"))).toBe(
                true
            );
            expect(
                messageContents.some((c) => c.includes("please implement the dark mode toggle"))
            ).toBe(true);
            expect(
                messageContents.some((c) => c.includes("I'll add the toggle to the settings panel"))
            ).toBe(true);

            // Charlie should NOT see root-level siblings (he's at depth 4)
            expect(
                messageContents.some((c) => c.includes("I'll start testing the dark mode"))
            ).toBe(false);
            expect(messageContents.some((c) => c.includes("Team meeting at 3pm"))).toBe(false);
        });
    });

    describe("Root Collaboration Scenario", () => {
        const events = new MockEventGenerator().generateRootCollaborationScenario();

        it("All agents at root level should see each other's contributions", async () => {
            const alice: AgentInstance = {
                name: MOCK_AGENTS.alice.name,
                slug: MOCK_AGENTS.alice.slug,
                pubkey: MOCK_AGENTS.alice.pubkey,
                role: "pm",
                instructions: "Test Alice",
                tools: [],
            };

            const mockConversation: Conversation = {
                id: "test-collaboration",
                history: events,
                participants: new Set(Object.values(MOCK_AGENTS).map((a) => a.pubkey)),
                agentStates: new Map(),
                metadata: {},
                executionTime: { totalSeconds: 0, isActive: false, lastUpdated: Date.now() },
            } as Conversation;

            // Alice's triggering event is her own response (root-level reply)
            const triggeringEvent = events.find((e) => e.id === "alice-root-response")!;

            const mockContext: ExecutionContext = {
                agent: alice,
                conversationId: "test-collaboration",
                projectPath: "/test/path",
                triggeringEvent,
                conversationCoordinator: {
                    threadService: new ThreadService(),
                } as any,
                agentPublisher: {} as any,
                getConversation: () => mockConversation,
                isDelegationCompletion: false,
            } as ExecutionContext;

            const messages = await strategy.buildMessages(mockContext, triggeringEvent);
            const messageContents = messages.map((m) =>
                typeof m.content === "string" ? m.content : JSON.stringify(m.content)
            );

            // Alice should see ALL root-level responses
            expect(messageContents.some((c) => c.includes("optimizing our database queries"))).toBe(
                true
            );
            expect(messageContents.some((c) => c.includes("add proper indexes first"))).toBe(true);
            expect(messageContents.some((c) => c.includes("consider query caching"))).toBe(true);
            expect(messageContents.some((c) => c.includes("connection pooling"))).toBe(true);
            expect(messageContents.some((c) => c.includes("benchmark the before/after"))).toBe(
                true
            );

            // Verify all 5 events are visible (root + 4 responses)
            const visibleCount = events.filter((e) =>
                messageContents.some((c) => c.includes(e.content.substring(0, 20)))
            ).length;
            expect(visibleCount).toBe(5);
        });
    });

    describe("Delegation Chain Scenario", () => {
        const events = new MockEventGenerator().generateDelegationScenario();

        it("Bob should see Alice's delegation request and Diana's sub-delegation", async () => {
            const bob: AgentInstance = {
                name: MOCK_AGENTS.bob.name,
                slug: MOCK_AGENTS.bob.slug,
                pubkey: MOCK_AGENTS.bob.pubkey,
                role: "developer",
                instructions: "Test Bob",
                tools: [],
            };

            const mockConversation: Conversation = {
                id: "test-delegation",
                history: events,
                participants: new Set(Object.values(MOCK_AGENTS).map((a) => a.pubkey)),
                agentStates: new Map(),
                metadata: {},
                executionTime: { totalSeconds: 0, isActive: false, lastUpdated: Date.now() },
            } as Conversation;

            // Bob's triggering event is Alice's delegation
            const triggeringEvent = events.find((e) => e.id === "alice-pm-response")!;

            const mockContext: ExecutionContext = {
                agent: bob,
                conversationId: "test-delegation",
                projectPath: "/test/path",
                triggeringEvent,
                conversationCoordinator: {
                    threadService: new ThreadService(),
                } as any,
                agentPublisher: {} as any,
                getConversation: () => mockConversation,
                isDelegationCompletion: false,
            } as ExecutionContext;

            const messages = await strategy.buildMessages(mockContext, triggeringEvent);
            const messageContents = messages.map((m) =>
                typeof m.content === "string" ? m.content : JSON.stringify(m.content)
            );

            // Bob should see:
            // 1. Root request
            expect(messageContents.some((c) => c.includes("user authentication with OAuth"))).toBe(
                true
            );

            // 2. Alice's delegation to him
            expect(messageContents.some((c) => c.includes("can you implement OAuth"))).toBe(true);

            // Bob should NOT see deeper delegation messages yet (they're in the future)
            // But if this was after those events, he would see his own sub-delegation
        });

        it("Diana should see the full delegation chain when responding", async () => {
            const diana: AgentInstance = {
                name: MOCK_AGENTS.diana.name,
                slug: MOCK_AGENTS.diana.slug,
                pubkey: MOCK_AGENTS.diana.pubkey,
                role: "tester",
                instructions: "Test Diana",
                tools: [],
            };

            const mockConversation: Conversation = {
                id: "test-delegation",
                history: events,
                participants: new Set(Object.values(MOCK_AGENTS).map((a) => a.pubkey)),
                agentStates: new Map(),
                metadata: {},
                executionTime: { totalSeconds: 0, isActive: false, lastUpdated: Date.now() },
            } as Conversation;

            // Diana's triggering event is Bob's delegation to her
            const triggeringEvent = events.find((e) => e.id === "bob-delegates-testing")!;

            const mockContext: ExecutionContext = {
                agent: diana,
                conversationId: "test-delegation",
                projectPath: "/test/path",
                triggeringEvent,
                conversationCoordinator: {
                    threadService: new ThreadService(),
                } as any,
                agentPublisher: {} as any,
                getConversation: () => mockConversation,
                isDelegationCompletion: false,
            } as ExecutionContext;

            const messages = await strategy.buildMessages(mockContext, triggeringEvent);
            const messageContents = messages.map((m) =>
                typeof m.content === "string" ? m.content : JSON.stringify(m.content)
            );

            // Diana should see her thread path:
            // Root -> Alice's delegation -> Bob accepts -> Bob delegates to Diana
            expect(messageContents.some((c) => c.includes("user authentication with OAuth"))).toBe(
                true
            );
            expect(messageContents.some((c) => c.includes("can you implement OAuth"))).toBe(true);
            expect(messageContents.some((c) => c.includes("Starting OAuth implementation"))).toBe(
                true
            );
            expect(messageContents.some((c) => c.includes("can you test the OAuth flow"))).toBe(
                true
            );
        });
    });
});
