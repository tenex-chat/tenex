/**
 * Example of using NDK test utilities in a real test scenario
 * This demonstrates how to replace custom mocks with NDK's testing infrastructure
 */

import { beforeEach, describe, expect, it } from "bun:test";
import NDK, { NDKEvent } from "@nostr-dev-kit/ndk";
import {
    EventGenerator,
    RelayMock,
    RelayPoolMock,
    SignerGenerator,
    UserGenerator,
} from "@nostr-dev-kit/ndk/test";

describe("Using NDK Test Utilities - Practical Example", () => {
    let ndk: NDK;
    let pool: RelayPoolMock;
    let relay: RelayMock;

    beforeEach(async () => {
        // Create a mock relay pool
        pool = new RelayPoolMock();

        // Create NDK instance
        ndk = new NDK({
            explicitRelayUrls: ["wss://relay.test.com"],
        });

        // Replace the pool with our mock (for testing only)
        // @ts-expect-error - Intentionally replacing pool for testing
        ndk.pool = pool;

        // Add a mock relay
        relay = pool.addMockRelay("wss://relay.test.com");
        relay.connect();
    });

    it("should create events with deterministic test users", async () => {
        // Get test users - these always have the same keys
        const alice = await UserGenerator.getUser("alice", ndk);
        const bob = await UserGenerator.getUser("bob", ndk);

        // Create and sign an event from Alice
        const event = new NDKEvent(ndk);
        event.kind = 1; // Text note
        event.content = "Hello from Alice!";
        event.pubkey = alice.pubkey;
        event.created_at = Math.floor(Date.now() / 1000);
        event.tags = [["p", bob.pubkey]]; // Mention Bob

        // Sign with Alice's deterministic key
        const aliceSigner = SignerGenerator.getSigner("alice");
        await event.sign(aliceSigner);

        expect(event.sig).toBeDefined();
        expect(event.sig.length).toBeGreaterThan(0);
        expect(event.pubkey).toBe(alice.pubkey);
        expect(event.tags[0][1]).toBe(bob.pubkey);
    });

    it("should simulate receiving events from relays", async () => {
        const receivedEvents: NDKEvent[] = [];

        // Subscribe to text notes
        const sub = ndk.subscribe({ kinds: [1], limit: 10 });
        sub.on("event", (event: NDKEvent) => {
            receivedEvents.push(event);
        });

        // Generate and simulate events being received from the relay
        const alice = await UserGenerator.getUser("alice", ndk);
        const generator = new EventGenerator(ndk);

        // Create a test event
        const testEvent = new NDKEvent(ndk);
        testEvent.kind = 1;
        testEvent.content = "Test message from Alice";
        testEvent.pubkey = alice.pubkey;
        testEvent.created_at = Math.floor(Date.now() / 1000);
        testEvent.id = "test-event-id-123";
        testEvent.tags = [];

        // Simulate the relay sending this event
        relay.simulateEvent(testEvent);

        // Verify the event was received
        expect(receivedEvents.length).toBe(1);
        expect(receivedEvents[0].content).toBe("Test message from Alice");
        expect(receivedEvents[0].pubkey).toBe(alice.pubkey);
    });

    it("should handle multi-relay scenarios", async () => {
        // Add multiple mock relays
        const relay2 = pool.addMockRelay("wss://relay2.test.com");
        const relay3 = pool.addMockRelay("wss://relay3.test.com");

        relay2.connect();
        relay3.connect();

        const receivedEvents = new Set<string>();

        // Subscribe to events
        const sub = ndk.subscribe({ kinds: [1] });
        sub.on("event", (event: NDKEvent) => {
            receivedEvents.add(event.id);
        });

        // Create an event
        const event = new NDKEvent(ndk);
        event.kind = 1;
        event.content = "Multi-relay test";
        event.id = "unique-event-id";
        event.created_at = Math.floor(Date.now() / 1000);

        // Simulate the same event being received from multiple relays
        relay.simulateEvent(event);
        relay2.simulateEvent(event);
        relay3.simulateEvent(event);

        // Should only receive the event once (deduplicated)
        expect(receivedEvents.size).toBe(1);
        expect(receivedEvents.has("unique-event-id")).toBe(true);
    });

    it("should simulate EOSE (End of Stored Events)", async () => {
        let eoseReceived = false;

        // Subscribe with a handler for EOSE
        const sub = ndk.subscribe({ kinds: [1], since: Math.floor(Date.now() / 1000) - 3600 });
        sub.on("eose", () => {
            eoseReceived = true;
        });

        // Simulate some events
        const event1 = new NDKEvent(ndk);
        event1.kind = 1;
        event1.content = "Event 1";
        event1.id = "event-1";
        relay.simulateEvent(event1);

        const event2 = new NDKEvent(ndk);
        event2.kind = 1;
        event2.content = "Event 2";
        event2.id = "event-2";
        relay.simulateEvent(event2);

        // Simulate EOSE - relay has sent all stored events
        relay.simulateEOSE(sub.subscriptionId);

        expect(eoseReceived).toBe(true);
    });

    it("should create conversation threads with proper reply tags", async () => {
        const alice = await UserGenerator.getUser("alice");
        const bob = await UserGenerator.getUser("bob");

        // Create root message from Alice
        const rootEvent = new NDKEvent(ndk);
        rootEvent.kind = 1;
        rootEvent.content = "Starting a conversation";
        rootEvent.pubkey = alice.pubkey;
        rootEvent.id = "root-event-id";
        rootEvent.created_at = Math.floor(Date.now() / 1000);

        // Create reply from Bob
        const replyEvent = new NDKEvent(ndk);
        replyEvent.kind = 1;
        replyEvent.content = "Replying to Alice";
        replyEvent.pubkey = bob.pubkey;
        replyEvent.created_at = Math.floor(Date.now() / 1000) + 10;
        replyEvent.tags = [
            ["e", rootEvent.id, "", "reply"],
            ["p", alice.pubkey],
        ];

        // Sign the events
        await SignerGenerator.sign(rootEvent, "alice");
        await SignerGenerator.sign(replyEvent, "bob");

        expect(rootEvent.sig).toBeDefined();
        expect(replyEvent.sig).toBeDefined();
        expect(replyEvent.tags[0][1]).toBe(rootEvent.id);
        expect(replyEvent.tags[0][3]).toBe("reply");
    });
});

/**
 * Migration Guide: Converting Tests to Use NDK Test Utilities
 *
 * 1. **Replace custom NDKEvent mocks** with actual NDKEvent + RelayPoolMock
 * 2. **Use deterministic test users** (alice, bob, carol, dave, eve) instead of random pubkeys
 * 3. **Simulate relay behavior** instead of mocking network calls
 * 4. **Use EventGenerator** for creating standard event types
 * 5. **Use TimeController** for time-dependent tests (not shown here)
 *
 * Benefits:
 * - More realistic testing (using actual NDK classes)
 * - Consistent test data (deterministic users)
 * - Better simulation of relay behavior
 * - Less custom mock code to maintain
 * - Aligned with NDK's own testing practices
 */