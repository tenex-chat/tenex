import { describe, expect, it, beforeEach } from "bun:test";
import { AgentConversationContext } from "../AgentConversationContext";
import type { Conversation, AgentState } from "../types";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

describe("Phase Transition Handling", () => {
  let context: AgentConversationContext;
  let conversation: Conversation;
  let agentState: AgentState;

  beforeEach(() => {
    context = new AgentConversationContext(
      "test-conversation",
      "test-agent",
      "test-agent-pubkey"
    );

    agentState = {
      lastProcessedMessageIndex: 0,
    };

    conversation = {
      id: "test-conversation",
      title: "Test Conversation",
      history: [],
      agentStates: new Map(),
      metadata: {},
      executionTime: {
        totalSeconds: 0,
        isActive: false,
        lastUpdated: Date.now(),
      },
    };
  });

  it("should detect and add phase transition system message", async () => {
    // Create events with phase transition
    const event1: NDKEvent = {
      id: "event1",
      pubkey: "user-pubkey",
      kind: 1,
      content: "First message",
      tags: [],
      created_at: 1000,
      sig: "sig1",
    } as NDKEvent;

    const phaseTransitionEvent: NDKEvent = {
      id: "event2",
      pubkey: "agent-pubkey",
      kind: 1,
      content: "Transitioning to planning phase",
      tags: [
        ["phase", "planning"],
        ["phase-instructions", "Focus on creating a detailed technical plan"],
      ],
      created_at: 2000,
      sig: "sig2",
    } as NDKEvent;

    const event3: NDKEvent = {
      id: "event3",
      pubkey: "user-pubkey",
      kind: 1,
      content: "Continue with planning",
      tags: [],
      created_at: 3000,
      sig: "sig3",
    } as NDKEvent;

    conversation.history = [event1, phaseTransitionEvent, event3];

    const messages = await context.buildMessages(
      conversation,
      agentState,
      undefined // No triggering event, process all history
    );

    // Find the phase transition system message
    const phaseTransitionMessage = messages.find(
      msg => msg.role === "system" && msg.content.includes("PHASE TRANSITION: PLANNING")
    );

    expect(phaseTransitionMessage).toBeDefined();
    expect(phaseTransitionMessage?.content).toContain("Focus on creating a detailed technical plan");
    expect(phaseTransitionMessage?.content).toContain("Please adjust your behavior according to the phase requirements");
  });

  it("should handle phase transition without instructions", async () => {
    const phaseTransitionEvent: NDKEvent = {
      id: "event1",
      pubkey: "agent-pubkey",
      kind: 1,
      content: "Moving to execution",
      tags: [
        ["phase", "execution"],
        // No phase-instructions tag
      ],
      created_at: 1000,
      sig: "sig1",
    } as NDKEvent;

    conversation.history = [phaseTransitionEvent];

    const messages = await context.buildMessages(
      conversation,
      agentState,
      undefined
    );

    const phaseTransitionMessage = messages.find(
      msg => msg.role === "system" && msg.content.includes("PHASE TRANSITION: EXECUTION")
    );

    expect(phaseTransitionMessage).toBeDefined();
    expect(phaseTransitionMessage?.content).toContain("Please adjust your behavior according to the phase requirements");
    // Should not have custom instructions
    expect(phaseTransitionMessage?.content).not.toContain("Focus on");
  });

  it("should not add phase transition for events without phase tag", async () => {
    const normalEvent: NDKEvent = {
      id: "event1",
      pubkey: "user-pubkey",
      kind: 1,
      content: "Normal message",
      tags: [
        ["E", "root-id"],
        ["e", "parent-id"],
      ],
      created_at: 1000,
      sig: "sig1",
    } as NDKEvent;

    conversation.history = [normalEvent];

    const messages = await context.buildMessages(
      conversation,
      agentState,
      undefined
    );

    // Should not have any phase transition messages
    const phaseTransitionMessage = messages.find(
      msg => msg.role === "system" && msg.content.includes("PHASE TRANSITION")
    );

    expect(phaseTransitionMessage).toBeUndefined();
  });

  it("should handle multiple phase transitions in conversation history", async () => {
    const phase1Event: NDKEvent = {
      id: "event1",
      pubkey: "agent-pubkey",
      kind: 1,
      content: "Starting planning",
      tags: [
        ["phase", "planning"],
        ["phase-instructions", "Create a plan"],
      ],
      created_at: 1000,
      sig: "sig1",
    } as NDKEvent;

    const phase2Event: NDKEvent = {
      id: "event2",
      pubkey: "agent-pubkey",
      kind: 1,
      content: "Moving to execution",
      tags: [
        ["phase", "execution"],
        ["phase-instructions", "Execute the plan"],
      ],
      created_at: 2000,
      sig: "sig2",
    } as NDKEvent;

    conversation.history = [phase1Event, phase2Event];

    const messages = await context.buildMessages(
      conversation,
      agentState,
      undefined
    );

    // Should have two phase transition messages
    const phaseTransitionMessages = messages.filter(
      msg => msg.role === "system" && msg.content.includes("PHASE TRANSITION")
    );

    expect(phaseTransitionMessages).toHaveLength(2);
    expect(phaseTransitionMessages[0].content).toContain("PHASE TRANSITION: PLANNING");
    expect(phaseTransitionMessages[1].content).toContain("PHASE TRANSITION: EXECUTION");
  });
});