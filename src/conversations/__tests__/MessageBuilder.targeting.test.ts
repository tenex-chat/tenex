import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { MessageBuilder } from "../MessageBuilder";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import type { AgentInstance } from "@/agents/types";

// Mock the modules before importing them
mock.module("@/services", () => ({
  getProjectContext: mock(() => ({})),
  isProjectContextInitialized: mock(() => true)
}));

mock.module("@/services/PubkeyNameRepository", () => ({
  getPubkeyNameRepository: mock(() => ({
    getName: mock(async (pubkey: string) => {
      // Return "TestUser" for user pubkeys, otherwise return the agent slug
      if (pubkey === "user-pubkey") return "TestUser";
      return "User";
    }),
    getNameSync: mock((pubkey: string) => {
      if (pubkey === "user-pubkey") return "TestUser";
      return "User";
    })
  }))
}));

mock.module("@/nostr", () => ({
  getNDK: mock(() => ({
    fetchEvent: mock(() => null)
  }))
}));

mock.module("@/utils/logger", () => ({
  logger: {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {})
  }
}));

// Now import after mocking
import { getProjectContext, isProjectContextInitialized } from "@/services";
import { getPubkeyNameRepository } from "@/services/PubkeyNameRepository";

describe("MessageBuilder - Message Targeting", () => {
  let messageBuilder: MessageBuilder;
  let mockProjectContext: any;
  
  beforeEach(() => {
    messageBuilder = new MessageBuilder();
    
    // Setup mock project context with agents
    mockProjectContext = {
      pubkey: "project-pubkey",
      agents: new Map<string, AgentInstance>([
        ["code-writer", {
          name: "Code Writer",
          slug: "code-writer",
          pubkey: "agent1-pubkey",
          instructions: "",
          tools: []
        }],
        ["reviewer", {
          name: "Code Reviewer",
          slug: "reviewer",
          pubkey: "agent2-pubkey",
          instructions: "",
          tools: []
        }],
        ["project-manager", {
          name: "Project Manager",
          slug: "project-manager",
          pubkey: "agent3-pubkey",
          instructions: "",
          tools: []
        }]
      ])
    };
    
    // Override the mocked functions
    (getProjectContext as any).mockImplementation(() => mockProjectContext);
    (isProjectContextInitialized as any).mockImplementation(() => true);
  });

  // Helper to create NDKEvent with proper getMatchingTags method
  const createEvent = (pubkey: string, tags: string[][] = []) => {
    const event = new NDKEvent();
    event.pubkey = pubkey;
    event.tags = tags;
    event.getMatchingTags = (tag: string) => event.tags.filter(t => t[0] === tag);
    return event;
  };
  
  describe("User message targeting", () => {
    it("should format broadcast message as 'user' role for all agents", async () => {
      const event = createEvent("user-pubkey", []); // No p-tags means broadcast
      
      const message = await messageBuilder.formatEventAsMessage(
        event,
        "Hello everyone",
        "code-writer"
      );
      
      expect(message.role).toBe("user");
      expect(message.content).toBe("Hello everyone");
    });
    
    it("should format targeted message as 'user' role for the targeted agent", async () => {
      const event = createEvent("user-pubkey", [
        ["p", "agent1-pubkey"] // Targeting code-writer
      ]);
      
      const message = await messageBuilder.formatEventAsMessage(
        event,
        "Please write some code",
        "code-writer"
      );
      
      expect(message.role).toBe("user");
      expect(message.content).toBe("Please write some code");
    });
    
    it("should format targeted message as 'system' role for non-targeted agents", async () => {
      const event = createEvent("user-pubkey", [
        ["p", "agent1-pubkey"] // Targeting code-writer
      ]);
      
      const message = await messageBuilder.formatEventAsMessage(
        event,
        "Please write some code",
        "reviewer" // Different agent viewing the message
      );
      
      expect(message.role).toBe("system");
      expect(message.content).toBe("[TestUser → code-writer]: Please write some code");
    });
    
    it("should handle multiple targeted agents", async () => {
      const event = createEvent("user-pubkey", [
        ["p", "agent1-pubkey"], // code-writer
        ["p", "agent2-pubkey"]  // reviewer
      ]);
      
      // For a targeted agent
      const message1 = await messageBuilder.formatEventAsMessage(
        event,
        "Please collaborate on this",
        "code-writer"
      );
      
      expect(message1.role).toBe("user");
      expect(message1.content).toBe("Please collaborate on this");
      
      // For a non-targeted agent
      const message2 = await messageBuilder.formatEventAsMessage(
        event,
        "Please collaborate on this",
        "project-manager"
      );
      
      expect(message2.role).toBe("system");
      expect(message2.content).toBe("[TestUser → code-writer, reviewer]: Please collaborate on this");
    });
    
    it("should handle p-tags for non-agent entities gracefully", async () => {
      const event = createEvent("user-pubkey", [
        ["p", "random-pubkey"], // Not an agent
        ["p", "agent1-pubkey"]  // code-writer
      ]);
      
      const message = await messageBuilder.formatEventAsMessage(
        event,
        "Mixed p-tags message",
        "reviewer"
      );
      
      // Should only show the agent that was targeted
      expect(message.role).toBe("system");
      expect(message.content).toBe("[TestUser → code-writer]: Mixed p-tags message");
    });
  });
  
  describe("Agent message formatting", () => {
    it("should format agent's own message as 'assistant' role", async () => {
      const event = createEvent("agent1-pubkey", []); // code-writer's pubkey
      
      const message = await messageBuilder.formatEventAsMessage(
        event,
        "I've written the code",
        "code-writer"
      );
      
      expect(message.role).toBe("assistant");
      expect(message.content).toBe("I've written the code");
    });
    
    it("should format broadcast agent message as 'system' role with attribution", async () => {
      const event = createEvent("agent1-pubkey", []); // code-writer's pubkey, no p-tags (broadcast)
      
      const message = await messageBuilder.formatEventAsMessage(
        event,
        "I've written the code",
        "reviewer" // Different agent viewing
      );
      
      expect(message.role).toBe("system");
      expect(message.content).toBe("[code-writer]: I've written the code");
    });
    
    it("should format targeted agent-to-agent message as 'user' role for recipient", async () => {
      const event = createEvent("agent1-pubkey", [
        ["p", "agent2-pubkey"] // code-writer targeting reviewer
      ]);
      
      const message = await messageBuilder.formatEventAsMessage(
        event,
        "Can you review this code?",
        "reviewer" // Targeted agent viewing
      );
      
      expect(message.role).toBe("user");
      expect(message.content).toBe("[code-writer → @reviewer]: Can you review this code?");
    });
    
    it("should format targeted agent-to-agent message as 'system' role for non-recipient", async () => {
      const event = createEvent("agent1-pubkey", [
        ["p", "agent2-pubkey"] // code-writer targeting reviewer
      ]);
      
      const message = await messageBuilder.formatEventAsMessage(
        event,
        "Can you review this code?",
        "project-manager" // Non-targeted agent observing
      );
      
      expect(message.role).toBe("system");
      expect(message.content).toBe("[code-writer → reviewer]: Can you review this code?");
    });
    
    it("should handle multiple targeted agents in agent-to-agent messages", async () => {
      const event = createEvent("agent1-pubkey", [
        ["p", "agent2-pubkey"], // reviewer
        ["p", "agent3-pubkey"]  // project-manager
      ]);
      
      // For one of the targeted agents
      const message1 = await messageBuilder.formatEventAsMessage(
        event,
        "Need input from both of you",
        "reviewer"
      );
      
      expect(message1.role).toBe("user");
      expect(message1.content).toBe("[code-writer → @reviewer]: Need input from both of you");
      
      // For the other targeted agent
      const message2 = await messageBuilder.formatEventAsMessage(
        event,
        "Need input from both of you",
        "project-manager"
      );
      
      expect(message2.role).toBe("user");
      expect(message2.content).toBe("[code-writer → @project-manager]: Need input from both of you");
    });
  });
  
  describe("Edge cases", () => {
    it("should handle events with no pubkey", async () => {
      const event = createEvent("", []); // Empty pubkey
      event.pubkey = undefined as any; // Force undefined
      
      const message = await messageBuilder.formatEventAsMessage(
        event,
        "Anonymous message",
        "code-writer"
      );
      
      // Should treat as user message (fallback)
      expect(message.role).toBe("user");
      expect(message.content).toBe("Anonymous message");
    });
    
    it("should handle unknown non-user pubkeys gracefully", async () => {
      const event = createEvent("unknown-agent-pubkey", []);
      
      const message = await messageBuilder.formatEventAsMessage(
        event,
        "Message from unknown",
        "code-writer"
      );
      
      // Unknown pubkeys are treated as users (since isEventFromUser returns true for non-agent pubkeys)
      expect(message.role).toBe("user");
      expect(message.content).toBe("Message from unknown");
    });
  });
});