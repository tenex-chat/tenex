import { mock } from "bun:test";
import path from "node:path";
import fs from "fs-extra";
import { Database } from "bun:sqlite";
import { ConversationCoordinator } from "@/conversations";
import { ConversationMessageRepository } from "@/conversations/ConversationMessageRepository";
import { AgentRegistry } from "@/agents/AgentRegistry";
import { ProjectContext } from "@/services/ProjectContext";
import { setupMockModules, createTestAgents } from "./e2e-mocks";
import type { E2ETestContext } from "./e2e-types";

/**
 * Setup E2E test environment
 */
export async function setupE2ETest(scenarios: string[] = [], defaultResponse?: string): Promise<E2ETestContext> {
    // Setup mock modules
    const { tempDir, projectPath, mockLLM, mockFiles } = await setupMockModules(scenarios, defaultResponse);
    
    // Create test agents
    const testAgents = createTestAgents();
    const [pmAgent, executorAgent, plannerAgent] = testAgents;
    
    // Mock project context with dynamic PM (first agent)
    const agentsMap = new Map([
        ["test-pm", pmAgent],      // First agent becomes PM
        ["executor", executorAgent],
        ["planner", plannerAgent]
    ]);
    
    const mockProjectContext = {
        project: { 
            id: "test-project", 
            pubkey: "test-pubkey",
            tagValue: (tag: string) => tag === "title" ? "Test Project" : null,
            tags: [
                ["title", "Test Project"],
                ["agent", "test-pm-event-id"],    // First agent tag - becomes PM
                ["agent", "executor-event-id"],
                ["agent", "planner-event-id"]
            ]
        },
        signer: { privateKey: () => "test-key" },
        pubkey: "test-pubkey",
        orchestrator: null,
        agents: agentsMap,
        projectPath,
        isProjectOwner: () => true,
        getProjectManager: () => pmAgent,  // First agent is PM
        hasPhaseSpecialist: (phase: string) => false,
        getPhaseSpecialist: (phase: string) => null,
        getAgent: (identifier: string) => agentsMap.get(identifier) || null
    } as unknown as ProjectContext;
    
    mock.module("@/services/ProjectContext", () => ({
        ProjectContext: class {
            constructor() {}
            static async create() { return mockProjectContext; }
            static instance = mockProjectContext;
        }
    }));
    
    // Initialize real components with DB
    const dbPath = path.join(tempDir, "test.db");
    const db = new Database(dbPath);
    
    // Create messages table
    db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT,
            timestamp INTEGER NOT NULL
        )
    `);
    
    const messageRepo = new ConversationMessageRepository(db);
    
    // Initialize agent registry with test agents
    const agentRegistry = new AgentRegistry();
    for (const agent of testAgents) {
        agentRegistry.registerAgent(agent);
    }
    
    // Add orchestrator
    const orchestratorAgent = {
        name: "orchestrator",
        slug: "orchestrator",
        pubkey: "orchestrator-pubkey",
        eventId: "orchestrator-event-id",
        description: "Orchestrator for E2E tests",
        role: "Orchestrator",
        instructions: "You are an orchestrator for E2E testing",
        systemPrompt: "You are an orchestrator for E2E testing",
        allowedTools: ["route"],
        tools: [],
        llmConfig: { model: "claude-3-sonnet-20240229", provider: "anthropic" }
    };
    agentRegistry.registerAgent(orchestratorAgent);
    
    // Create conversation coordinator
    const conversationCoordinator = new ConversationCoordinator(
        messageRepo,
        agentRegistry,
        mockProjectContext
    );
    
    // Cleanup function
    const cleanup = async () => {
        try {
            mock.restore();
            db.close();
            await fs.remove(tempDir);
        } catch (error) {
            console.error("Cleanup error:", error);
        }
    };
    
    return {
        mockLLM,
        conversationCoordinator,
        messageRepo,
        agentRegistry,
        projectContext: mockProjectContext,
        testAgents,
        cleanup
    };
}

/**
 * Cleanup E2E test environment
 */
export async function cleanupE2ETest(context: E2ETestContext | undefined): Promise<void> {
    if (context?.cleanup) {
        await context.cleanup();
    }
}