import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type NDK from "@nostr-dev-kit/ndk";
import type { Agent } from "@/agents/types";
import type { ExecutionContext } from "@/agents/execution/types";
import type { Conversation } from "@/conversations/types";
import type { Phase } from "@/conversations/phases";
import type { ToolCall } from "@/llm/types";
import { EVENT_KINDS } from "@/llm/types";

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
        this.id = overrides?.id || "mock-event-" + Math.random().toString(36).substr(2, 9);
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
            sig: includeSignature ? this.sig : undefined
        };
        return JSON.stringify(obj);
    }
    
    tagValue(tagName: string): string | undefined {
        const tag = this.tags.find(t => t[0] === tagName);
        return tag?.[1];
    }
    
    static deserialize(ndk: NDK, serialized: string): MockNostrEvent {
        const data = JSON.parse(serialized);
        return new MockNostrEvent(data);
    }
}

export function createMockNDKEvent(overrides?: Partial<NDKEvent>): NDKEvent {
    return new MockNostrEvent(overrides) as NDKEvent;
}

export function createMockAgent(overrides?: Partial<Agent>): Agent {
    const mockSigner = {
        privateKey: "mock-private-key",
        sign: async () => "mock-signature"
    } as any;
    
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
        isOrchestrator: false,
        isBuiltIn: false,
        backend: "reason-act-loop",
        ...overrides
    } as Agent;
}

export function createMockConversation(overrides?: Partial<Conversation>): Conversation {
    const id = overrides?.id || "mock-conv-" + Math.random().toString(36).substr(2, 9);
    return {
        id,
        title: "Mock Conversation",
        phase: "chat",
        history: [],
        agentStates: new Map(),
        phaseStartedAt: Date.now(),
        metadata: {
            summary: "Mock conversation summary",
            requirements: "Mock requirements",
            continueCallCounts: {
                chat: 0,
                brainstorm: 0,
                plan: 0,
                execute: 0,
                verification: 0,
                chores: 0,
                reflection: 0
            }
        },
        phaseTransitions: [],
        executionTime: {
            totalSeconds: 0,
            isActive: false,
            lastUpdated: Date.now()
        },
        ...overrides
    };
}


export function createMockExecutionContext(overrides?: Partial<ExecutionContext>): ExecutionContext {
    const agent = overrides?.agent || createMockAgent();
    const mockEvent = createMockNDKEvent();
    
    // Create mock publisher and conversation manager
    const mockPublisher = {
        publishReply: async () => mockEvent,
        publishToolCall: async () => mockEvent,
        publishAgentThinking: async () => mockEvent
    } as any;
    
    const mockConversationManager = {
        getConversation: async () => createMockConversation(),
        updateConversation: async () => {},
        transitionPhase: async () => {}
    } as any;
    
    return {
        agent,
        conversationId: overrides?.conversationId || "mock-conv-" + Math.random().toString(36).substr(2, 9),
        phase: "chat",
        projectPath: "/mock/project",
        triggeringEvent: mockEvent,
        publisher: mockPublisher,
        conversationManager: mockConversationManager,
        ...overrides
    } as ExecutionContext;
}

export function createMockToolCall(overrides?: Partial<ToolCall>): ToolCall {
    return {
        id: "tool-" + Math.random().toString(36).substr(2, 9),
        message: null,
        function: "analyze",
        args: JSON.stringify({ query: "Mock query" }),
        ...overrides
    };
}

export function createMockPhaseTransition(
    from: Phase,
    to: Phase,
    reason?: string
) {
    return {
        from,
        to,
        timestamp: new Date(),
        reason: reason || `Transition from ${from} to ${to}`,
        transitionMessage: `Moving from ${from} phase to ${to} phase`
    };
}

/**
 * Create a mock file system structure for testing
 */
export function createMockFileSystem(): Map<string, string> {
    const files = new Map<string, string>();
    
    // Add common project files
    files.set("/mock/project/package.json", JSON.stringify({
        name: "mock-project",
        version: "1.0.0",
        dependencies: {}
    }, null, 2));
    
    files.set("/mock/project/README.md", "# Mock Project\n\nThis is a mock project for testing.");
    
    files.set("/mock/project/src/index.ts", `
export function main() {
    console.log("Hello from mock project");
}
`);
    
    return files;
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

// Usage example:
// const agent = new MockBuilder<Agent>()
//     .with('name', 'TestAgent')
//     .with('allowedTools', ['test-tool'])
//     .build(createMockAgent());