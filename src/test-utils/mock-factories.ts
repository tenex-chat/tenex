import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { Agent, ExecutionContext } from "@/agents/types";
import type { Conversation, Phase } from "@/conversations/types";
import type { ToolCall } from "@/llm/types";
import { EVENT_KINDS } from "@/llm/types";

/**
 * Factory functions for creating mock objects in tests
 */

export function createMockNDKEvent(overrides?: Partial<NDKEvent>): NDKEvent {
    return {
        id: "mock-event-" + Math.random().toString(36).substr(2, 9),
        pubkey: "mock-pubkey",
        created_at: Math.floor(Date.now() / 1000),
        kind: EVENT_KINDS.GENERIC_REPLY,
        tags: [],
        content: "Mock event content",
        sig: "mock-signature",
        ...overrides
    } as NDKEvent;
}

export function createMockAgent(overrides?: Partial<Agent>): Agent {
    return {
        id: "mock-agent-" + Math.random().toString(36).substr(2, 9),
        name: "MockAgent",
        description: "A mock agent for testing",
        publicKey: "mock-pubkey",
        isBuiltIn: false,
        allowedTools: ["analyze", "complete", "continue"],
        systemPrompt: "You are a mock agent for testing",
        ...overrides
    };
}

export function createMockConversation(overrides?: Partial<Conversation>): Conversation {
    const id = overrides?.id || "mock-conv-" + Math.random().toString(36).substr(2, 9);
    return {
        id,
        title: "Mock Conversation",
        phase: "CHAT",
        history: [],
        agentContexts: new Map(),
        phaseStartedAt: Date.now(),
        metadata: {
            summary: "Mock conversation summary",
            requirements: "Mock requirements",
            continueCallCounts: {}
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
    const conversation = overrides?.conversation || createMockConversation();
    
    return {
        agent,
        conversation,
        conversationId: conversation.id,
        projectPath: "/mock/project",
        userMessage: "Mock user message",
        systemPrompt: agent.systemPrompt || "Mock system prompt",
        availableTools: ["analyze", "complete", "continue"],
        onStreamContent: overrides?.onStreamContent || (() => {}),
        onStreamToolCall: overrides?.onStreamToolCall || (() => {}),
        onComplete: overrides?.onComplete || (() => {}),
        onError: overrides?.onError || (() => {}),
        ...overrides
    };
}

export function createMockToolCall(overrides?: Partial<ToolCall>): ToolCall {
    return {
        id: "tool-" + Math.random().toString(36).substr(2, 9),
        type: "function",
        function: {
            name: "analyze",
            arguments: JSON.stringify({ query: "Mock query" })
        },
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