import type { ExecutionContext } from "@/agents/execution/types";
import type { AgentInstance } from "@/agents/types";
import type { ConversationCoordinator } from "@/conversations";
import type { ConversationStore } from "@/conversations/ConversationStore";
import type { MockToolCall } from "@/test-utils/mock-llm/types";
import type { AgentPublisher } from "@/nostr/AgentPublisher";
import { NDKKind } from "@/nostr/kinds";
import type { TodoItem } from "@/services/ral/types";
import type { ToolRegistryContext } from "@/tools/types";
import type NDK from "@nostr-dev-kit/ndk";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

/**
 * Factory functions for creating mock objects in tests
 */

/**
 * MockNostrEvent class that implements the serialize method for NDKEvent
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
        this.kind = overrides?.kind || NDKKind.GenericReply;
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
        eventId: "mock-event-id",
        slug: "mock-agent",
        createMetadataStore: () => ({
            get: () => undefined,
            set: () => {},
        }),
        sign: async () => {},
        ...overrides,
    } as AgentInstance;
}

/**
 * Create a mock ConversationStore with the required interface
 */
export function createMockConversationStore(overrides?: {
    id?: string;
    title?: string;
    phase?: string;
}): ConversationStore {
    const id = overrides?.id || `mock-conv-${Math.random().toString(36).substr(2, 9)}`;
    const agentTodos = new Map<string, TodoItem[]>();
    const blockedAgents = new Set<string>();

    return {
        id,
        get title() { return overrides?.title || "Mock Conversation"; },
        get phase() { return overrides?.phase || "CHAT"; },
        get metadata() {
            return {
                summary: "Mock conversation summary",
                requirements: "Mock requirements",
            };
        },
        get executionTime() {
            return {
                totalSeconds: 0,
                isActive: false,
                lastUpdated: Date.now(),
            };
        },
        getAllMessages: () => [],
        getMessageCount: () => 0,
        getLastActivityTime: () => Date.now(),
        getRootEventId: () => id,
        hasEventId: () => false,
        getTodos: (pubkey: string) => agentTodos.get(pubkey) || [],
        setTodos: (pubkey: string, todos: TodoItem[]) => { agentTodos.set(pubkey, todos); },
        isAgentBlocked: (pubkey: string) => blockedAgents.has(pubkey),
        blockAgent: (pubkey: string) => { blockedAgents.add(pubkey); },
        unblockAgent: (pubkey: string) => { blockedAgents.delete(pubkey); },
        getTitle: () => overrides?.title || "Mock Conversation",
        setTitle: () => {},
        updateMetadata: () => {},
        save: async () => {},
        load: () => {},
    } as unknown as ConversationStore;
}

export function createMockExecutionContext(
    overrides?: Partial<ExecutionContext>
): ExecutionContext {
    return createMockToolContext(overrides) as ExecutionContext;
}

export function createMockToolContext(
    overrides?: Partial<ToolRegistryContext>
): ToolRegistryContext {
    const agent = overrides?.agent || createMockAgent();
    const mockEvent = overrides?.triggeringEvent || createMockNDKEvent();
    const conversationId =
        overrides?.conversationId || `mock-conv-${Math.random().toString(36).substr(2, 9)}`;

    const mockConversation = createMockConversationStore({ id: conversationId });

    const mockConversationCoordinator: Partial<ConversationCoordinator> = {
        initialize: async () => {},
        createConversation: async () => mockConversation,
        getConversation: () => mockConversation,
        addEvent: async () => {},
        updateMetadata: async () => {},
        getAllConversations: () => [mockConversation],
    };

    const mockPublisher: Partial<AgentPublisher> = {
        agent,
        reply: async () => mockEvent,
        thinking: async () => mockEvent,
        typing: async () => {},
        conversation: async () => mockEvent,
        lesson: async () => mockEvent,
    };

    return {
        agent,
        conversationId,
        projectBasePath: "/mock/project",
        workingDirectory: "/mock/project",
        currentBranch: "main",
        triggeringEvent: mockEvent,
        agentPublisher: mockPublisher as AgentPublisher,
        ralNumber: 1,
        conversationStore: mockConversation,
        getConversation: () => mockConversation,
        conversationCoordinator: mockConversationCoordinator as ConversationCoordinator,
        ...overrides,
    } as ToolRegistryContext;
}

export function createMockToolCall(overrides?: Partial<MockToolCall>): MockToolCall {
    return {
        id: `tool-${Math.random().toString(36).substr(2, 9)}`,
        message: null,
        function: "analyze",
        args: JSON.stringify({ query: "Mock query" }),
        ...overrides,
    };
}

/**
 * Alias for createMockToolContext - provides ToolRegistryContext
 * which satisfies ExecutionEnvironment requirements
 */
export const createMockExecutionEnvironment = createMockToolContext;
