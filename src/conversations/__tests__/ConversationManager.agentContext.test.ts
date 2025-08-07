import { describe, it, expect, beforeEach, mock } from "bun:test";
import { ConversationManager } from "../ConversationManager";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { Agent } from "@/agents/types";
import { Message } from "multi-llm-ts";

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

// Mock project context and utils
const mockAgents = new Map<string, Agent>([
    ["project-manager", {
        slug: "project-manager",
        name: "Project Manager",
        pubkey: "pm-pubkey",
        isOrchestrator: false,
        backend: "reason-act-loop"
    } as Agent],
    ["developer", {
        slug: "developer",
        name: "Developer",
        pubkey: "dev-pubkey",
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
        agents: mockAgents
    })
}));

mock.module("@/nostr/utils", () => ({
    isEventFromUser: (event: NDKEvent) => event.pubkey === "user-pubkey",
    getAgentSlugFromEvent: (event: NDKEvent) => {
        if (event.pubkey === "pm-pubkey") return "project-manager";
        if (event.pubkey === "dev-pubkey") return "developer";
        if (event.pubkey === "orch-pubkey") return "orchestrator";
        return null;
    }
}));

describe("ConversationManager - Agent Context Management", () => {
    let manager: ConversationManager;
    const projectPath = "/tmp/test-project-" + Date.now();

    beforeEach(async () => {
        manager = new ConversationManager(projectPath);
        await manager.initialize();
    });

    describe("Agent p-tagging scenarios", () => {
        it("should NOT include current message in history when agent is directly p-tagged", async () => {
            // User creates conversation by p-tagging project-manager
            const userEvent: NDKEvent = {
                id: "event-1",
                pubkey: "user-pubkey",
                content: "@project-manager please review the code",
                tags: [["p", "pm-pubkey"]],
                created_at: Date.now() / 1000
            } as NDKEvent;

            const conversation = await manager.createConversation(userEvent);
            const pmAgent = mockAgents.get("project-manager")!;

            // Build messages for p-tagged agent
            const { messages } = await manager.buildAgentMessages(
                conversation.id,
                pmAgent,
                userEvent
            );

            // Should NOT have "MESSAGES WHILE YOU WERE AWAY" block
            const hasHistoryBlock = messages.some(m => 
                m.content.includes("MESSAGES WHILE YOU WERE AWAY")
            );
            expect(hasHistoryBlock).toBe(false);

            // Should have the user message as primary message
            const userMessage = messages.find(m => m.role === "user");
            expect(userMessage?.content).toBe("@project-manager please review the code");

            // Agent state should be at index 1 (after the triggering event)
            const agentState = conversation.agentStates.get("project-manager");
            expect(agentState?.lastProcessedMessageIndex).toBe(1);
        });

        it("should include conversation history when new agent is p-tagged mid-conversation", async () => {
            // Start conversation
            const userEvent1: NDKEvent = {
                id: "event-1",
                pubkey: "user-pubkey",
                content: "Let's build a new feature",
                tags: [],
                created_at: Date.now() / 1000
            } as NDKEvent;

            const conversation = await manager.createConversation(userEvent1);

            // Add orchestrator response
            const orchResponse: NDKEvent = {
                id: "event-2",
                pubkey: "orch-pubkey",
                content: "I'll help you with that feature",
                tags: [],
                created_at: Date.now() / 1000
            } as NDKEvent;
            await manager.addEvent(conversation.id, orchResponse);

            // User p-tags developer
            const userEvent2: NDKEvent = {
                id: "event-3",
                pubkey: "user-pubkey",
                content: "@developer can you implement this?",
                tags: [["p", "dev-pubkey"]],
                created_at: Date.now() / 1000
            } as NDKEvent;
            await manager.addEvent(conversation.id, userEvent2);

            const devAgent = mockAgents.get("developer")!;
            const { messages } = await manager.buildAgentMessages(
                conversation.id,
                devAgent,
                userEvent2
            );

            // Developer should see the full conversation history
            // First user message
            expect(messages[0].role).toBe("user");
            expect(messages[0].content).toBe("Let's build a new feature");
            
            // Orchestrator's response as system (from another agent)
            expect(messages[1].role).toBe("system");
            expect(messages[1].content).toContain("I'll help you with that feature");
            
            // Current triggering message should be last
            const lastMessage = messages[messages.length - 1];
            expect(lastMessage.role).toBe("user");
            expect(lastMessage.content).toBe("@developer can you implement this?");

        });
    });

    describe("Agent conversation continuity", () => {
        it("should show agent's own previous messages as assistant messages when continuing conversation", async () => {
            // User starts conversation with PM
            const userEvent1: NDKEvent = {
                id: "event-1",
                pubkey: "user-pubkey",
                content: "@project-manager what should we build?",
                tags: [["p", "pm-pubkey"]],
                created_at: Date.now() / 1000
            } as NDKEvent;

            const conversation = await manager.createConversation(userEvent1);
            const pmAgent = mockAgents.get("project-manager")!;

            // First interaction - build messages for PM
            await manager.buildAgentMessages(
                conversation.id,
                pmAgent,
                userEvent1
            );

            // PM responds
            const pmResponse: NDKEvent = {
                id: "event-2",
                pubkey: "pm-pubkey",
                content: "I suggest we build a task management system",
                tags: [],
                created_at: Date.now() / 1000
            } as NDKEvent;
            await manager.addEvent(conversation.id, pmResponse);

            // User continues conversation
            const userEvent2: NDKEvent = {
                id: "event-3",
                pubkey: "user-pubkey",
                content: "Yes, let's do that",
                tags: [],
                created_at: Date.now() / 1000
            } as NDKEvent;
            await manager.addEvent(conversation.id, userEvent2);

            // Build messages for PM continuation
            const { messages } = await manager.buildAgentMessages(
                conversation.id,
                pmAgent,
                userEvent2
            );

            // Should NOT have a history block (no other participants spoke while away)
            const historyBlock = messages.find(m => 
                m.content.includes("MESSAGES WHILE YOU WERE AWAY")
            );
            expect(historyBlock).toBeFalsy();

            // Should have the FULL conversation history
            // First user message
            const firstUserMsg = messages[0];
            expect(firstUserMsg.role).toBe("user");
            expect(firstUserMsg.content).toBe("@project-manager what should we build?");
            
            // PM's response as assistant
            const assistantMessage = messages[1];
            expect(assistantMessage.role).toBe("assistant");
            expect(assistantMessage.content).toBe("I suggest we build a task management system");
            
            // Current message should be the user's continuation
            const currentUserMsg = messages[messages.length - 1];
            expect(currentUserMsg.role).toBe("user");
            expect(currentUserMsg.content).toBe("Yes, let's do that");
        });

        it("should maintain context across multiple exchanges", async () => {
            // Create conversation
            const userEvent1: NDKEvent = {
                id: "event-1",
                pubkey: "user-pubkey",
                content: "Start the project",
                tags: [],
                created_at: Date.now() / 1000
            } as NDKEvent;

            const conversation = await manager.createConversation(userEvent1);
            const orchAgent = mockAgents.get("orchestrator")!;

            // Orchestrator responds
            await manager.buildAgentMessages(conversation.id, orchAgent, userEvent1);
            
            const orchResponse1: NDKEvent = {
                id: "event-2",
                pubkey: "orch-pubkey",
                content: "Starting the project setup",
                tags: [],
                created_at: Date.now() / 1000
            } as NDKEvent;
            await manager.addEvent(conversation.id, orchResponse1);

            // User continues
            const userEvent2: NDKEvent = {
                id: "event-3",
                pubkey: "user-pubkey",
                content: "Add authentication",
                tags: [],
                created_at: Date.now() / 1000
            } as NDKEvent;
            await manager.addEvent(conversation.id, userEvent2);

            // Build messages for orchestrator
            const { messages } = await manager.buildAgentMessages(
                conversation.id,
                orchAgent,
                userEvent2
            );

            // Should NOT have history block (only the orchestrator's own message)
            const historyBlock = messages.find(m => 
                m.content.includes("MESSAGES WHILE YOU WERE AWAY")
            );
            expect(historyBlock).toBeFalsy();
            
            // Orchestrator's own previous response should be an assistant message
            const assistantMessage = messages.find(m => 
                m.role === "assistant" && 
                m.content.includes("Starting the project setup")
            );
            expect(assistantMessage).toBeTruthy();
        });
    });

    describe("NEW INTERACTION marker", () => {
        it("should show NEW INTERACTION for orchestrator on fresh user message", async () => {
            const userEvent: NDKEvent = {
                id: "event-1",
                pubkey: "user-pubkey",
                content: "Hello, I need help",
                tags: [],
                created_at: Date.now() / 1000
            } as NDKEvent;

            const conversation = await manager.createConversation(userEvent);
            const orchAgent = mockAgents.get("orchestrator")!;

            const { messages } = await manager.buildAgentMessages(
                conversation.id,
                orchAgent,
                userEvent
            );

            // Should have NEW INTERACTION marker
            const hasNewInteraction = messages.some(m => 
                m.content === "=== NEW INTERACTION ==="
            );
            expect(hasNewInteraction).toBe(true);
        });

        it("should NOT show NEW INTERACTION when orchestrator is p-tagged", async () => {
            const userEvent: NDKEvent = {
                id: "event-1",
                pubkey: "user-pubkey",
                content: "@orchestrator help me",
                tags: [["p", "orch-pubkey"]],
                created_at: Date.now() / 1000
            } as NDKEvent;

            const conversation = await manager.createConversation(userEvent);
            const orchAgent = mockAgents.get("orchestrator")!;

            const { messages } = await manager.buildAgentMessages(
                conversation.id,
                orchAgent,
                userEvent
            );

            // Should NOT have NEW INTERACTION marker when directly addressed
            const hasNewInteraction = messages.some(m => 
                m.content === "=== NEW INTERACTION ==="
            );
            expect(hasNewInteraction).toBe(false);
        });

        it("should NOT show NEW INTERACTION for non-orchestrator agents", async () => {
            const userEvent: NDKEvent = {
                id: "event-1",
                pubkey: "user-pubkey",
                content: "@project-manager review this",
                tags: [["p", "pm-pubkey"]],
                created_at: Date.now() / 1000
            } as NDKEvent;

            const conversation = await manager.createConversation(userEvent);
            const pmAgent = mockAgents.get("project-manager")!;

            const { messages } = await manager.buildAgentMessages(
                conversation.id,
                pmAgent,
                userEvent
            );

            // Non-orchestrator agents should never get NEW INTERACTION
            const hasNewInteraction = messages.some(m => 
                m.content === "=== NEW INTERACTION ==="
            );
            expect(hasNewInteraction).toBe(false);
        });

        it("should NOT show NEW INTERACTION on conversation continuation", async () => {
            // Start conversation
            const userEvent1: NDKEvent = {
                id: "event-1",
                pubkey: "user-pubkey",
                content: "Start project",
                tags: [],
                created_at: Date.now() / 1000
            } as NDKEvent;

            const conversation = await manager.createConversation(userEvent1);
            const orchAgent = mockAgents.get("orchestrator")!;

            // Orchestrator responds
            await manager.buildAgentMessages(conversation.id, orchAgent, userEvent1);
            const orchResponse: NDKEvent = {
                id: "event-2",
                pubkey: "orch-pubkey",
                content: "Project started",
                tags: [],
                created_at: Date.now() / 1000
            } as NDKEvent;
            await manager.addEvent(conversation.id, orchResponse);

            // User continues
            const userEvent2: NDKEvent = {
                id: "event-3",
                pubkey: "user-pubkey",
                content: "Add more features",
                tags: [],
                created_at: Date.now() / 1000
            } as NDKEvent;
            await manager.addEvent(conversation.id, userEvent2);

            const { messages } = await manager.buildAgentMessages(
                conversation.id,
                orchAgent,
                userEvent2
            );

            // Should NOT have NEW INTERACTION on continuation
            const hasNewInteraction = messages.some(m => 
                m.content === "=== NEW INTERACTION ==="
            );
            expect(hasNewInteraction).toBe(false);
        });
    });

    describe("Claude session ID management", () => {
        it("should capture and preserve Claude session ID from triggering event", async () => {
            const pmAgent = mockAgents.get("project-manager")!;
            
            // User message with Claude session ID
            const userEvent: NDKEvent = {
                id: "event-1",
                pubkey: "user-pubkey",
                content: "@project-manager please review this",
                tags: [["p", "pm-pubkey"], ["claude-session", "session-abc-123"]],
                created_at: Date.now() / 1000,
                tagValue: (tag: string) => {
                    if (tag === "claude-session") return "session-abc-123";
                    return undefined;
                }
            } as NDKEvent;

            const conversation = await manager.createConversation(userEvent);
            
            // Build messages and verify session ID is captured
            const { claudeSessionId } = await manager.buildAgentMessages(
                conversation.id,
                pmAgent,
                userEvent
            );

            expect(claudeSessionId).toBe("session-abc-123");

            // Verify it's stored in agent state
            const agentState = conversation.agentStates.get("project-manager");
            expect(agentState?.claudeSessionId).toBe("session-abc-123");
        });

        it("should maintain separate session IDs for different agents", async () => {
            const pmAgent = mockAgents.get("project-manager")!;
            const devAgent = mockAgents.get("developer")!;
            
            // User p-tags PM with one session
            const userEvent1: NDKEvent = {
                id: "event-1",
                pubkey: "user-pubkey",
                content: "@project-manager plan this",
                tags: [["p", "pm-pubkey"], ["claude-session", "pm-session-123"]],
                created_at: Date.now() / 1000,
                tagValue: (tag: string) => {
                    if (tag === "claude-session") return "pm-session-123";
                    return undefined;
                }
            } as NDKEvent;

            const conversation = await manager.createConversation(userEvent1);
            await manager.buildAgentMessages(conversation.id, pmAgent, userEvent1);

            // PM responds
            const pmResponse: NDKEvent = {
                id: "event-2",
                pubkey: "pm-pubkey",
                content: "I'll plan this feature",
                tags: [],
                created_at: Date.now() / 1000
            } as NDKEvent;
            await manager.addEvent(conversation.id, pmResponse);

            // User p-tags developer with different session
            const userEvent2: NDKEvent = {
                id: "event-3",
                pubkey: "user-pubkey",
                content: "@developer implement this",
                tags: [["p", "dev-pubkey"], ["claude-session", "dev-session-456"]],
                created_at: Date.now() / 1000,
                tagValue: (tag: string) => {
                    if (tag === "claude-session") return "dev-session-456";
                    return undefined;
                }
            } as NDKEvent;
            await manager.addEvent(conversation.id, userEvent2);

            const { claudeSessionId: devSessionId } = await manager.buildAgentMessages(
                conversation.id,
                devAgent,
                userEvent2
            );

            // Each agent should have their own session ID
            expect(devSessionId).toBe("dev-session-456");
            
            const pmState = conversation.agentStates.get("project-manager");
            const devState = conversation.agentStates.get("developer");
            
            expect(pmState?.claudeSessionId).toBe("pm-session-123");
            expect(devState?.claudeSessionId).toBe("dev-session-456");
        });

        it("should preserve session ID across multiple interactions", async () => {
            const pmAgent = mockAgents.get("project-manager")!;
            
            // First interaction with session ID
            const userEvent1: NDKEvent = {
                id: "event-1",
                pubkey: "user-pubkey",
                content: "@project-manager start planning",
                tags: [["p", "pm-pubkey"], ["claude-session", "persistent-session"]],
                created_at: Date.now() / 1000,
                tagValue: (tag: string) => {
                    if (tag === "claude-session") return "persistent-session";
                    return undefined;
                }
            } as NDKEvent;

            const conversation = await manager.createConversation(userEvent1);
            const { claudeSessionId: session1 } = await manager.buildAgentMessages(
                conversation.id,
                pmAgent,
                userEvent1
            );
            expect(session1).toBe("persistent-session");

            // PM responds
            const pmResponse: NDKEvent = {
                id: "event-2",
                pubkey: "pm-pubkey",
                content: "Planning started",
                tags: [],
                created_at: Date.now() / 1000
            } as NDKEvent;
            await manager.addEvent(conversation.id, pmResponse);

            // Second interaction without explicit session ID
            const userEvent2: NDKEvent = {
                id: "event-3",
                pubkey: "user-pubkey",
                content: "Continue with the plan",
                tags: [],
                created_at: Date.now() / 1000
            } as NDKEvent;
            await manager.addEvent(conversation.id, userEvent2);

            // Session ID should persist
            const { claudeSessionId: session2 } = await manager.buildAgentMessages(
                conversation.id,
                pmAgent,
                userEvent2
            );
            expect(session2).toBe("persistent-session");
        });

        it("should update session ID when a new one is provided", async () => {
            const pmAgent = mockAgents.get("project-manager")!;
            
            // First interaction with session ID
            const userEvent1: NDKEvent = {
                id: "event-1",
                pubkey: "user-pubkey",
                content: "@project-manager hello",
                tags: [["p", "pm-pubkey"], ["claude-session", "old-session"]],
                created_at: Date.now() / 1000,
                tagValue: (tag: string) => {
                    if (tag === "claude-session") return "old-session";
                    return undefined;
                }
            } as NDKEvent;

            const conversation = await manager.createConversation(userEvent1);
            await manager.buildAgentMessages(conversation.id, pmAgent, userEvent1);

            // PM responds
            const pmResponse: NDKEvent = {
                id: "event-2",
                pubkey: "pm-pubkey",
                content: "Hello!",
                tags: [],
                created_at: Date.now() / 1000
            } as NDKEvent;
            await manager.addEvent(conversation.id, pmResponse);

            // New interaction with new session ID
            const userEvent2: NDKEvent = {
                id: "event-3",
                pubkey: "user-pubkey",
                content: "Let's continue",
                tags: [["claude-session", "new-session"]],
                created_at: Date.now() / 1000,
                tagValue: (tag: string) => {
                    if (tag === "claude-session") return "new-session";
                    return undefined;
                }
            } as NDKEvent;
            await manager.addEvent(conversation.id, userEvent2);

            const { claudeSessionId } = await manager.buildAgentMessages(
                conversation.id,
                pmAgent,
                userEvent2
            );

            // Should have the new session ID
            expect(claudeSessionId).toBe("new-session");
            
            const pmState = conversation.agentStates.get("project-manager");
            expect(pmState?.claudeSessionId).toBe("new-session");
        });

        it("should handle missing session IDs gracefully", async () => {
            const pmAgent = mockAgents.get("project-manager")!;
            
            // Event without session ID
            const userEvent: NDKEvent = {
                id: "event-1",
                pubkey: "user-pubkey",
                content: "@project-manager help me",
                tags: [["p", "pm-pubkey"]],
                created_at: Date.now() / 1000
            } as NDKEvent;

            const conversation = await manager.createConversation(userEvent);
            const { claudeSessionId } = await manager.buildAgentMessages(
                conversation.id,
                pmAgent,
                userEvent
            );

            // Should be undefined
            expect(claudeSessionId).toBeUndefined();
            
            const pmState = conversation.agentStates.get("project-manager");
            expect(pmState?.claudeSessionId).toBeUndefined();
        });

        it("should work with updateAgentState method", async () => {
            const pmAgent = mockAgents.get("project-manager")!;
            
            // Create conversation
            const userEvent: NDKEvent = {
                id: "event-1",
                pubkey: "user-pubkey",
                content: "@project-manager test",
                tags: [["p", "pm-pubkey"]],
                created_at: Date.now() / 1000
            } as NDKEvent;

            const conversation = await manager.createConversation(userEvent);
            await manager.buildAgentMessages(conversation.id, pmAgent, userEvent);

            // Manually update agent state with session ID
            await manager.updateAgentState(
                conversation.id,
                "project-manager",
                { claudeSessionId: "manually-set-session" }
            );

            // Verify it was updated
            const pmState = conversation.agentStates.get("project-manager");
            expect(pmState?.claudeSessionId).toBe("manually-set-session");

            // Build messages again and verify session persists
            const userEvent2: NDKEvent = {
                id: "event-2",
                pubkey: "user-pubkey",
                content: "continue",
                tags: [],
                created_at: Date.now() / 1000
            } as NDKEvent;
            await manager.addEvent(conversation.id, userEvent2);

            const { claudeSessionId } = await manager.buildAgentMessages(
                conversation.id,
                pmAgent,
                userEvent2
            );
            expect(claudeSessionId).toBe("manually-set-session");
        });
    });
});