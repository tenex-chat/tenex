import { NDKEvent } from "@nostr-dev-kit/ndk";
import { describe, expect, it, mock } from "bun:test";
import type { ExecutionContext } from "../../types";
import { delegateExternalTool } from "../delegate_external";

// Mock dependencies
const mockFetchEvent = mock();
const mockSign = mock();
const mockPublish = mock();
const mockReply = mock();

mock.module("@/nostr/ndkClient", () => ({
  getNDK: mock(() => ({
    fetchEvent: mockFetchEvent,
  })),
}));

mock.module("@/nostr/AgentPublisher", () => ({
  AgentPublisher: class {
    conversation = mock();
  },
}));

describe("delegate_external tool", () => {
  const mockContext: ExecutionContext = {
    agent: {
      name: "test-agent",
      pubkey: "test-pubkey",
      signer: {
        sign: mockSign,
        pubkey: "test-pubkey",
      } as any,
    } as any,
    phase: "planning",
    conversationId: "conv-123",
    conversationCoordinator: {
      getConversation: mock(() => ({
        history: [{ id: "root-event-123" }],
      })),
    } as any,
    triggeringEvent: {} as any,
  };

  it("should have correct metadata", () => {
    expect(delegateExternalTool.name).toBe("delegate_external");
    expect(delegateExternalTool.description).toContain("Delegate a task to an external agent");
  });

  it("should validate input schema", () => {
    const validInput = {
      content: "Hello world",
      recipient: "pubkey123",
    };

    const result = delegateExternalTool.parameters.validate(validInput);
    expect(result.ok).toBe(true);
  });

  it("should handle optional parentEventId", () => {
    const inputWithParent = {
      content: "Reply message",
      parentEventId: "event123",
      recipient: "pubkey456",
    };

    const result = delegateExternalTool.parameters.validate(inputWithParent);
    expect(result.ok).toBe(true);
  });

  it("should handle optional projectId", () => {
    const inputWithProject = {
      content: "Message with project",
      recipient: "pubkey789",
      projectId: "naddr1xyz",
    };

    const result = delegateExternalTool.parameters.validate(inputWithProject);
    expect(result.ok).toBe(true);
  });

  it("should strip nostr: prefix from IDs", async () => {
    const mockNDK = {
      fetchEvent: mockFetchEvent,
    };
    
    const mockParentEvent = {
      id: "parent123",
      reply: mockReply.mockImplementation(async () => {
        const event = new NDKEvent(mockNDK as any, { kind: 1111, content: "", tags: [] });
        event.sign = mockSign;
        event.publish = mockPublish;
        return event;
      }),
    };
    
    mockFetchEvent.mockImplementation((id: string) => {
      if (id === "parent123") return Promise.resolve(mockParentEvent);
      return Promise.resolve(null);
    });

    const input = {
      content: "Test reply",
      parentEventId: "nostr:parent123", // Has nostr: prefix
      recipient: "recipientPubkey",
    };

    const validatedInput = delegateExternalTool.parameters.validate(input);
    if (!validatedInput.ok) {
      throw new Error("Input validation failed");
    }

    const result = await delegateExternalTool.execute(validatedInput.value, mockContext);
    
    // Check that fetchEvent was called with the ID without the prefix
    expect(mockFetchEvent).toHaveBeenCalledWith("parent123");
  });
});