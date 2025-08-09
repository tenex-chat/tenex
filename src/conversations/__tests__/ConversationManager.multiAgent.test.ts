import { describe, it, expect, beforeEach, mock } from "bun:test";
import { ConversationManager } from "../ConversationManager";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { AgentInstance } from "@/agents/types";

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

// Mock agents
const mockAgents = new Map<string, AgentInstance>([
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
    ["tester", {
        slug: "tester",
        name: "Tester",
        pubkey: "test-pubkey",
        isOrchestrator: false,
        backend: "reason-act-loop"
    } as Agent],
    ["human-replica", {
        slug: "human-replica",
        name: "Human Replica",
        pubkey: "hr-pubkey",
        isOrchestrator: false,
        backend: "reason-act-loop"
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
        if (event.pubkey === "test-pubkey") return "tester";
        if (event.pubkey === "hr-pubkey") return "human-replica";
        return null;
    }
}));

describe("ConversationManager - Multi-Agent Conversations", () => {
    let manager: ConversationManager;
    const projectPath = "/tmp/test-project-" + Date.now();

    beforeEach(async () => {
        manager = new ConversationManager(projectPath);
        await manager.initialize();
    });

    describe("Multiple agents in same conversation", () => {
        it("should maintain separate context for each agent", async () => {
            // User starts conversation
            const userEvent1: NDKEvent = {
                id: "event-1",
                pubkey: "user-pubkey",
                content: "Let's plan a new feature",
                tags: [],
                created_at: Date.now() / 1000
            } as NDKEvent;

            const conversation = await manager.createConversation(userEvent1);

            // PM responds first
            const pmAgent = mockAgents.get("project-manager")!;
            await manager.buildAgentMessages(conversation.id, pmAgent, userEvent1);
            
            const pmResponse: NDKEvent = {
                id: "event-2",
                pubkey: "pm-pubkey",
                content: "I'll create the requirements",
                tags: [],
                created_at: Date.now() / 1000
            } as NDKEvent;
            await manager.addEvent(conversation.id, pmResponse);

            // User p-tags developer
            const userEvent2: NDKEvent = {
                id: "event-3",
                pubkey: "user-pubkey",
                content: "@developer can you estimate the work?",
                tags: [["p", "dev-pubkey"]],
                created_at: Date.now() / 1000
            } as NDKEvent;
            await manager.addEvent(conversation.id, userEvent2);

            // Developer sees full history
            const devAgent = mockAgents.get("developer")!;
            const { messages: devMessages } = await manager.buildAgentMessages(
                conversation.id,
                devAgent,
                userEvent2
            );

            // Developer should see full conversation history
            // First user message
            expect(devMessages[0].role).toBe("user");
            expect(devMessages[0].content).toBe("Let's plan a new feature");
            
            // PM's response as system message (from another agent)
            expect(devMessages[1].role).toBe("system");
            expect(devMessages[1].content).toContain("I'll create the requirements");
            
            // Current user message asking developer
            expect(devMessages[devMessages.length - 1].role).toBe("user");
            expect(devMessages[devMessages.length - 1].content).toBe("@developer can you estimate the work?");

            // Developer responds
            const devResponse: NDKEvent = {
                id: "event-4",
                pubkey: "dev-pubkey",
                content: "This will take about 2 days",
                tags: [],
                created_at: Date.now() / 1000
            } as NDKEvent;
            await manager.addEvent(conversation.id, devResponse);

            // User goes back to PM
            const userEvent3: NDKEvent = {
                id: "event-5",
                pubkey: "user-pubkey",
                content: "@project-manager what do you think?",
                tags: [["p", "pm-pubkey"]],
                created_at: Date.now() / 1000
            } as NDKEvent;
            await manager.addEvent(conversation.id, userEvent3);

            // PM should see everything that happened since their last message
            const { messages: pmMessages } = await manager.buildAgentMessages(
                conversation.id,
                pmAgent,
                userEvent3
            );

            // PM should see full conversation history
            // First user message
            expect(pmMessages[0].role).toBe("user");
            expect(pmMessages[0].content).toBe("Let's plan a new feature");
            
            // PM's own previous response as assistant
            const pmOwnMessage = pmMessages.find(m => 
                m.role === "assistant" && 
                m.content.includes("I'll create the requirements")
            );
            expect(pmOwnMessage).toBeTruthy();
            
            // User's message to developer
            const userToDevMsg = pmMessages.find(m => 
                m.role === "user" && 
                m.content.includes("@developer can you estimate")
            );
            expect(userToDevMsg).toBeTruthy();
            
            // Developer's response as system message
            const devSystemMsg = pmMessages.find(m => 
                m.role === "system" && 
                m.content.includes("This will take about 2 days")
            );
            expect(devSystemMsg).toBeTruthy();
        });

        it("should handle concurrent agent interactions correctly", async () => {
            // User p-tags multiple agents at once
            const userEvent: NDKEvent = {
                id: "event-1",
                pubkey: "user-pubkey",
                content: "@project-manager @developer please work together on this feature",
                tags: [["p", "pm-pubkey"], ["p", "dev-pubkey"]],
                created_at: Date.now() / 1000
            } as NDKEvent;

            const conversation = await manager.createConversation(userEvent);

            // Build messages for PM
            const pmAgent = mockAgents.get("project-manager")!;
            const { messages: pmMessages } = await manager.buildAgentMessages(
                conversation.id,
                pmAgent,
                userEvent
            );

            // Build messages for Developer
            const devAgent = mockAgents.get("developer")!;
            const { messages: devMessages } = await manager.buildAgentMessages(
                conversation.id,
                devAgent,
                userEvent
            );

            // Both should NOT have history (they're being directly addressed)
            const pmHasHistory = pmMessages.some(m => 
                m.content.includes("MESSAGES WHILE YOU WERE AWAY")
            );
            const devHasHistory = devMessages.some(m => 
                m.content.includes("MESSAGES WHILE YOU WERE AWAY")
            );

            expect(pmHasHistory).toBe(false);
            expect(devHasHistory).toBe(false);

            // Both should have the user message
            const pmUserMsg = pmMessages.find(m => m.role === "user");
            const devUserMsg = devMessages.find(m => m.role === "user");
            
            expect(pmUserMsg?.content).toContain("please work together");
            expect(devUserMsg?.content).toContain("please work together");
        });
    });

    describe("Agent handoffs and context sharing", () => {
        it("should preserve context when agents hand off work", async () => {
            // User asks PM to plan
            const userEvent1: NDKEvent = {
                id: "event-1",
                pubkey: "user-pubkey",
                content: "@project-manager design a login system",
                tags: [["p", "pm-pubkey"]],
                created_at: Date.now() / 1000
            } as NDKEvent;

            const conversation = await manager.createConversation(userEvent1);
            const pmAgent = mockAgents.get("project-manager")!;

            // PM responds and hands off to developer
            await manager.buildAgentMessages(conversation.id, pmAgent, userEvent1);
            
            const pmResponse: NDKEvent = {
                id: "event-2",
                pubkey: "pm-pubkey",
                content: "I've created the design. @developer please implement the login with OAuth",
                tags: [["p", "dev-pubkey"]],
                created_at: Date.now() / 1000
            } as NDKEvent;
            await manager.addEvent(conversation.id, pmResponse);

            // Developer gets context from PM
            const devAgent = mockAgents.get("developer")!;
            const { messages: devMessages } = await manager.buildAgentMessages(
                conversation.id,
                devAgent,
                pmResponse // PM's message is the triggering event
            );

            // Developer should see full conversation history
            // User's original request
            expect(devMessages[0].role).toBe("user");
            expect(devMessages[0].content).toContain("design a login system");
            
            // PM's handoff message should be the triggering event (system message from another agent)
            const lastMessage = devMessages[devMessages.length - 1];
            expect(lastMessage.role).toBe("system");
            expect(lastMessage.content).toContain("please implement the login with OAuth");

            // The PM's handoff message should be the primary message
            const handoffMsg = devMessages.find(m => m.role === "system" && 
                m.content.includes("[Project Manager]"));
            expect(handoffMsg?.content).toContain("please implement the login with OAuth");
        });
    });

    describe("Complex conversation flows", () => {
        it("should handle the reported bug scenario correctly", async () => {
            // This is the exact scenario from the bug report
            
            // 1. User p-tags project-manager
            const userEvent1: NDKEvent = {
                id: "event-1",
                pubkey: "user-pubkey",
                content: "@project-manager would you say your current PROJECT.md fits properly in what that spec should be?",
                tags: [["p", "pm-pubkey"]],
                created_at: Date.now() / 1000
            } as NDKEvent;

            const conversation = await manager.createConversation(userEvent1);
            const pmAgent = mockAgents.get("project-manager")!;

            // PM should NOT see the message in history
            const { messages: pmMessages1 } = await manager.buildAgentMessages(
                conversation.id,
                pmAgent,
                userEvent1
            );

            const pmHasHistory1 = pmMessages1.some(m => 
                m.content.includes("MESSAGES WHILE YOU WERE AWAY")
            );
            expect(pmHasHistory1).toBe(false);

            // 2. PM responds
            const pmResponse: NDKEvent = {
                id: "event-2",
                pubkey: "pm-pubkey",
                content: "Looking at the current PROJECT.md, I can see significant issues... Would you like me to help restructure this?",
                tags: [],
                created_at: Date.now() / 1000
            } as NDKEvent;
            await manager.addEvent(conversation.id, pmResponse);

            // 3. User replies
            const userEvent2: NDKEvent = {
                id: "event-3",
                pubkey: "user-pubkey",
                content: "yes, let's do it",
                tags: [],
                created_at: Date.now() / 1000
            } as NDKEvent;
            await manager.addEvent(conversation.id, userEvent2);

            // PM should see full conversation history
            const { messages: pmMessages2 } = await manager.buildAgentMessages(
                conversation.id,
                pmAgent,
                userEvent2
            );

            // Check full history is present
            // First user message
            expect(pmMessages2[0].role).toBe("user");
            expect(pmMessages2[0].content).toContain("would you say your current PROJECT.md");
            
            // PM's previous response should be an assistant message
            const assistantMsg = pmMessages2.find(m => 
                m.role === "assistant" && 
                m.content.includes("significant issues")
            );
            expect(assistantMsg).toBeTruthy();
            
            // Current user message
            const lastMsg = pmMessages2[pmMessages2.length - 1];
            expect(lastMsg.role).toBe("user");
            expect(lastMsg.content).toBe("yes, let's do it");

            // 4. User adds human-replica
            const userEvent3: NDKEvent = {
                id: "event-4",
                pubkey: "user-pubkey",
                content: "@human-replica what do you know about what happened in this conversation?",
                tags: [["p", "hr-pubkey"]],
                created_at: Date.now() / 1000
            } as NDKEvent;
            await manager.addEvent(conversation.id, userEvent3);

            // Human Replica should see full history
            const hrAgent = mockAgents.get("human-replica")!;
            const { messages: hrMessages } = await manager.buildAgentMessages(
                conversation.id,
                hrAgent,
                userEvent3
            );

            // HR should see complete conversation history
            // First user message to PM
            expect(hrMessages[0].role).toBe("user");
            expect(hrMessages[0].content).toContain("would you say your current PROJECT.md");
            
            // PM's response as system message (from another agent)
            const pmResponseMsg = hrMessages.find(m => 
                m.role === "system" && 
                m.content.includes("significant issues")
            );
            expect(pmResponseMsg).toBeTruthy();
            
            // User's "yes, let's do it" message
            const userYesMsg = hrMessages.find(m => 
                m.role === "user" && 
                m.content === "yes, let's do it"
            );
            expect(userYesMsg).toBeTruthy();
            
            // Current message asking HR
            expect(hrMessages[hrMessages.length - 1].role).toBe("user");
            expect(hrMessages[hrMessages.length - 1].content).toContain("what do you know about what happened");
        });
    });
});