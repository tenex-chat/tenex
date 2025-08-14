import { describe, it, expect, beforeEach, jest } from "bun:test";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { handleChatMessage } from "../reply";
import type { ConversationManager } from "@/conversations";
import type { AgentExecutor } from "@/agents/execution/AgentExecutor";

// Mock modules
jest.mock("@/services");
jest.mock("@/utils/logger");

describe("Orchestrator Wait Optimization", () => {
    let mockConversationManager: any;
    let mockAgentExecutor: any;
    let mockProjectContext: any;

    beforeEach(() => {
        // Create mock conversation manager
        mockConversationManager = {
            getConversationByEvent: vi.fn(),
            getConversation: vi.fn(),
            createConversation: vi.fn(),
            addEvent: vi.fn(),
            isCurrentTurnComplete: vi.fn(),
        };

        // Create mock agent executor
        mockAgentExecutor = {
            execute: vi.fn(),
        };

        // Create mock project context
        const orchestratorAgent = {
            name: "Orchestrator",
            pubkey: "orchestrator-pubkey",
            role: "orchestrator",
        };

        mockProjectContext = {
            pubkey: "project-pubkey",
            agents: new Map([["orchestrator", orchestratorAgent]]),
            getProjectAgent: () => orchestratorAgent,
        };

        (getProjectContext as any).mockReturnValue(mockProjectContext);
    });

    it("should skip orchestrator invocation when there's an incomplete turn", async () => {
        // Create a test event
        const event: Partial<NDKEvent> = {
            id: "event-1",
            pubkey: "user-pubkey",
            content: "Test message",
            kind: 1111,
            tags: [],
            tagValue: vi.fn((tag: string) => {
                if (tag === "E") return "conversation-root";
                return undefined;
            }),
        };

        // Mock conversation with incomplete turn
        const mockConversation = {
            id: "conv-1",
            phase: "execute",
            phaseTransitions: [],
        };

        mockConversationManager.getConversationByEvent.mockReturnValue(mockConversation);
        mockConversationManager.isCurrentTurnComplete.mockReturnValue(false); // Incomplete turn!

        // Call the handler
        await handleChatMessage(event as NDKEvent, {
            conversationManager: mockConversationManager,
            agentExecutor: mockAgentExecutor,
        });

        // Verify orchestrator was NOT invoked
        expect(mockAgentExecutor.execute).not.toHaveBeenCalled();
        expect(mockConversationManager.isCurrentTurnComplete).toHaveBeenCalledWith("conv-1");
    });

    it("should invoke orchestrator when turn is complete", async () => {
        // Create a test event
        const event: Partial<NDKEvent> = {
            id: "event-2",
            pubkey: "user-pubkey",
            content: "Test message",
            kind: 1111,
            tags: [],
            tagValue: vi.fn((tag: string) => {
                if (tag === "E") return "conversation-root";
                return undefined;
            }),
        };

        // Mock conversation with complete turn
        const mockConversation = {
            id: "conv-2",
            phase: "execute",
            phaseTransitions: [],
        };

        mockConversationManager.getConversationByEvent.mockReturnValue(mockConversation);
        mockConversationManager.isCurrentTurnComplete.mockReturnValue(true); // Complete turn!

        // Call the handler
        await handleChatMessage(event as NDKEvent, {
            conversationManager: mockConversationManager,
            agentExecutor: mockAgentExecutor,
        });

        // Verify orchestrator WAS invoked
        expect(mockAgentExecutor.execute).toHaveBeenCalled();
        expect(mockConversationManager.isCurrentTurnComplete).toHaveBeenCalledWith("conv-2");
    });

    it("should always invoke p-tagged agents regardless of turn status", async () => {
        const targetAgent = {
            name: "TestAgent",
            pubkey: "agent-pubkey",
            role: "test",
        };

        mockProjectContext.agents.set("test-agent", targetAgent);

        // Create a test event with p-tag
        const event: Partial<NDKEvent> = {
            id: "event-3",
            pubkey: "user-pubkey",
            content: "Test message",
            kind: 1111,
            tags: [["p", "agent-pubkey"]],
            tagValue: vi.fn((tag: string) => {
                if (tag === "E") return "conversation-root";
                return undefined;
            }),
        };

        // Mock conversation with incomplete turn
        const mockConversation = {
            id: "conv-3",
            phase: "execute",
            phaseTransitions: [],
        };

        mockConversationManager.getConversationByEvent.mockReturnValue(mockConversation);
        mockConversationManager.isCurrentTurnComplete.mockReturnValue(false); // Incomplete turn

        // Call the handler
        await handleChatMessage(event as NDKEvent, {
            conversationManager: mockConversationManager,
            agentExecutor: mockAgentExecutor,
        });

        // Verify the p-tagged agent WAS invoked (not orchestrator)
        expect(mockAgentExecutor.execute).toHaveBeenCalled();
        const executionContext = mockAgentExecutor.execute.mock.calls[0][0];
        expect(executionContext.agent.pubkey).toBe("agent-pubkey");
        
        // isCurrentTurnComplete should NOT have been called since we're not routing to orchestrator
        expect(mockConversationManager.isCurrentTurnComplete).not.toHaveBeenCalled();
    });
});