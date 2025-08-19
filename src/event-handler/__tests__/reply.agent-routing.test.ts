import { describe, it, expect, beforeEach, mock } from "bun:test";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { handleChatMessage } from "../reply";
import type { ConversationCoordinator } from "../../conversations";
import type { AgentExecutor } from "../../agents/execution/AgentExecutor";
import { getProjectContext } from "../../services";

// Mock dependencies
mock.module("../../utils/logger", () => ({
    logger: {
        info: mock(() => {}),
        error: mock(() => {}),
        warn: mock(() => {}),
        debug: mock(() => {}),
    },
}));

describe("Agent Event Routing", () => {
    let mockConversationCoordinator: ConversationCoordinator;
    let mockAgentExecutor: AgentExecutor;
    let mockProjectContext: any;

    beforeEach(() => {
        // Reset mocks
        mock.restore();

        // Create mock conversation manager
        mockConversationCoordinator = {
            getConversationByEvent: mock(() => undefined),
            getConversation: mock(() => undefined),
            getTaskMapping: mock(() => undefined),
            createConversation: mock(() => Promise.resolve(undefined)),
            addEvent: mock(() => Promise.resolve()),
            updateAgentState: mock(() => Promise.resolve()),
        } as any;

        // Create mock agent executor
        mockAgentExecutor = {
            execute: mock(() => Promise.resolve()),
        } as any;

        // Create mock project context with agents
        mockProjectContext = {
            pubkey: "project-pubkey",
            agents: new Map([
                ["project-manager", {
                    name: "project-manager",
                    pubkey: "pm-agent-pubkey",
                    slug: "project-manager",
                }],
                ["code-agent", {
                    name: "code-agent",
                    pubkey: "code-agent-pubkey",
                    slug: "code-agent",
                }],
            ]),
            getAgent: (slug: string) => mockProjectContext.agents.get(slug),
        };

        // Mock getProjectContext
        mock.module("../../services", () => ({
            getProjectContext: () => mockProjectContext,
        }));
    });

    it("should not route agent events without p-tags", async () => {
        // Create an event from an agent without p-tags
        const agentEvent: NDKEvent = {
            id: "event-1",
            pubkey: "code-agent-pubkey", // Agent pubkey
            content: "Agent reporting something",
            kind: 1111,
            tags: [
                ["E", "conv-root"],
                ["K", "11"],
            ],
            tagValue: (tag: string) => {
                if (tag === "E") return "conv-root";
                if (tag === "K") return "11";
                return undefined;
            },
            getMatchingTags: (tag: string) => {
                if (tag === "p") return [];
                return [];
            },
        } as any;

        // Handle the event
        await handleChatMessage(agentEvent, {
            conversationManager: mockConversationCoordinator,
            agentExecutor: mockAgentExecutor,
        });

        // Agent executor should NOT be called since the event shouldn't be routed
        expect(mockAgentExecutor.execute).not.toHaveBeenCalled();
    });

    it("should route user events without p-tags to PM", async () => {
        // Create an event from a user without p-tags
        const userEvent: NDKEvent = {
            id: "event-2",
            pubkey: "user-pubkey", // Not an agent pubkey
            content: "User message",
            kind: 1111,
            tags: [
                ["E", "conv-root"],
                ["K", "11"],
            ],
            tagValue: (tag: string) => {
                if (tag === "E") return "conv-root";
                if (tag === "K") return "11";
                return undefined;
            },
            getMatchingTags: (tag: string) => {
                if (tag === "p") return [];
                return [];
            },
        } as any;

        // Create a mock conversation
        const mockConversation = {
            id: "conv-root",
            history: [],
            phase: "chat",
            phaseTransitions: [],
            agentStates: new Map(),
        };

        // Update mock to return conversation
        mockConversationCoordinator.getConversationByEvent = mock(() => mockConversation);

        // Handle the event
        await handleChatMessage(userEvent, {
            conversationManager: mockConversationCoordinator,
            agentExecutor: mockAgentExecutor,
        });

        // Agent executor should be called since user events should be routed to PM
        expect(mockAgentExecutor.execute).toHaveBeenCalled();
        
        // Check that the execution context has the PM as target agent
        const executionCall = (mockAgentExecutor.execute as any).mock.calls[0];
        const executionContext = executionCall[0];
        expect(executionContext.agent.slug).toBe("project-manager");
    });

    it("should route agent events with p-tags to the tagged agent", async () => {
        // Create an event from an agent with p-tags
        const agentEvent: NDKEvent = {
            id: "event-3",
            pubkey: "code-agent-pubkey", // Agent pubkey
            content: "Agent message to PM",
            kind: 1111,
            tags: [
                ["E", "conv-root"],
                ["K", "11"],
                ["p", "pm-agent-pubkey"], // P-tagging the PM
            ],
            tagValue: (tag: string) => {
                if (tag === "E") return "conv-root";
                if (tag === "K") return "11";
                if (tag === "p") return "pm-agent-pubkey";
                return undefined;
            },
            getMatchingTags: (tag: string) => {
                if (tag === "p") return [["p", "pm-agent-pubkey"]];
                return [];
            },
        } as any;

        // Create a mock conversation
        const mockConversation = {
            id: "conv-root",
            history: [],
            phase: "chat",
            phaseTransitions: [],
            agentStates: new Map(),
        };

        // Update mock to return conversation
        mockConversationCoordinator.getConversationByEvent = mock(() => mockConversation);

        // Handle the event
        await handleChatMessage(agentEvent, {
            conversationManager: mockConversationCoordinator,
            agentExecutor: mockAgentExecutor,
        });

        // Agent executor should be called
        expect(mockAgentExecutor.execute).toHaveBeenCalled();
        
        // Check that the execution context has the PM as target agent
        const executionCall = (mockAgentExecutor.execute as any).mock.calls[0];
        const executionContext = executionCall[0];
        expect(executionContext.agent.slug).toBe("project-manager");
    });
});