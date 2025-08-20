/**
 * NDK Test Utilities Integration
 * 
 * This module provides access to NDK's comprehensive testing utilities
 * for more robust testing of Nostr protocol interactions.
 */

import {
  RelayMock,
  RelayPoolMock,
  EventGenerator,
  TestFixture,
  TestEventFactory,
  UserGenerator,
  SignerGenerator,
  TimeController,
  withTimeControl,
  mockNutzap,
  mockProof,
  type Proof
} from "@nostr-dev-kit/ndk/test";

import { NDK } from "@nostr-dev-kit/ndk";
import type { NDKEvent, NDKUser } from "@nostr-dev-kit/ndk";

/**
 * Test user names available from NDK's deterministic user generator
 */
export type TestUserName = "alice" | "bob" | "carol" | "dave" | "eve";

/**
 * Extended test fixture for TENEX that combines NDK's testing utilities
 * with TENEX-specific testing needs
 */
export class TENEXTestFixture extends TestFixture {
  private relayMocks: Map<string, RelayMock> = new Map();
  
  constructor() {
    super();
    // Initialize NDK with test configuration
    this.ndk.explicitRelayUrls = ["wss://test.relay"];
  }

  /**
   * Create a mock relay with configurable behavior
   */
  createMockRelay(url = "wss://test.relay", options?: {
    simulateDisconnect?: boolean;
    disconnectAfter?: number;
    connectionDelay?: number;
    autoConnect?: boolean;
    failNextPublish?: boolean;
  }): RelayMock {
    const relay = new RelayMock(url, options);
    this.relayMocks.set(url, relay);
    return relay;
  }

  /**
   * Get or create a mock relay
   */
  getMockRelay(url = "wss://test.relay"): RelayMock {
    if (!this.relayMocks.has(url)) {
      return this.createMockRelay(url);
    }
    return this.relayMocks.get(url)!;
  }

  /**
   * Create an agent event for testing
   */
  async createAgentEvent(
    agent: TestUserName | NDKUser,
    content: string,
    kind = 8000, // Agent-specific kind
    tags: string[][] = []
  ): Promise<NDKEvent> {
    let agentUser: NDKUser;
    
    if (typeof agent === "string") {
      agentUser = await this.getUser(agent);
    } else {
      agentUser = agent;
    }

    const event = await this.eventFactory.createSignedTextNote(
      content,
      agent,
      kind
    );
    
    // Add agent-specific tags
    event.tags = [
      ...event.tags,
      ...tags,
      ["client", "tenex"],
      ["version", "1.0.0"]
    ];
    
    return event;
  }

  /**
   * Create a conversation thread between users and agents
   */
  async createConversationThread(
    initialMessage: { author: TestUserName; content: string },
    replies: Array<{ author: TestUserName; content: string; isAgent?: boolean }>
  ): Promise<NDKEvent[]> {
    const events: NDKEvent[] = [];
    
    // Create initial message
    const initialEvent = await this.eventFactory.createSignedTextNote(
      initialMessage.content,
      initialMessage.author
    );
    events.push(initialEvent);
    
    // Create replies
    let parentEvent = initialEvent;
    for (const reply of replies) {
      const replyEvent = reply.isAgent
        ? await this.createAgentEvent(reply.author, reply.content, 8001, [
            ["e", parentEvent.id || "", "", "reply"],
            ["p", parentEvent.pubkey]
          ])
        : await this.eventFactory.createReply(
            parentEvent,
            reply.content,
            reply.author
          );
      
      events.push(replyEvent);
      parentEvent = replyEvent;
    }
    
    return events;
  }

  /**
   * Simulate relay communication for an event
   */
  async simulateRelayInteraction(
    event: NDKEvent,
    relayUrl = "wss://test.relay"
  ): Promise<void> {
    const relay = this.getMockRelay(relayUrl);
    
    // Simulate publishing
    await relay.publish(event);
    
    // Simulate receiving the event back
    await relay.simulateEvent(event);
    
    // Simulate EOSE
    relay.simulateEOSE("test-sub");
  }

  /**
   * Clean up test resources
   */
  cleanup(): void {
    // Reset all mock relays
    this.relayMocks.forEach(relay => relay.reset());
    this.relayMocks.clear();
  }
}

/**
 * Helper to create a test environment with time control
 */
export async function withTestEnvironment<T>(
  testFn: (fixture: TENEXTestFixture, timeControl: TimeController) => Promise<T>
): Promise<T> {
  return withTimeControl(async (timeControl) => {
    const fixture = new TENEXTestFixture();
    try {
      return await testFn(fixture, timeControl);
    } finally {
      fixture.cleanup();
    }
  });
}

/**
 * Quick helper to get a test user with signer
 */
export async function getTestUserWithSigner(
  name: TestUserName,
  ndk?: NDK
): Promise<{ user: NDKUser; signer: any }> {
  const user = await UserGenerator.getUser(name, ndk);
  const signer = SignerGenerator.getSigner(name);
  return { user, signer };
}

/**
 * Create a mock agent configuration for testing
 */
export function createMockAgentConfig(overrides: any = {}) {
  return {
    name: overrides.name || "TestAgent",
    slug: overrides.slug || "test-agent",
    role: overrides.role || "Test agent for unit testing",
    backend: overrides.backend || "reason-act-loop",
    tools: overrides.tools || ["test-tool"],
    capabilities: overrides.capabilities || {
      canRead: true,
      canWrite: false,
      canExecute: false
    },
    rateLimits: overrides.rateLimits || {
      messagesPerMinute: 10,
      tokensPerDay: 100000
    },
    ...overrides
  };
}

// Re-export commonly used utilities
export {
  RelayMock,
  RelayPoolMock,
  EventGenerator,
  TestEventFactory,
  UserGenerator,
  SignerGenerator,
  TimeController,
  withTimeControl,
  mockNutzap,
  mockProof,
  type Proof
};