/**
 * Tests for the delegate_crossproject tool
 *
 * Covers:
 * - Todo enforcement skip path when no conversation context (MCP-only mode)
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import type { ToolExecutionContext } from "@/tools/types";
import type { AgentInstance } from "@/agents/types";
import { RALRegistry } from "@/services/ral";

// Mock NDKEvent to prevent actual signing/publishing
const mockEventId = "mock-event-id-1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd";
const mockNDKEvent = {
    kind: 1,
    content: "",
    tags: [] as string[][],
    id: mockEventId,
    publish: mock(async () => new Set()),
};

mock.module("@nostr-dev-kit/ndk", () => ({
    NDKEvent: class MockNDKEvent {
        kind = 1;
        content = "";
        tags: string[][] = [];
        id = mockEventId;
        async publish() {
            return new Set();
        }
    },
    NDKPrivateKeySigner: class MockNDKPrivateKeySigner {
        pubkey = "mock-signer-pubkey";
        constructor(_nsec: string) {}
    },
}));

// Mock NDK before importing modules that use it
mock.module("@/nostr", () => ({
    getNDK: () => ({
        fetchEvent: async () => null,
    }),
}));

// Mock getDaemon before importing delegate_crossproject
const mockGetKnownProjects = mock(() => new Map([
    ["31933:project-pubkey:target-project", {
        pubkey: "project-pubkey",
        title: "Target Project",
        agents: [],
    }],
]));

const mockGetActiveRuntimes = mock(() => new Map([
    ["31933:project-pubkey:target-project", {
        getContext: () => ({
            agentRegistry: {
                getAllAgentsMap: () => new Map([
                    ["target-agent-pubkey", {
                        slug: "target-agent",
                        name: "Target Agent",
                        pubkey: "target-agent-pubkey",
                    }],
                ]),
            },
        }),
    }],
]));

mock.module("@/daemon", () => ({
    getDaemon: () => ({
        getKnownProjects: mockGetKnownProjects,
        getActiveRuntimes: mockGetActiveRuntimes,
    }),
}));

// Mock agentStorage for fallback lookup
mock.module("@/agents/AgentStorage", () => ({
    agentStorage: {
        getProjectAgents: async () => [],
    },
}));

// Mock PendingDelegationsRegistry
mock.module("@/services/ral", () => {
    const originalModule = require("@/services/ral/RALRegistry");
    return {
        RALRegistry: originalModule.RALRegistry,
        PendingDelegationsRegistry: {
            register: mock(() => {}),
        },
    };
});

import { createDelegateCrossProjectTool } from "@/tools/implementations/delegate_crossproject";

describe("delegate_crossproject - Todo enforcement", () => {
    const conversationId = "test-conversation-id-1234567890abcdef1234567890abcdef1234567890abcdef";
    const projectId = "31933:pubkey:test-project";
    let registry: RALRegistry;

    // Default todo item to satisfy delegation requirement
    const defaultTodo = {
        id: "test-todo",
        title: "Test Todo",
        description: "Test",
        status: "pending" as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };

    /**
     * Creates a mock agent instance with a sign method.
     */
    const createMockAgent = (): AgentInstance => ({
        slug: "sender-agent",
        name: "Sender Agent",
        pubkey: "sender-agent-pubkey-123456789012345678901234567890123456789012345678",
        sign: mock(async () => {}),
    }) as unknown as AgentInstance;

    /**
     * Creates a mock context with todos available.
     */
    const createMockContextWithTodos = (ralNumber: number): ToolExecutionContext => ({
        agent: createMockAgent(),
        conversationId,
        triggeringEvent: {
            tags: [],
        } as any,
        agentPublisher: {} as any,
        ralNumber,
        projectBasePath: "/tmp/test",
        workingDirectory: "/tmp/test",
        currentBranch: "main",
        getConversation: () => ({
            getRootEventId: () => conversationId,
            getTodos: () => [defaultTodo],
        }) as any,
    });

    /**
     * Creates a context with getConversation() returning null,
     * simulating MCP-only mode where no conversation context is available.
     */
    const createMockContextWithNoConversation = (ralNumber: number): ToolExecutionContext => ({
        agent: createMockAgent(),
        conversationId,
        triggeringEvent: {
            tags: [],
        } as any,
        agentPublisher: {} as any,
        ralNumber,
        projectBasePath: "/tmp/test",
        workingDirectory: "/tmp/test",
        currentBranch: "main",
        getConversation: () => null,
    });

    /**
     * Creates a context with conversation but no todos.
     */
    const createMockContextWithoutTodos = (ralNumber: number): ToolExecutionContext => ({
        agent: createMockAgent(),
        conversationId,
        triggeringEvent: {
            tags: [],
        } as any,
        agentPublisher: {} as any,
        ralNumber,
        projectBasePath: "/tmp/test",
        workingDirectory: "/tmp/test",
        currentBranch: "main",
        getConversation: () => ({
            getRootEventId: () => conversationId,
            getTodos: () => [],
        }) as any,
    });

    beforeEach(() => {
        // Reset singleton for testing
        // @ts-expect-error - accessing private static for testing
        RALRegistry.instance = undefined;
        registry = RALRegistry.getInstance();
    });

    afterEach(() => {
        registry.clearAll();
    });

    describe("Todo enforcement skip path", () => {
        test("should skip enforcement and allow delegation when no conversation context (MCP-only mode)", async () => {
            const agentPubkey = "sender-agent-pubkey-123456789012345678901234567890123456789012345678";
            const ralNumber = registry.create(agentPubkey, conversationId, projectId);

            // Context with getConversation() returning null - simulates MCP-only mode
            const context = createMockContextWithNoConversation(ralNumber);
            const delegateTool = createDelegateCrossProjectTool(context);

            const input = {
                content: "Please help with a task",
                projectId: "target-project",
                agentSlug: "target-agent",
            };

            // Should succeed despite no todos - enforcement is skipped when no conversation context
            const result = await delegateTool.execute(input);
            expect(result).toBeDefined();
            expect(result.success).toBe(true);
            expect(result.delegationConversationId).toBeDefined();
        });

        test("should block delegation when conversation exists but has no todos", async () => {
            const agentPubkey = "sender-agent-pubkey-123456789012345678901234567890123456789012345678";
            const ralNumber = registry.create(agentPubkey, conversationId, projectId);

            // Context with conversation but no todos
            const context = createMockContextWithoutTodos(ralNumber);
            const delegateTool = createDelegateCrossProjectTool(context);

            const input = {
                content: "Please help with a task",
                projectId: "target-project",
                agentSlug: "target-agent",
            };

            // Should throw error requiring todos
            try {
                await delegateTool.execute(input);
                expect(true).toBe(false); // Should not reach here
            } catch (error: any) {
                expect(error.message).toContain("Delegation requires a todo list");
                expect(error.message).toContain("todo_write()");
            }
        });

        test("should allow delegation when todos exist", async () => {
            const agentPubkey = "sender-agent-pubkey-123456789012345678901234567890123456789012345678";
            const ralNumber = registry.create(agentPubkey, conversationId, projectId);

            // Context with todos
            const context = createMockContextWithTodos(ralNumber);
            const delegateTool = createDelegateCrossProjectTool(context);

            const input = {
                content: "Please help with a task",
                projectId: "target-project",
                agentSlug: "target-agent",
            };

            // Should succeed with todos present
            const result = await delegateTool.execute(input);
            expect(result).toBeDefined();
            expect(result.success).toBe(true);
            expect(result.delegationConversationId).toBeDefined();
        });
    });
});
