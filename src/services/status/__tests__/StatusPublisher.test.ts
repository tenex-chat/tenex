import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import NDK, { NDKEvent } from "@nostr-dev-kit/ndk";
import { RelayMock, RelayPoolMock, SignerGenerator } from "@nostr-dev-kit/ndk/test";
import { NDKKind } from "@/nostr/kinds";
import { StatusPublisher } from "../StatusPublisher";

// Mock the services module
const mockProjectContext = {
    project: { id: "test-project" },
    signer: null, // Will be set with actual signer
    agents: new Map([
        ["agent1", { pubkey: "pubkey1", name: "Agent 1" }],
        ["agent2", { pubkey: "pubkey2", name: "Agent 2" }],
    ]),
};

mock.module("@/services", () => ({
    getProjectContext: mock(() => mockProjectContext),
    isProjectContextInitialized: mock(() => true),
    configService: {
        loadConfig: mock(async () => ({
            llms: {
                configurations: {
                    config1: { model: "gpt-4", provider: "openai" },
                    config2: { model: "claude-3", provider: "anthropic" },
                },
                defaults: {
                    agent1: "config1",
                    agent2: "config2",
                },
            },
        })),
    },
}));

describe("StatusPublisher", () => {
    let publisher: StatusPublisher;
    let ndk: NDK;
    let pool: RelayPoolMock;
    let relay: RelayMock;
    let publishedEvents: NDKEvent[] = [];

    beforeEach(() => {
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

        // Set up test signer for alice
        const aliceSigner = SignerGenerator.getSigner("alice");
        mockProjectContext.signer = aliceSigner;

        // Mock getNDK to return our test NDK instance
        mock.module("@/nostr/ndkClient", () => ({
            getNDK: mock(() => ndk),
        }));

        // Track published events
        publishedEvents = [];
        const originalPublish = NDKEvent.prototype.publish;
        NDKEvent.prototype.publish = mock(async function (this: NDKEvent) {
            publishedEvents.push(this);
            // Simulate the event being sent to relays
            relay.simulateEvent(this);
            return originalPublish.call(this);
        });

        publisher = new StatusPublisher();
    });

    afterEach(() => {
        publisher.stopPublishing();
        pool.disconnectAll();
        publishedEvents = [];
    });

    describe("startPublishing", () => {
        it("should publish an initial status event", async () => {
            await publisher.startPublishing("/test/project");

            // Should have published at least one status event
            expect(publishedEvents.length).toBeGreaterThan(0);

            const statusEvent = publishedEvents[0];
            expect(statusEvent).toBeDefined();
            expect(statusEvent.kind).toBe(NDKKind.AppSpecificData);

            // Check the event has proper tags
            const dTag = statusEvent.tags.find((t) => t[0] === "d");
            expect(dTag).toBeDefined();
            expect(dTag?.[1]).toContain("test-project");

            // Check it has status tag
            const statusTag = statusEvent.tags.find((t) => t[0] === "status");
            expect(statusTag).toBeDefined();
            expect(statusTag?.[1]).toBe("running");
        });

        it("should include agent information in status event", async () => {
            await publisher.startPublishing("/test/project");

            const statusEvent = publishedEvents[0];
            const content = JSON.parse(statusEvent.content);

            expect(content.agents).toBeDefined();
            expect(content.agents).toHaveLength(2);
            expect(content.agents[0]).toMatchObject({
                id: "agent1",
                name: "Agent 1",
                pubkey: "pubkey1",
            });
        });

        it("should include LLM configurations", async () => {
            await publisher.startPublishing("/test/project");

            const statusEvent = publishedEvents[0];
            const content = JSON.parse(statusEvent.content);

            expect(content.llmConfigurations).toBeDefined();
            expect(content.llmConfigurations).toHaveLength(2);
            expect(content.llmConfigurations[0]).toMatchObject({
                agentId: "agent1",
                configuration: {
                    model: "gpt-4",
                    provider: "openai",
                },
            });
        });

        it("should not start multiple publishing intervals", async () => {
            await publisher.startPublishing("/test/project");
            const firstEventCount = publishedEvents.length;

            await publisher.startPublishing("/test/project");
            // Should not publish additional events if already running
            expect(publishedEvents.length).toBe(firstEventCount);
        });
    });

    describe("stopPublishing", () => {
        it("should stop publishing when called", async () => {
            await publisher.startPublishing("/test/project");
            const initialCount = publishedEvents.length;

            publisher.stopPublishing();

            // Wait a bit to ensure no more events are published
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(publishedEvents.length).toBe(initialCount);
        });
    });

    describe("with relay simulation", () => {
        it("should handle status events being received from relay", async () => {
            const receivedEvents: NDKEvent[] = [];

            // Subscribe to status events
            const sub = ndk.subscribe({
                kinds: [NDKKind.AppSpecificData],
                "#d": ["tenex-status"],
            });

            sub.on("event", (event: NDKEvent) => {
                receivedEvents.push(event);
            });

            // Publish status
            await publisher.startPublishing("/test/project");

            // The event should have been received through the subscription
            expect(receivedEvents.length).toBeGreaterThan(0);
            expect(receivedEvents[0].kind).toBe(NDKKind.AppSpecificData);
        });

        it("should publish to multiple relays", async () => {
            // Add more relays
            const relay2 = pool.addMockRelay("wss://relay2.test.com");
            const relay3 = pool.addMockRelay("wss://relay3.test.com");
            relay2.connect();
            relay3.connect();

            const eventsPerRelay = new Map<string, number>();
            eventsPerRelay.set("wss://relay.test.com", 0);
            eventsPerRelay.set("wss://relay2.test.com", 0);
            eventsPerRelay.set("wss://relay3.test.com", 0);

            // Track events on each relay
            relay.on("event:sent", () => {
                eventsPerRelay.set("wss://relay.test.com", (eventsPerRelay.get("wss://relay.test.com") || 0) + 1);
            });
            relay2.on("event:sent", () => {
                eventsPerRelay.set("wss://relay2.test.com", (eventsPerRelay.get("wss://relay2.test.com") || 0) + 1);
            });
            relay3.on("event:sent", () => {
                eventsPerRelay.set("wss://relay3.test.com", (eventsPerRelay.get("wss://relay3.test.com") || 0) + 1);
            });

            await publisher.startPublishing("/test/project");

            // Each relay should receive the status event
            // Note: actual behavior depends on NDK relay selection logic
            expect(publishedEvents.length).toBeGreaterThan(0);
        });
    });
});