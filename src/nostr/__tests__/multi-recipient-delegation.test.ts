import { beforeEach, describe, expect, it, mock } from "bun:test";
import NDK, { NDKEvent } from "@nostr-dev-kit/ndk";
import { RelayMock, RelayPoolMock, SignerGenerator, UserGenerator } from "@nostr-dev-kit/ndk/test";
import type { AgentInstance } from "@/agents/types";
import type { ConversationCoordinator } from "@/conversations";
import { DelegationRegistry } from "@/services/DelegationRegistry";
import { AgentEventEncoder } from "../AgentEventEncoder";
import { AgentPublisher } from "../AgentPublisher";
import { NDKKind } from "../kinds";

// Mock logger
mock.module("@/utils/logger", () => ({
    logger: {
        debug: mock(() => {}),
        info: mock(() => {}),
        error: mock(() => {}),
        warn: mock(() => {}),
    },
}));

describe("Multi-Recipient Delegation", () => {
    let ndk: NDK;
    let pool: RelayPoolMock;
    let relay: RelayMock;
    let encoder: AgentEventEncoder;
    let publisher: AgentPublisher;
    let mockAgent: AgentInstance;
    let mockConversationCoordinator: ConversationCoordinator;
    let aliceSigner: any;
    let bobSigner: any;
    let carolSigner: any;

    beforeEach(async () => {
        // Initialize registry
        await DelegationRegistry.initialize();

        // Set up NDK with mock relay infrastructure
        pool = new RelayPoolMock();
        ndk = new NDK({
            explicitRelayUrls: ["wss://relay.test.com"],
        });

        // Replace pool with mock
        // @ts-expect-error - Intentionally replacing for testing
        ndk.pool = pool;

        // Add mock relay
        relay = pool.addMockRelay("wss://relay.test.com");
        relay.connect();

        // Mock getNDK to return our test NDK instance
        mock.module("../ndkClient", () => ({
            getNDK: () => ndk,
        }));

        // Get test users and signers
        const alice = await UserGenerator.getUser("alice", ndk);
        const bob = await UserGenerator.getUser("bob", ndk);
        const carol = await UserGenerator.getUser("carol", ndk);

        aliceSigner = SignerGenerator.getSigner("alice");
        bobSigner = SignerGenerator.getSigner("bob");
        carolSigner = SignerGenerator.getSigner("carol");

        // Create mock agent (alice is the delegating agent)
        mockAgent = {
            name: "Delegating Agent",
            slug: "delegating-agent",
            pubkey: alice.pubkey,
            signer: aliceSigner,
            conversationId: "conv-123",
        } as any;

        // Create mock conversation coordinator
        mockConversationCoordinator = {
            getConversation: mock(() => ({
                id: "conv-123",
                history: [],
                phase: "execute",
            })),
        } as any;

        // Create instances
        encoder = new AgentEventEncoder(mockAgent);
        publisher = new AgentPublisher(mockAgent, mockConversationCoordinator);
    });

    describe("Event Creation", () => {
        it("should create a single event with multiple p-tags", async () => {
            const bob = await UserGenerator.getUser("bob");
            const carol = await UserGenerator.getUser("carol");
            const dave = await UserGenerator.getUser("dave");

            const intent = {
                recipients: [bob.pubkey, carol.pubkey, dave.pubkey],
                request: "Analyze this code and provide feedback",
                phase: "execute",
            };

            // Create proper triggering and root events
            const triggeringEvent = new NDKEvent(ndk);
            triggeringEvent.id = "trigger-event";
            triggeringEvent.kind = NDKKind.GenericReply;
            triggeringEvent.pubkey = "user-pubkey";
            triggeringEvent.tags = [["e", "root-event", "", "root"]];
            triggeringEvent.content = "Please analyze this";

            const rootEvent = new NDKEvent(ndk);
            rootEvent.id = "root-event";
            rootEvent.kind = NDKKind.Conversation;
            rootEvent.pubkey = "user-pubkey";
            rootEvent.tags = [];
            rootEvent.content = "Initial conversation";

            const context = {
                triggeringEvent,
                rootEvent,
                conversationId: "conv-123",
            };

            const events = encoder.encodeDelegation(intent, context);

            // Should create exactly one event
            expect(events).toHaveLength(1);

            const delegationEvent = events[0];

            // Check it has the correct kind
            expect(delegationEvent.kind).toBe(NDKKind.AgentDelegation);

            // Check it has p-tags for all recipients
            const pTags = delegationEvent.tags.filter((tag) => tag[0] === "p");
            expect(pTags).toHaveLength(3);
            expect(pTags.map((t) => t[1])).toContain(bob.pubkey);
            expect(pTags.map((t) => t[1])).toContain(carol.pubkey);
            expect(pTags.map((t) => t[1])).toContain(dave.pubkey);

            // Check content
            expect(delegationEvent.content).toBe("Analyze this code and provide feedback");
        });

        it("should handle empty recipients array", () => {
            const intent = {
                recipients: [],
                request: "This should not delegate to anyone",
                phase: "execute",
            };

            const triggeringEvent = new NDKEvent(ndk);
            triggeringEvent.id = "trigger-event";
            triggeringEvent.kind = NDKKind.GenericReply;

            const context = {
                triggeringEvent,
                rootEvent: triggeringEvent,
                conversationId: "conv-123",
            };

            const events = encoder.encodeDelegation(intent, context);

            expect(events).toHaveLength(1);
            const pTags = events[0].tags.filter((tag) => tag[0] === "p");
            expect(pTags).toHaveLength(0);
        });
    });

    describe("Registry Tracking", () => {
        it("should track delegation in registry", async () => {
            const bob = await UserGenerator.getUser("bob");
            const carol = await UserGenerator.getUser("carol");

            const intent = {
                recipients: [bob.pubkey, carol.pubkey],
                request: "Help with this task",
                phase: "execute",
            };

            const triggeringEvent = new NDKEvent(ndk);
            triggeringEvent.id = "trigger-123";
            triggeringEvent.kind = NDKKind.GenericReply;

            const context = {
                triggeringEvent,
                rootEvent: triggeringEvent,
                conversationId: "conv-123",
            };

            // Encode and sign the delegation
            const events = encoder.encodeDelegation(intent, context);
            const delegationEvent = events[0];
            await SignerGenerator.sign(delegationEvent, "alice");

            // Track in registry
            await DelegationRegistry.trackDelegation(
                delegationEvent.id,
                mockAgent.pubkey,
                [bob.pubkey, carol.pubkey],
                "conv-123",
                delegationEvent
            );

            // Check it's tracked
            const isDelegating = await DelegationRegistry.isDelegating(mockAgent.pubkey, "conv-123");
            expect(isDelegating).toBe(true);

            // Check recipients are tracked
            const delegation = await DelegationRegistry.getActiveDelegation(mockAgent.pubkey, "conv-123");
            expect(delegation).toBeDefined();
            expect(delegation?.recipients).toEqual([bob.pubkey, carol.pubkey]);
        });

        it("should handle completion from any recipient", async () => {
            const bob = await UserGenerator.getUser("bob");
            const carol = await UserGenerator.getUser("carol");

            // Set up delegation
            const delegationEvent = new NDKEvent(ndk);
            delegationEvent.id = "delegation-123";
            delegationEvent.kind = NDKKind.AgentDelegation;
            delegationEvent.pubkey = mockAgent.pubkey;

            await DelegationRegistry.trackDelegation(
                delegationEvent.id,
                mockAgent.pubkey,
                [bob.pubkey, carol.pubkey],
                "conv-123",
                delegationEvent
            );

            // Bob completes the task
            const completionEvent = new NDKEvent(ndk);
            completionEvent.kind = NDKKind.AgentCompletion;
            completionEvent.pubkey = bob.pubkey;
            completionEvent.tags = [
                ["e", "delegation-123", "", "reply"],
                ["p", mockAgent.pubkey],
            ];
            completionEvent.content = "Task completed by Bob";

            // Process completion
            await DelegationRegistry.processCompletion(completionEvent);

            // Delegation should be completed
            const isCompleted = await DelegationRegistry.isCompleted("delegation-123");
            expect(isCompleted).toBe(true);

            // Should no longer be delegating
            const isDelegating = await DelegationRegistry.isDelegating(mockAgent.pubkey, "conv-123");
            expect(isDelegating).toBe(false);
        });
    });

    describe("Relay Simulation", () => {
        it("should simulate multi-recipient delegation flow", async () => {
            const bob = await UserGenerator.getUser("bob");
            const carol = await UserGenerator.getUser("carol");

            const receivedEvents: NDKEvent[] = [];

            // Subscribe to delegation events
            const sub = ndk.subscribe({
                kinds: [NDKKind.AgentDelegation],
                "#p": [bob.pubkey, carol.pubkey],
            });

            sub.on("event", (event: NDKEvent) => {
                receivedEvents.push(event);
            });

            // Create and publish delegation
            const delegationEvent = new NDKEvent(ndk);
            delegationEvent.kind = NDKKind.AgentDelegation;
            delegationEvent.pubkey = mockAgent.pubkey;
            delegationEvent.content = "Please help with this task";
            delegationEvent.tags = [
                ["p", bob.pubkey],
                ["p", carol.pubkey],
            ];
            delegationEvent.created_at = Math.floor(Date.now() / 1000);

            // Sign and simulate relay receiving it
            await SignerGenerator.sign(delegationEvent, "alice");
            relay.simulateEvent(delegationEvent);

            // Both bob and carol should receive it
            expect(receivedEvents).toHaveLength(1);
            expect(receivedEvents[0].kind).toBe(NDKKind.AgentDelegation);

            // Verify the event has both recipients
            const pTags = receivedEvents[0].tags.filter((t) => t[0] === "p");
            expect(pTags.map((t) => t[1])).toContain(bob.pubkey);
            expect(pTags.map((t) => t[1])).toContain(carol.pubkey);
        });

        it("should handle completion events from recipients", async () => {
            const bob = await UserGenerator.getUser("bob");

            // Track a delegation
            await DelegationRegistry.trackDelegation(
                "delegation-456",
                mockAgent.pubkey,
                [bob.pubkey],
                "conv-123",
                new NDKEvent(ndk)
            );

            // Bob sends completion
            const completionEvent = new NDKEvent(ndk);
            completionEvent.kind = NDKKind.AgentCompletion;
            completionEvent.pubkey = bob.pubkey;
            completionEvent.content = "Task is done";
            completionEvent.tags = [
                ["e", "delegation-456", "", "reply"],
                ["p", mockAgent.pubkey],
            ];

            await SignerGenerator.sign(completionEvent, "bob");

            // Simulate relay receiving completion
            relay.simulateEvent(completionEvent);

            // Process the completion
            await DelegationRegistry.processCompletion(completionEvent);

            // Verify delegation is completed
            const isCompleted = await DelegationRegistry.isCompleted("delegation-456");
            expect(isCompleted).toBe(true);
        });
    });
});