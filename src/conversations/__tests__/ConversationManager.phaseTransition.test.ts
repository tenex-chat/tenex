import { describe, it, expect, beforeEach, mock } from "bun:test";
import { ConversationManager } from "../ConversationManager";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { PHASES } from "../phases";
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

// Setup mock agents
const mockAgents = new Map<string, AgentInstance>([
    ["project-manager", {
        slug: "project-manager",
        name: "Project Manager",
        pubkey: "pm-pubkey",
        isOrchestrator: false,
        backend: "reason-act-loop"
    } as AgentInstance],
    ["orchestrator", {
        slug: "orchestrator",
        name: "Orchestrator",
        pubkey: "orch-pubkey",
        isOrchestrator: true,
        backend: "routing"
    } as AgentInstance]
]);

// Mock project context
mock.module("@/services/ProjectContext", () => ({
    getProjectContext: () => ({
        agents: mockAgents
    })
}));

// Mock nostr utils
mock.module("@/nostr/utils", () => ({
    isEventFromUser: (event: NDKEvent) => event.pubkey === "user-pubkey",
    getAgentSlugFromEvent: (event: NDKEvent) => {
        if (event.pubkey === "pm-pubkey") return "project-manager";
        if (event.pubkey === "orch-pubkey") return "orchestrator";
        return null;
    }
}));

describe("ConversationManager - Phase Transitions", () => {
    let manager: ConversationManager;
    const projectPath = "/tmp/test-project-" + Date.now();
    
    beforeEach(async () => {
        manager = new ConversationManager(projectPath);
        await manager.initialize();
    });

    describe("Phase instruction injection", () => {
        it("should inject phase instructions when agent first enters conversation", async () => {
            const userEvent: NDKEvent = {
                id: "event-1",
                pubkey: "user-pubkey",
                content: "@project-manager let's start planning",
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

            // Should have phase instructions injected as system message
            const phaseMessage = messages.find(m => 
                m.role === "system" && 
                m.content?.includes("CURRENT PHASE")
            );
            expect(phaseMessage).toBeDefined();
            expect(phaseMessage?.content).toContain("CHAT");
        });

        it("should inject phase transition message when agent moves to new phase", async () => {
            const userEvent: NDKEvent = {
                id: "event-1",
                pubkey: "user-pubkey",
                content: "Let's start planning",
                tags: [],
                created_at: Date.now() / 1000
            } as NDKEvent;

            const conversation = await manager.createConversation(userEvent);
            const pmAgent = mockAgents.get("project-manager")!;
            
            // First interaction in CHAT phase
            await manager.buildAgentMessages(
                conversation.id,
                pmAgent,
                userEvent
            );

            // Transition to PLAN phase
            await manager.updatePhase(conversation.id, PHASES.PLAN, {
                from: PHASES.CHAT,
                to: PHASES.PLAN,
                message: "Moving to planning phase",
                timestamp: Date.now(),
                agentPubkey: "pm-pubkey",
                agentName: "Project Manager"
            });

            // Second interaction in PLAN phase
            const userEvent2: NDKEvent = {
                id: "event-2",
                pubkey: "user-pubkey",
                content: "What's the plan?",
                tags: [],
                created_at: Date.now() / 1000
            } as NDKEvent;
            await manager.addEvent(conversation.id, userEvent2);

            const { messages } = await manager.buildAgentMessages(
                conversation.id,
                pmAgent,
                userEvent2
            );

            // Should have phase transition message
            const transitionMessage = messages.find(m => 
                m.role === "system" && 
                m.content?.includes("PHASE TRANSITION")
            );
            expect(transitionMessage).toBeDefined();
            expect(transitionMessage?.content).toContain("CHAT");
            expect(transitionMessage?.content).toContain("PLAN");
        });

        it("should NOT inject phase instructions for orchestrator", async () => {
            const userEvent: NDKEvent = {
                id: "event-1",
                pubkey: "user-pubkey",
                content: "Start the project",
                tags: [],
                created_at: Date.now() / 1000
            } as NDKEvent;

            const conversation = await manager.createConversation(userEvent);
            const orchestrator = mockAgents.get("orchestrator")!;
            
            const { messages } = await manager.buildAgentMessages(
                conversation.id,
                orchestrator,
                userEvent
            );

            // Should NOT have phase instructions for orchestrator
            const phaseMessage = messages.find(m => 
                m.role === "system" && 
                (m.content?.includes("CURRENT PHASE") || m.content?.includes("PHASE TRANSITION"))
            );
            expect(phaseMessage).toBeUndefined();
        });

        it("should not re-inject phase instructions when agent continues in same phase", async () => {
            const userEvent1: NDKEvent = {
                id: "event-1",
                pubkey: "user-pubkey",
                content: "First message",
                tags: [],
                created_at: Date.now() / 1000
            } as NDKEvent;

            const conversation = await manager.createConversation(userEvent1);
            const pmAgent = mockAgents.get("project-manager")!;
            
            // First interaction
            await manager.buildAgentMessages(
                conversation.id,
                pmAgent,
                userEvent1
            );

            // Second interaction in same phase
            const userEvent2: NDKEvent = {
                id: "event-2",
                pubkey: "user-pubkey",
                content: "Second message",
                tags: [],
                created_at: Date.now() / 1000
            } as NDKEvent;
            await manager.addEvent(conversation.id, userEvent2);

            const { messages } = await manager.buildAgentMessages(
                conversation.id,
                pmAgent,
                userEvent2
            );

            // Should NOT have new phase instructions
            const phaseMessages = messages.filter(m => 
                m.role === "system" && 
                (m.content?.includes("CURRENT PHASE") || m.content?.includes("PHASE TRANSITION"))
            );
            expect(phaseMessages.length).toBe(0);
        });

        it("should preserve lastSeenPhase in agent state", async () => {
            const userEvent: NDKEvent = {
                id: "event-1",
                pubkey: "user-pubkey",
                content: "Test message",
                tags: [],
                created_at: Date.now() / 1000
            } as NDKEvent;

            const conversation = await manager.createConversation(userEvent);
            const pmAgent = mockAgents.get("project-manager")!;
            
            // Build messages - should set lastSeenPhase
            await manager.buildAgentMessages(
                conversation.id,
                pmAgent,
                userEvent
            );

            // Check agent state
            const agentState = conversation.agentStates.get(pmAgent.slug);
            expect(agentState?.lastSeenPhase).toBe(PHASES.CHAT);

            // Transition to new phase
            await manager.updatePhase(conversation.id, PHASES.PLAN, {
                from: PHASES.CHAT,
                to: PHASES.PLAN,
                message: "Moving to planning",
                timestamp: Date.now(),
                agentPubkey: "pm-pubkey",
                agentName: "Project Manager"
            });

            // New interaction in new phase
            const userEvent2: NDKEvent = {
                id: "event-2",
                pubkey: "user-pubkey",
                content: "Plan this",
                tags: [],
                created_at: Date.now() / 1000
            } as NDKEvent;
            await manager.addEvent(conversation.id, userEvent2);

            await manager.buildAgentMessages(
                conversation.id,
                pmAgent,
                userEvent2
            );

            // Check agent state updated
            const updatedState = conversation.agentStates.get(pmAgent.slug);
            expect(updatedState?.lastSeenPhase).toBe(PHASES.PLAN);
        });
    });
});