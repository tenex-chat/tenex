import { beforeEach, describe, expect, mock, test } from "bun:test";
import type NDK from "@nostr-dev-kit/ndk";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { fetchAgentDefinition } from "../agentFetcher";

describe("fetchAgentDefinition", () => {
  let mockNdk: NDK;
  let mockEvent: NDKEvent;

  beforeEach(() => {
    // Create a mock NDKEvent
    mockEvent = new NDKEvent();
    mockEvent.id = "test-event-id";
    mockEvent.pubkey = "test-pubkey";
    mockEvent.created_at = 1234567890;
    mockEvent.content = "These are the agent instructions";
    mockEvent.tags = [
      ["title", "Test Agent"],
      ["description", "A test agent for unit testing"],
      ["role", "test-role"],
      ["use-criteria", "Use this agent for testing"],
      ["ver", "2.0.0"],
    ];

    // Create mock NDK instance
    mockNdk = {
      fetchEvent: mock(() => Promise.resolve(mockEvent)),
    } as unknown as NDK;
  });

  test("fetches and parses agent definition successfully", async () => {
    const result = await fetchAgentDefinition("test-event-id", mockNdk);

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

    expect(mockNdk.fetchEvent).toHaveBeenCalledWith(
      {
        ids: ["test-event-id"],
        kinds: [4199],
      },
      {
        closeOnEose: true,
        groupable: false,
      }
    );
  });

  test("returns null when event is not found", async () => {
    mockNdk.fetchEvent = mock(() => Promise.resolve(null));

    const result = await fetchAgentDefinition("non-existent-id", mockNdk);

    expect(result).toBeNull();
  });

  test("handles missing tags with default values", async () => {
    mockEvent.tags = [];
    mockEvent.content = "";

    const result = await fetchAgentDefinition("test-event-id", mockNdk);

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

  test("handles partial tags correctly", async () => {
    mockEvent.tags = [
      ["title", "Partial Agent"],
      ["role", "custom-role"],
    ];

    const result = await fetchAgentDefinition("test-event-id", mockNdk);

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

  test("handles fetch errors gracefully", async () => {
    mockNdk.fetchEvent = mock(() => Promise.reject(new Error("Network error")));

    const result = await fetchAgentDefinition("test-event-id", mockNdk);

    expect(result).toBeNull();
  });

  test("handles undefined created_at", async () => {
    mockEvent.created_at = undefined;

    const result = await fetchAgentDefinition("test-event-id", mockNdk);

    expect(result).toBeDefined();
    expect(result?.created_at).toBeUndefined();
  });
});
