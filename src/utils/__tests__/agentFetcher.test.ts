import { beforeEach, describe, expect, it, mock } from "bun:test";
import NDK, { NDKEvent } from "@nostr-dev-kit/ndk";
import { RelayMock, RelayPoolMock, SignerGenerator, UserGenerator } from "@nostr-dev-kit/ndk/test";
import { fetchAgentDefinition } from "../agentFetcher";

describe("fetchAgentDefinition", () => {
    let ndk: NDK;
    let pool: RelayPoolMock;
    let relay: RelayMock;

    beforeEach(() => {
        // Create mock relay infrastructure
        pool = new RelayPoolMock();
        ndk = new NDK({
            explicitRelayUrls: ["wss://relay.test.com"],
        });

        // Replace the pool with our mock for testing
        // @ts-expect-error - Intentionally replacing for testing
        ndk.pool = pool;

        // Add and connect mock relay
        relay = pool.addMockRelay("wss://relay.test.com");
        relay.connect();
    });

    it("fetches and parses agent definition successfully", async () => {
        // Create a proper agent definition event
        const agentEvent = new NDKEvent(ndk);
        agentEvent.id = "test-event-id";
        agentEvent.pubkey = "test-pubkey";
        agentEvent.created_at = 1234567890;
        agentEvent.kind = 4199; // Agent definition kind
        agentEvent.content = "These are the agent instructions";
        agentEvent.tags = [
            ["title", "Test Agent"],
            ["description", "A test agent for unit testing"],
            ["role", "test-role"],
            ["use-criteria", "Use this agent for testing"],
            ["ver", "2.0.0"],
        ];

        // Mock the fetchEvent method to return our event
        const originalFetchEvent = ndk.fetchEvent.bind(ndk);
        ndk.fetchEvent = mock(async (filter) => {
            // Check if it's fetching the right event
            if (typeof filter === "object" && "ids" in filter && filter.ids?.[0] === "test-event-id") {
                return agentEvent;
            }
            return originalFetchEvent(filter);
        });

        const result = await fetchAgentDefinition("test-event-id", ndk);

        expect(result).toEqual({
            id: "test-event-id",
            title: "Test Agent",
            description: "A test agent for unit testing",
            role: "test-role",
            instructions: "These are the agent instructions",
            useCriteria: "Use this agent for testing",
            version: "2.0.0",
            created_at: 1234567890,
            pubkey: "test-pubkey",
        });

        expect(ndk.fetchEvent).toHaveBeenCalled();
    });

    it("returns null when event is not found", async () => {
        // Mock fetchEvent to return null
        ndk.fetchEvent = mock(async () => null);

        const result = await fetchAgentDefinition("non-existent-id", ndk);

        expect(result).toBeNull();
    });

    it("handles missing tags with default values", async () => {
        // Create event with no tags
        const agentEvent = new NDKEvent(ndk);
        agentEvent.id = "test-event-id";
        agentEvent.pubkey = "test-pubkey";
        agentEvent.created_at = 1234567890;
        agentEvent.kind = 4199;
        agentEvent.content = "";
        agentEvent.tags = [];

        ndk.fetchEvent = mock(async () => agentEvent);

        const result = await fetchAgentDefinition("test-event-id", ndk);

        expect(result).toEqual({
            id: "test-event-id",
            title: "Unnamed Agent",
            description: "",
            role: "assistant",
            instructions: "",
            useCriteria: "",
            version: "1.0.0",
            created_at: 1234567890,
            pubkey: "test-pubkey",
        });
    });

    it("handles partial tags correctly", async () => {
        const agentEvent = new NDKEvent(ndk);
        agentEvent.id = "test-event-id";
        agentEvent.pubkey = "test-pubkey";
        agentEvent.created_at = 1234567890;
        agentEvent.kind = 4199;
        agentEvent.content = "These are the agent instructions";
        agentEvent.tags = [
            ["title", "Partial Agent"],
            ["role", "custom-role"],
        ];

        ndk.fetchEvent = mock(async () => agentEvent);

        const result = await fetchAgentDefinition("test-event-id", ndk);

        expect(result).toEqual({
            id: "test-event-id",
            title: "Partial Agent",
            description: "",
            role: "custom-role",
            instructions: "These are the agent instructions",
            useCriteria: "",
            version: "1.0.0",
            created_at: 1234567890,
            pubkey: "test-pubkey",
        });
    });

    it("handles fetch errors gracefully", async () => {
        // Mock fetchEvent to throw an error
        ndk.fetchEvent = mock(async () => {
            throw new Error("Network error");
        });

        const result = await fetchAgentDefinition("test-event-id", ndk);

        expect(result).toBeNull();
    });

    it("handles undefined created_at", async () => {
        const agentEvent = new NDKEvent(ndk);
        agentEvent.id = "test-event-id";
        agentEvent.pubkey = "test-pubkey";
        agentEvent.created_at = undefined;
        agentEvent.kind = 4199;
        agentEvent.content = "Instructions";
        agentEvent.tags = [["title", "Test Agent"]];

        ndk.fetchEvent = mock(async () => agentEvent);

        const result = await fetchAgentDefinition("test-event-id", ndk);

        expect(result).toBeDefined();
        expect(result?.created_at).toBeUndefined();
    });

    it("can simulate receiving agent event from relay", async () => {
        // This demonstrates using relay simulation
        const agentEvent = new NDKEvent(ndk);
        agentEvent.id = "agent-from-relay";
        agentEvent.pubkey = "agent-author";
        agentEvent.created_at = Date.now() / 1000;
        agentEvent.kind = 4199;
        agentEvent.content = "Agent instructions from relay";
        agentEvent.tags = [
            ["title", "Relay Agent"],
            ["description", "Agent received from relay"],
        ];

        // Set up subscription to catch the event
        let receivedEvent: NDKEvent | null = null;
        const sub = ndk.subscribe({ kinds: [4199], ids: ["agent-from-relay"] });
        sub.on("event", (event: NDKEvent) => {
            receivedEvent = event;
        });

        // Simulate the relay sending the event
        relay.simulateEvent(agentEvent);

        // Verify we received it
        expect(receivedEvent).toBeDefined();
        expect(receivedEvent?.id).toBe("agent-from-relay");
        expect(receivedEvent?.tags.find((t) => t[0] === "title")?.[1]).toBe("Relay Agent");
    });
});