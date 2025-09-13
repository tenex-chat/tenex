import type { ExecutionContext } from "@/agents/execution/types";
import type { AgentInstance } from "@/agents/types";
import type { Conversation } from "@/conversations/types";
import type { ToolCall } from "@/llm/types";
import { EVENT_KINDS } from "@/llm/types";
import type NDK from "@nostr-dev-kit/ndk";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

/**
 * Factory functions for creating mock objects in tests
 */

/**
 * MockNostrEvent class that implements the serialize method required by FileSystemAdapter
 */
export class MockNostrEvent implements Partial<NDKEvent> {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig?: string;

  constructor(overrides?: Partial<NDKEvent>) {
    this.id = overrides?.id || `mock-event-${Math.random().toString(36).substr(2, 9)}`;
    this.pubkey = overrides?.pubkey || "mock-pubkey";
    this.created_at = overrides?.created_at || Math.floor(Date.now() / 1000);
    this.kind = overrides?.kind || EVENT_KINDS.GENERIC_REPLY;
    this.tags = overrides?.tags || [];
    this.content = overrides?.content || "Mock event content";
    this.sig = overrides?.sig || "mock-signature";
  }

  serialize(includeSignature?: boolean, includeId?: boolean): string {
    const obj = {
      id: includeId ? this.id : undefined,
      pubkey: this.pubkey,
      created_at: this.created_at,
      kind: this.kind,
      tags: this.tags,
      content: this.content,
      sig: includeSignature ? this.sig : undefined,
    };
    return JSON.stringify(obj);
  }

  tagValue(tagName: string): string | undefined {
    const tag = this.tags.find((t) => t[0] === tagName);
    return tag?.[1];
  }

  static deserialize(_ndk: NDK, serialized: string): MockNostrEvent {
    const data = JSON.parse(serialized);
    return new MockNostrEvent(data);
  }
}

export function createMockNDKEvent(overrides?: Partial<NDKEvent>): NDKEvent {
  return new MockNostrEvent(overrides) as NDKEvent;
}

export function createMockAgent(overrides?: Partial<AgentInstance>): AgentInstance {
  const mockSigner = {
    privateKey: "mock-private-key",
    sign: async () => "mock-signature",
  } as unknown;

  return {
    name: "MockAgent",
    pubkey: "mock-pubkey",
    signer: mockSigner,
    role: "Mock Role",
    description: "A mock agent for testing",
    instructions: "You are a mock agent for testing",
    useCriteria: "Mock use criteria",
    llmConfig: "default",
    tools: [],
    mcp: false,
    eventId: "mock-event-id",
    slug: "mock-agent",
    createMetadataStore: () => ({
      get: () => undefined,
      set: () => {}
    }),
    ...overrides,
  } as AgentInstance;
}

export function createMockConversation(overrides?: Partial<Conversation>): Conversation {
  const id = overrides?.id || `mock-conv-${Math.random().toString(36).substr(2, 9)}`;
  return {
    id,
    title: "Mock Conversation",
    phase: "CHAT",
    history: [],
    agentStates: new Map(),
    phaseStartedAt: Date.now(),
    metadata: {
      summary: "Mock conversation summary",
      requirements: "Mock requirements",
    },
    executionTime: {
      totalSeconds: 0,
      isActive: false,
      lastUpdated: Date.now(),
    },
    ...overrides,
  };
}

export function createMockExecutionContext(
  overrides?: Partial<ExecutionContext>
): ExecutionContext {
  const agent = overrides?.agent || createMockAgent();
  const mockEvent = createMockNDKEvent();

  // Create mock publisher and conversation manager
  const mockPublisher = {
    publishReply: async () => mockEvent,
    publishToolCall: async () => mockEvent,
    publishAgentThinking: async () => mockEvent,
  } as unknown;

  const mockConversationCoordinator = {
    getConversation: async () => createMockConversation(),
    updateConversation: async () => {},
    transitionPhase: async () => {},
  } as unknown;

  return {
    agent,
    conversationId:
      overrides?.conversationId || `mock-conv-${Math.random().toString(36).substr(2, 9)}`,
    phase: "CHAT",
    projectPath: "/mock/project",
    triggeringEvent: mockEvent,
    publisher: mockPublisher,
    conversationCoordinator: mockConversationCoordinator,
    ...overrides,
  } as ExecutionContext;
}

export function createMockToolCall(overrides?: Partial<ToolCall>): ToolCall {
  return {
    id: `tool-${Math.random().toString(36).substr(2, 9)}`,
    message: null,
    function: "analyze",
    args: JSON.stringify({ query: "Mock query" }),
    ...overrides,
  };
}

/**
 * Create a builder for complex mock objects
 */
export class MockBuilder<T> {
  private obj: Partial<T> = {};

  with<K extends keyof T>(key: K, value: T[K]): this {
    this.obj[key] = value;
    return this;
  }

  build(defaults: T): T {
    return { ...defaults, ...this.obj };
  }
}

