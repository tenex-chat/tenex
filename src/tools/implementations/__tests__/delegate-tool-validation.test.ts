import type { ExecutionContext } from "@/agents/execution/types";
import type { AgentInstance } from "@/agents/types";
import { createDelegateTool } from "@/tools/implementations/delegate";
import { createDelegateFollowupTool } from "@/tools/implementations/delegate_followup";
import { createDelegateExternalTool } from "@/tools/implementations/delegate_external";
import { describe, it, expect, spyOn, afterAll } from "bun:test";

// Mock the resolution function to return pubkeys for our test agents
import * as agentResolution from "@/utils/agent-resolution";
const mockResolve = spyOn(agentResolution, "resolveRecipientToPubkey");
mockResolve.mockImplementation((recipient: string) => {
  if (recipient === "self-agent") return "agent-pubkey-123";
  if (recipient === "other-agent") return "other-pubkey-456";
  return recipient.startsWith("agent-pubkey-") ? recipient : null;
});

// Mock parseNostrUser for delegate_external tests
import * as nostrParser from "@/utils/nostr-entity-parser";
const mockParse = spyOn(nostrParser, "parseNostrUser");
mockParse.mockImplementation((recipient: string) => {
  if (recipient === "self-agent") return "agent-pubkey-123";
  if (recipient === "other-agent") return "other-pubkey-456";
  return recipient.startsWith("agent-pubkey-") ? recipient : null;
});

describe("Delegation tools - Self-delegation validation", () => {
  const createMockContext = (): ExecutionContext => ({
    agent: {
      slug: "self-agent",
      name: "Self Agent",
      pubkey: "agent-pubkey-123",
    } as AgentInstance,
    conversationId: "test-conversation-id",
    conversationCoordinator: {} as any,
    triggeringEvent: {} as any,
    agentPublisher: {} as any,
    phase: undefined,
  });

  describe("delegate tool", () => {
    it("should reject self-delegation by slug", async () => {
      const context = createMockContext();
      const delegateTool = createDelegateTool(context);

      const input = {
        recipients: ["self-agent"],
        fullRequest: "Do something",
      };

      try {
        await delegateTool.execute(input);
        expect(true).toBe(false); // Should not reach here
      } catch (error: any) {
        expect(error.message).toContain("Self-delegation is not permitted with the delegate tool");
        expect(error.message).toContain("self-agent");
      }
    });

    it("should reject self-delegation by pubkey", async () => {
      const context = createMockContext();
      const delegateTool = createDelegateTool(context);

      const input = {
        recipients: ["agent-pubkey-123"],
        fullRequest: "Do something",
      };

      try {
        await delegateTool.execute(input);
        expect(true).toBe(false); // Should not reach here
      } catch (error: any) {
        expect(error.message).toContain("Self-delegation is not permitted with the delegate tool");
      }
    });

    it("should reject when self is included in multiple recipients", async () => {
      const context = createMockContext();
      const delegateTool = createDelegateTool(context);

      const input = {
        recipients: ["self-agent", "other-agent"],
        fullRequest: "Do something",
      };

      try {
        await delegateTool.execute(input);
        expect(true).toBe(false); // Should not reach here
      } catch (error: any) {
        expect(error.message).toContain("Self-delegation is not permitted with the delegate tool");
      }
    });
  });

  describe("delegate_followup tool", () => {
    it("should reject self-delegation", async () => {
      const context = createMockContext();
      const followupTool = createDelegateFollowupTool(context);

      const input = {
        recipient: "self-agent",
        message: "Follow-up question",
      };

      try {
        await followupTool.execute(input);
        expect(true).toBe(false); // Should not reach here
      } catch (error: any) {
        expect(error.message).toContain("Self-delegation is not permitted with the delegate_followup tool");
        expect(error.message).toContain("self-agent");
      }
    });
  });

  describe("delegate_external tool", () => {
    it("should reject self-delegation", async () => {
      const context = createMockContext();
      const externalTool = createDelegateExternalTool(context);

      const input = {
        content: "External message",
        recipient: "agent-pubkey-123",
      };

      try {
        await externalTool.execute(input);
        expect(true).toBe(false); // Should not reach here
      } catch (error: any) {
        expect(error.message).toContain("Self-delegation is not permitted with the delegate_external tool");
        expect(error.message).toContain("self-agent");
      }
    });
  });
});

// Restore mocks
afterAll(() => {
  mockResolve.mockRestore();
  mockParse.mockRestore();
});