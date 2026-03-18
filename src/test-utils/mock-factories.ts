import type { ExecutionContext } from "@/agents/execution/types";
import type { AgentInstance } from "@/agents/types";
import type { ConversationStore } from "@/conversations/ConversationStore";
import type { InboundEnvelope } from "@/events/runtime/InboundEnvelope";
import type { MockToolCall } from "@/test-utils/mock-llm/types";
import type { AgentPublisher } from "@/nostr/AgentPublisher";
import { NDKKind } from "@/nostr/kinds";
import type { TodoItem } from "@/services/ral/types";
import type { ToolRegistryContext } from "@/tools/types";
import type NDK from "@nostr-dev-kit/ndk";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

type ConversationCoordinator = {
    initialize: () => Promise<void>;
    createConversation: () => Promise<ConversationStore>;
    getConversation: (conversationId: string) => ConversationStore | undefined;
    addEvent: () => Promise<void>;
    updateMetadata: () => Promise<void>;
    getAllConversations: () => ConversationStore[];
};

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

export function createMockInboundEnvelope(overrides?: Partial<InboundEnvelope>): InboundEnvelope {
    const defaultId = `mock-event-${Math.random().toString(36).slice(2, 11)}`;
    const baseEnvelope: InboundEnvelope = {
        transport: "nostr",
        principal: {
            id: "mock-pubkey",
            transport: "nostr",
            linkedPubkey: "mock-pubkey",
            kind: "human",
        },
        channel: {
            id: "mock-conversation",
            transport: "nostr",
            kind: "conversation",
        },
        message: {
            id: defaultId,
            transport: "nostr",
            nativeId: defaultId,
        },
        recipients: [],
        content: "Mock event content",
        occurredAt: Date.now(),
        capabilities: [],
        metadata: {
            eventKind: NDKKind.GenericReply,
            eventTagCount: 0,
            replyTargets: [],
            articleReferences: [],
            nudgeEventIds: [],
            skillEventIds: [],
        },
    };

    return {
        ...baseEnvelope,
        ...overrides,
        principal: {
            ...baseEnvelope.principal,
            ...overrides?.principal,
        },
        channel: {
            ...baseEnvelope.channel,
            ...overrides?.channel,
        },
        message: {
            ...baseEnvelope.message,
            ...overrides?.message,
        },
        recipients: overrides?.recipients ?? baseEnvelope.recipients,
        capabilities: overrides?.capabilities ?? baseEnvelope.capabilities,
        metadata: {
            ...baseEnvelope.metadata,
            ...overrides?.metadata,
        },
    };
}

function normalizeMockInboundEnvelope(
    triggeringEnvelope?: ToolRegistryContext["triggeringEnvelope"] | Partial<NDKEvent>
): InboundEnvelope {
    if (
        triggeringEnvelope &&
        typeof triggeringEnvelope === "object" &&
        "transport" in triggeringEnvelope &&
        "principal" in triggeringEnvelope &&
        "channel" in triggeringEnvelope &&
        "message" in triggeringEnvelope
    ) {
        return createMockInboundEnvelope(triggeringEnvelope as Partial<InboundEnvelope>);
    }

    const legacyEvent = triggeringEnvelope as Partial<NDKEvent> | undefined;
    const branchName = legacyEvent?.tags?.find((tag) => tag[0] === "branch")?.[1];
    const replyTargets = legacyEvent?.tags
        ?.filter((tag) => tag[0] === "e" || tag[0] === "E")
        .map((tag) => tag[1]) ?? [];
    const nudgeEventIds = legacyEvent?.tags
        ?.filter((tag) => tag[0] === "nudge")
        .map((tag) => tag[1]) ?? [];
    const skillEventIds = legacyEvent?.tags
        ?.filter((tag) => tag[0] === "skill")
        .map((tag) => tag[1]) ?? [];
    const articleReferences = legacyEvent?.tags
        ?.filter((tag) => tag[0] === "a")
        .map((tag) => tag[1]) ?? [];
    const statusValue = legacyEvent?.tags?.find((tag) => tag[0] === "status")?.[1];
    const toolName = legacyEvent?.tags?.find((tag) => tag[0] === "tool")?.[1];
    const delegationParentConversationId = legacyEvent?.tags?.find(
        (tag) => tag[0] === "delegation"
    )?.[1];
    const recipients = legacyEvent?.tags
        ?.filter((tag) => tag[0] === "p" && Boolean(tag[1]))
        .map((tag) => ({
            id: tag[1],
            transport: "nostr" as const,
            linkedPubkey: tag[1],
            kind: "agent" as const,
        })) ?? [];
    const messageId = legacyEvent?.id ?? `mock-event-${Math.random().toString(36).slice(2, 11)}`;
    const pubkey = legacyEvent?.pubkey ?? "mock-pubkey";

    return createMockInboundEnvelope({
        principal: {
            id: pubkey,
            transport: "nostr",
            linkedPubkey: pubkey,
            kind: "human",
        },
        message: {
            id: messageId,
            transport: "nostr",
            nativeId: messageId,
        },
        recipients,
        content: legacyEvent?.content ?? "Mock event content",
        metadata: {
            eventKind: legacyEvent?.kind ?? NDKKind.GenericReply,
            eventTagCount: legacyEvent?.tags?.length ?? 0,
            branchName,
            articleReferences,
            replyTargets,
            delegationParentConversationId,
            nudgeEventIds,
            skillEventIds,
            statusValue,
            toolName,
        },
    });
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
    const mockEvent = normalizeMockInboundEnvelope(overrides?.triggeringEnvelope);
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
        triggeringEnvelope: mockEvent,
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
