import { describe, it, expect, beforeEach, mock } from "bun:test";
import { ConversationManager } from "../ConversationManager";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { Agent } from "@/agents/types";

// Mock the persistence module
mock.module("../persistence", () => ({
    FileSystemAdapter: mock(() => ({
        initialize: mock().mockResolvedValue(undefined),
        save: mock().mockResolvedValue(undefined),
        list: mock().mockResolvedValue([]),
        load: mock().mockResolvedValue(null),
    })),
}));

// Mock the tracing module
mock.module("@/tracing", () => ({
    createTracingContext: mock(() => ({ id: "trace-123" }))
}));

// Mock the logging module
mock.module("@/logging/ExecutionLogger", () => ({
    createExecutionLogger: () => ({
        logEvent: () => {},
    })
}));

// Mock NDK
mock.module("@/nostr", () => ({
    getNDK: () => null
}));

// Mock agents - using realistic agent setup
const mockAgents = new Map<string, Agent>([
    ["project-manager", {
        slug: "project-manager",
        name: "Project Manager",
        pubkey: "pm-pubkey",
        isOrchestrator: false,
        backend: "reason-act-loop"
    } as Agent],
    ["orchestrator", {
        slug: "orchestrator",
        name: "Orchestrator",
        pubkey: "orch-pubkey",
        isOrchestrator: true,
        backend: "routing"
    } as Agent]
]);

mock.module("@/services/ProjectContext", () => ({
    getProjectContext: () => ({
        agents: mockAgents,
        pubkey: "project-pubkey"
    })
}));

mock.module("@/nostr/utils", () => ({
    isEventFromUser: (event: NDKEvent) => event.pubkey === "user-pubkey",
    getAgentSlugFromEvent: (event: NDKEvent) => {
        if (event.pubkey === "pm-pubkey") return "project-manager";
        if (event.pubkey === "orch-pubkey") return "orchestrator";
        return null;
    }
}));

describe("ConversationManager - Integration Tests", () => {
    let manager: ConversationManager;
    const projectPath = "/tmp/test-project-" + Date.now();

    beforeEach(async () => {
        manager = new ConversationManager(projectPath);
        await manager.initialize();
    });

    it("should handle the complete real-world bug scenario", async () => {
        // This test verifies the entire flow of the reported bug:
        // 1. User p-tags PM with a question
        // 2. PM responds with an offer to help
        // 3. User says "yes, let's do it"
        // 4. PM should still have context

        const pmAgent = mockAgents.get("project-manager")!;
        
        // Step 1: User p-tags PM
        const userMsg1: NDKEvent = {
            id: "msg-1",
            pubkey: "user-pubkey",
            content: "@project-manager would you say your current PROJECT.md fits properly in what that spec should be?",
            tags: [["p", "pm-pubkey"]],
            created_at: Date.now() / 1000
        } as NDKEvent;

        const conversation = await manager.createConversation(userMsg1);
        
        // Build messages for PM (first time)
        const { messages: pmMessages1 } = await manager.buildAgentMessages(
            conversation.id,
            pmAgent,
            userMsg1
        );

        // Verify PM gets the message correctly (no history block)
        const hasHistory1 = pmMessages1.some(m => 
            m.content.includes("MESSAGES WHILE YOU WERE AWAY")
        );
        expect(hasHistory1).toBe(false);
        
        // PM should get the user's message directly
        const userMessage1 = pmMessages1.find(m => m.role === "user");
        expect(userMessage1?.content).toContain("PROJECT.md fits properly");

        // Step 2: PM responds
        const pmResponse: NDKEvent = {
            id: "msg-2",
            pubkey: "pm-pubkey",
            content: "Looking at the current PROJECT.md, I can see significant issues with how it aligns to what a proper project specification should be according to my own guidelines.\n\n**Problems with the current PROJECT.md:**\n\n1. **Too Implementation-Focused**: The current document reads more like a technical changelog...\n\nWould you like me to help restructure this into a proper product specification?",
            tags: [],
            created_at: Date.now() / 1000
        } as NDKEvent;

        await manager.addEvent(conversation.id, pmResponse);

        // Step 3: User replies with "yes, let's do it"
        const userMsg2: NDKEvent = {
            id: "msg-3",
            pubkey: "user-pubkey",
            content: "yes, let's do it",
            tags: [],
            created_at: Date.now() / 1000
        } as NDKEvent;

        await manager.addEvent(conversation.id, userMsg2);

        // Build messages for PM (continuation)
        const { messages: pmMessages2 } = await manager.buildAgentMessages(
            conversation.id,
            pmAgent,
            userMsg2
        );

        // PM should have full conversation history
        // First user message
        expect(pmMessages2[0].role).toBe("user");
        expect(pmMessages2[0].content).toContain("PROJECT.md fits properly");
        
        // PM's own previous response should be an assistant message
        const assistantMessage = pmMessages2.find(m => 
            m.role === "assistant" && 
            m.content.includes("significant issues")
        );
        expect(assistantMessage).toBeTruthy();
        expect(assistantMessage?.content).toContain("Would you like me to help restructure");
        
        // Current user message
        const lastMessage = pmMessages2[pmMessages2.length - 1];
        expect(lastMessage.role).toBe("user");
        expect(lastMessage.content).toBe("yes, let's do it");

        // The current message should be the last user message
        const lastUserMessage = pmMessages2[pmMessages2.length - 1];
        expect(lastUserMessage.role).toBe("user");
        expect(lastUserMessage.content).toBe("yes, let's do it");

        // Verify agent state tracking
        const pmState = conversation.agentStates.get("project-manager");
        expect(pmState).toBeTruthy();
        expect(pmState?.lastProcessedMessageIndex).toBe(3); // Should be at the end
    });

    it("should handle orchestrator routing correctly", async () => {
        const orchAgent = mockAgents.get("orchestrator")!;
        
        // User sends message without p-tag (goes to orchestrator)
        const userMsg: NDKEvent = {
            id: "msg-1",
            pubkey: "user-pubkey",
            content: "Help me build a new feature",
            tags: [],
            created_at: Date.now() / 1000
        } as NDKEvent;

        const conversation = await manager.createConversation(userMsg);
        
        // Build messages for orchestrator
        const { messages } = await manager.buildAgentMessages(
            conversation.id,
            orchAgent,
            userMsg
        );

        // Orchestrator should get NEW INTERACTION marker
        const hasNewInteraction = messages.some(m => 
            m.content === "=== NEW INTERACTION ==="
        );
        expect(hasNewInteraction).toBe(true);

        // No history block (first message)
        const hasHistory = messages.some(m => 
            m.content.includes("MESSAGES WHILE YOU WERE AWAY")
        );
        expect(hasHistory).toBe(false);
    });

    it("should maintain session continuity with Claude session IDs", async () => {
        const pmAgent = mockAgents.get("project-manager")!;
        
        // User message with Claude session
        const userMsg: NDKEvent = {
            id: "msg-1",
            pubkey: "user-pubkey",
            content: "Start a project",
            tags: [["p", "pm-pubkey"], ["claude-session", "session-123"]],
            created_at: Date.now() / 1000,
            tagValue: (tag: string) => {
                if (tag === "claude-session") return "session-123";
                return undefined;
            }
        } as NDKEvent;

        const conversation = await manager.createConversation(userMsg);
        
        // Build messages and check session ID is captured
        const { claudeSessionId } = await manager.buildAgentMessages(
            conversation.id,
            pmAgent,
            userMsg
        );

        expect(claudeSessionId).toBe("session-123");

        // Verify it's stored in agent state
        const pmState = conversation.agentStates.get("project-manager");
        expect(pmState?.claudeSessionId).toBe("session-123");
    });
});