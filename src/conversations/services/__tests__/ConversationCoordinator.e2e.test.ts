import { describe, expect, it, beforeEach, afterEach, jest } from "@jest/globals";
import { ConversationCoordinator } from "../ConversationCoordinator";
import { ConversationStore } from "../ConversationStore";
import { ConversationPersistenceService, InMemoryPersistenceAdapter } from "../ConversationPersistenceService";
import { PhaseManager } from "../PhaseManager";
import { ConversationEventProcessor } from "../ConversationEventProcessor";
import { OrchestratorTurnTracker } from "../OrchestratorTurnTracker";
import { MockAgentResolver } from "../AgentResolver";
import { PHASES } from "../../phases";
import type { AgentInstance } from "@/agents/types";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import type { ExecutionQueueManager } from "../../executionQueue";

// Mock getProjectContext to avoid initialization issues
jest.mock("@/services", () => ({
    getProjectContext: jest.fn(() => ({
        pubkey: "project_pubkey",
        agents: new Map([
            ["orchestrator", { pubkey: "orch_pubkey" }],
            ["specialist", { pubkey: "spec_pubkey" }]
        ])
    })),
    isProjectContextInitialized: jest.fn(() => true)
}));

describe("ConversationCoordinator E2E", () => {
    let coordinator: ConversationCoordinator;
    let store: ConversationStore;
    let persistence: ConversationPersistenceService;
    let phaseManager: PhaseManager;
    let eventProcessor: ConversationEventProcessor;
    let turnTracker: OrchestratorTurnTracker;
    let agentResolver: MockAgentResolver;
    let mockQueueManager: jest.Mocked<ExecutionQueueManager>;

    // Mock agents
    const orchestratorAgent: AgentInstance = {
        id: "orchestrator",
        slug: "orchestrator",
        name: "Orchestrator",
        pubkey: "orch_pubkey",
        isOrchestrator: true,
        systemPrompt: "You are the orchestrator",
        tools: [],
        modelPreferences: {}
    };

    const specialistAgent: AgentInstance = {
        id: "specialist",
        slug: "specialist",
        name: "Specialist",
        pubkey: "spec_pubkey",
        isOrchestrator: false,
        systemPrompt: "You are a specialist",
        tools: [],
        modelPreferences: {}
    };

    beforeEach(async () => {
        // Create services
        store = new ConversationStore();
        persistence = new ConversationPersistenceService(new InMemoryPersistenceAdapter());
        
        // Mock queue manager
        mockQueueManager = {
            requestExecution: jest.fn().mockResolvedValue({ granted: true }),
            releaseExecution: jest.fn().mockResolvedValue(undefined),
            on: jest.fn(),
            off: jest.fn(),
            emit: jest.fn()
        } as any;

        phaseManager = new PhaseManager(mockQueueManager);
        eventProcessor = new ConversationEventProcessor();
        turnTracker = new OrchestratorTurnTracker();
        agentResolver = new MockAgentResolver([orchestratorAgent, specialistAgent]);

        // Create coordinator
        coordinator = new ConversationCoordinator(
            store,
            persistence,
            phaseManager,
            eventProcessor,
            turnTracker,
            agentResolver,
            mockQueueManager
        );

        await coordinator.initialize();
    });

    describe("Complete conversation workflow", () => {
        it("should handle conversation creation and phase transitions", async () => {
            // Create initial event
            const initialEvent = new NDKEvent();
            initialEvent.id = "event1";
            initialEvent.content = "Help me build a feature";
            initialEvent.created_at = Date.now();
            initialEvent.kind = 14;
            initialEvent.tags = [
                ["t", "user"],
                ["title", "Feature Request"]
            ];

            // Create conversation
            const conversation = await coordinator.createConversation(initialEvent);
            expect(conversation).toBeDefined();
            expect(conversation.id).toBe("event1");
            expect(conversation.title).toBe("Feature Request");
            expect(conversation.phase).toBe(PHASES.CHAT);
            expect(conversation.history).toHaveLength(1);

            // Verify it's stored
            const retrieved = coordinator.getConversation("event1");
            expect(retrieved).toBe(conversation);

            // Transition to PLAN phase
            const transitioned = await coordinator.updatePhase(
                "event1",
                PHASES.PLAN,
                "Let's plan this feature",
                "orch_pubkey",
                "Orchestrator",
                "Moving to planning"
            );
            expect(transitioned).toBe(true);

            const updated = coordinator.getConversation("event1");
            expect(updated?.phase).toBe(PHASES.PLAN);
            expect(updated?.phaseTransitions).toHaveLength(1);
        });

        it.skip("should handle agent message building", async () => {
            // Create conversation
            const initialEvent = new NDKEvent();
            initialEvent.id = "event2";
            initialEvent.content = "User request";
            initialEvent.created_at = Date.now();
            initialEvent.kind = 14;
            initialEvent.pubkey = "user_pubkey";
            initialEvent.tags = [["t", "user"]];

            const conversation = await coordinator.createConversation(initialEvent);

            // Add agent response
            const agentEvent = new NDKEvent();
            agentEvent.id = "agent_response";
            agentEvent.content = "I'll help with that";
            agentEvent.created_at = Date.now();
            agentEvent.kind = 14;
            agentEvent.pubkey = "spec_pubkey";
            agentEvent.tags = [["agent", "specialist"]];

            await coordinator.addEvent("event2", agentEvent);

            // Build messages for orchestrator
            const { messages } = await coordinator.buildAgentMessages(
                "event2",
                orchestratorAgent,
                agentEvent
            );

            expect(messages.length).toBeGreaterThan(0);
            
            // Should include user message and agent response
            const contents = messages.map(m => m.content).join(" ");
            expect(contents).toContain("User request");
            expect(contents).toContain("I'll help with that");
        });

        it("should handle orchestrator turn tracking", async () => {
            // Create conversation
            const initialEvent = new NDKEvent();
            initialEvent.id = "event3";
            initialEvent.content = "Build a calculator";
            initialEvent.created_at = Date.now();

            const conversation = await coordinator.createConversation(initialEvent);

            // Start orchestrator turn
            const turnId = await coordinator.startOrchestratorTurn(
                "event3",
                PHASES.EXECUTE,
                ["specialist"],
                "Implementing calculator"
            );

            expect(turnId).toBeTruthy();

            // Add completion
            await coordinator.addCompletionToTurn(
                "event3",
                "specialist",
                "Calculator implemented successfully"
            );

            // Build routing context
            const routingContext = await coordinator.buildOrchestratorRoutingContext("event3");
            
            expect(routingContext.user_request).toBe("Build a calculator");
            expect(routingContext.routing_history).toHaveLength(1);
            expect(routingContext.current_routing).toBeNull();
        });

        it("should handle execution queue for EXECUTE phase", async () => {
            // Create conversation
            const initialEvent = new NDKEvent();
            initialEvent.id = "event4";
            initialEvent.content = "Execute task";
            initialEvent.created_at = Date.now();

            const conversation = await coordinator.createConversation(initialEvent);

            // Try to transition to EXECUTE
            const transitioned = await coordinator.updatePhase(
                "event4",
                PHASES.EXECUTE,
                "Starting execution",
                "spec_pubkey",
                "Specialist"
            );

            expect(transitioned).toBe(true);
            expect(mockQueueManager.requestExecution).toHaveBeenCalledWith(
                "event4",
                "spec_pubkey"
            );

            // Transition back to CHAT
            await coordinator.updatePhase(
                "event4",
                PHASES.CHAT,
                "Execution complete",
                "spec_pubkey",
                "Specialist",
                "done"
            );

            expect(mockQueueManager.releaseExecution).toHaveBeenCalledWith(
                "event4",
                "done"
            );
        });

        it("should handle conversation queuing when execution queue is full", async () => {
            // Mock queue being full
            mockQueueManager.requestExecution.mockResolvedValue({
                granted: false,
                queuePosition: 3,
                waitTime: 180
            });

            // Create conversation
            const initialEvent = new NDKEvent();
            initialEvent.id = "event5";
            initialEvent.content = "Execute when ready";
            initialEvent.created_at = Date.now();

            const conversation = await coordinator.createConversation(initialEvent);

            // Try to transition to EXECUTE
            const transitioned = await coordinator.updatePhase(
                "event5",
                PHASES.EXECUTE,
                "Requesting execution",
                "spec_pubkey",
                "Specialist"
            );

            expect(transitioned).toBe(false);

            const conv = coordinator.getConversation("event5");
            expect(conv?.metadata.queueStatus).toBeDefined();
            expect(conv?.metadata.queueStatus?.isQueued).toBe(true);
            expect(conv?.metadata.queueStatus?.position).toBe(3);
        });

        it("should persist and reload conversations", async () => {
            // Create conversation
            const initialEvent = new NDKEvent();
            initialEvent.id = "event6";
            initialEvent.content = "Persistent conversation";
            initialEvent.created_at = Date.now();

            await coordinator.createConversation(initialEvent);
            
            // Add metadata
            await coordinator.updateMetadata("event6", {
                summary: "Updated summary",
                requirements: "Build something"
            });

            // Create new coordinator with same persistence
            const newCoordinator = new ConversationCoordinator(
                new ConversationStore(),
                persistence,
                new PhaseManager(),
                new ConversationEventProcessor(),
                new OrchestratorTurnTracker(),
                agentResolver
            );

            await newCoordinator.initialize();

            // Should have loaded the conversation
            const loaded = newCoordinator.getConversation("event6");
            expect(loaded).toBeDefined();
            expect(loaded?.metadata.summary).toBe("Updated summary");
            expect(loaded?.metadata.requirements).toBe("Build something");
        });

        it("should handle conversation search", async () => {
            // Create multiple conversations
            const event1 = new NDKEvent();
            event1.id = "search1";
            event1.content = "Build feature";
            event1.tags = [["title", "Feature Alpha"]];

            const event2 = new NDKEvent();
            event2.id = "search2";
            event2.content = "Bug fix";
            event2.tags = [["title", "Feature Beta"]];

            const event3 = new NDKEvent();
            event3.id = "search3";
            event3.content = "Documentation";
            event3.tags = [["title", "Docs Update"]];

            await coordinator.createConversation(event1);
            await coordinator.createConversation(event2);
            await coordinator.createConversation(event3);

            // Search for "Feature"
            const results = await coordinator.searchConversations("Feature");
            expect(results).toHaveLength(2);
            
            const titles = results.map(c => c.title);
            expect(titles).toContain("Feature Alpha");
            expect(titles).toContain("Feature Beta");
        });

        it("should clean up completed conversations", async () => {
            // Create conversation
            const initialEvent = new NDKEvent();
            initialEvent.id = "event7";
            initialEvent.content = "Temporary task";
            initialEvent.created_at = Date.now();

            await coordinator.createConversation(initialEvent);

            // Add some metadata that should be cleaned
            await coordinator.updateMetadata("event7", {
                readFiles: ["file1.ts", "file2.ts"],
                queueStatus: {
                    isQueued: true,
                    position: 1,
                    estimatedWait: 60,
                    message: "Queued"
                }
            });

            // Complete the conversation
            await coordinator.completeConversation("event7");

            // Should be removed from store
            const conv = coordinator.getConversation("event7");
            expect(conv).toBeUndefined();
        });

        it("should handle conversation archiving", async () => {
            // Create conversation
            const initialEvent = new NDKEvent();
            initialEvent.id = "event8";
            initialEvent.content = "Archive me";
            initialEvent.created_at = Date.now();

            await coordinator.createConversation(initialEvent);
            expect(coordinator.getConversation("event8")).toBeDefined();

            // Archive it
            await coordinator.archiveConversation("event8");

            // Should be removed from active store
            expect(coordinator.getConversation("event8")).toBeUndefined();

            // But should be marked as archived in persistence
            const allMetadata = await persistence['adapter'].list();
            const archived = allMetadata.find(m => m.id === "event8");
            expect(archived?.archived).toBe(true);
        });

        it("should handle phase transition history correctly", async () => {
            // Create conversation
            const initialEvent = new NDKEvent();
            initialEvent.id = "event9";
            initialEvent.content = "Multi-phase task";
            initialEvent.created_at = Date.now();

            const conversation = await coordinator.createConversation(initialEvent);

            // Transition through multiple phases
            await coordinator.updatePhase("event9", PHASES.PLAN, "Planning", "orch_pubkey", "Orchestrator");
            await coordinator.updatePhase("event9", PHASES.EXECUTE, "Executing", "spec_pubkey", "Specialist");
            await coordinator.updatePhase("event9", PHASES.REFLECTION, "Reflecting", "orch_pubkey", "Orchestrator");
            await coordinator.updatePhase("event9", PHASES.CHAT, "Complete", "spec_pubkey", "Specialist");

            const final = coordinator.getConversation("event9");
            expect(final?.phase).toBe(PHASES.CHAT);
            expect(final?.phaseTransitions).toHaveLength(4);
            
            // Verify transition history
            const transitions = final?.phaseTransitions || [];
            expect(transitions[0].to).toBe(PHASES.PLAN);
            expect(transitions[1].to).toBe(PHASES.EXECUTE);
            expect(transitions[2].to).toBe(PHASES.REFLECTION);
            expect(transitions[3].to).toBe(PHASES.CHAT);
        });
    });

    describe("Error handling", () => {
        it("should handle non-existent conversation gracefully", async () => {
            const conv = coordinator.getConversation("nonexistent");
            expect(conv).toBeUndefined();

            // These should throw
            await expect(coordinator.addEvent("nonexistent", new NDKEvent()))
                .rejects.toThrow("Conversation nonexistent not found");

            await expect(coordinator.updatePhase("nonexistent", PHASES.PLAN, "msg", "pub", "agent"))
                .rejects.toThrow("Conversation nonexistent not found");
        });

        it("should handle invalid phase transitions", async () => {
            const initialEvent = new NDKEvent();
            initialEvent.id = "event10";
            initialEvent.content = "Test";
            initialEvent.created_at = Date.now();

            const conversation = await coordinator.createConversation(initialEvent);
            
            // Force an invalid phase
            conversation.phase = "INVALID" as any;

            const result = await coordinator.updatePhase(
                "event10",
                PHASES.CHAT,
                "Try to transition",
                "pub",
                "agent"
            );

            expect(result).toBe(false);
        });
    });
});