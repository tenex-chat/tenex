import { mock } from "bun:test";
import path from "node:path";
import fs from "fs-extra";
import { Database } from "bun:sqlite";
import { ConversationCoordinator } from "@/conversations";
import { ConversationMessageRepository } from "@/conversations/ConversationMessageRepository";
import { AgentRegistry } from "@/agents/AgentRegistry";
import type { AgentInstance } from "@/agents/types";
import { ProjectContext } from "@/services/ProjectContext";
import { setupMockModules, createTestAgents } from "./e2e-mocks";
import type { E2ETestContext, TestEnvironmentCleanupResult } from "./e2e-types";
import {
    createProjectTagAccessor,
    createSignerPrivateKeyAccessor,
    createProjectOwnershipChecker,
    createProjectManagerAccessor,
    createPhaseSpecialistChecker,
    createPhaseSpecialistAccessor,
    createAgentIdentifierResolver
} from "./e2e-helpers";

/**
 * Setup E2E test environment
 */
export async function setupE2ETest(scenarios: string[] = [], defaultResponse?: string): Promise<E2ETestContext> {
    // Setup mock modules
    const { tempDir, projectPath, mockLLM } = await setupMockModules(scenarios, defaultResponse);
    
    // Create test agents
    const testAgents = createTestAgents();
    const [pmAgent, executorAgent, plannerAgent] = testAgents;
    
    // Mock project context with dynamic PM (first agent)
    const agentsMap = new Map([
        ["test-pm", pmAgent],      // First agent becomes PM
        ["executor", executorAgent],
        ["planner", plannerAgent]
    ]);
    
    const getProjectTagValue = createProjectTagAccessor("Test Project");
    const getSignerPrivateKey = createSignerPrivateKeyAccessor("test-key");
    const checkIsProjectOwner = createProjectOwnershipChecker(true);
    const getProjectManager = createProjectManagerAccessor(pmAgent);
    const checkHasPhaseSpecialist = createPhaseSpecialistChecker();
    const getPhaseSpecialist = createPhaseSpecialistAccessor();
    const getAgentByIdentifier = createAgentIdentifierResolver(agentsMap);
    
    const mockProjectContext = {
        project: { 
            id: "test-project", 
            pubkey: "test-pubkey",
            tagValue: getProjectTagValue,
            tags: [
                ["title", "Test Project"],
                ["agent", "test-pm-event-id"],    // First agent tag - becomes PM
                ["agent", "executor-event-id"],
                ["agent", "planner-event-id"]
            ]
        },
        signer: { privateKey: getSignerPrivateKey },
        pubkey: "test-pubkey",
        orchestrator: null,
        agents: agentsMap,
        projectPath,
        isProjectOwner: checkIsProjectOwner,
        getProjectManager: getProjectManager,
        hasPhaseSpecialist: checkHasPhaseSpecialist,
        getPhaseSpecialist: getPhaseSpecialist,
        getAgent: getAgentByIdentifier
    } as unknown as ProjectContext;
    
    mock.module("@/services/ProjectContext", () => ({
        ProjectContext: class {
            constructor() {}
            static async create(): Promise<typeof mockProjectContext> { 
                return mockProjectContext; 
            }
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
    const agentRegistry = new AgentRegistry(projectPath);
    for (const agent of testAgents) {
        agentRegistry.registerAgent(agent);
    }
    
    // Add orchestrator
    const orchestratorAgent: AgentInstance = {
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
    
    async function cleanupTestEnvironment(): Promise<TestEnvironmentCleanupResult> {
        const result: TestEnvironmentCleanupResult = {
            mocksRestored: false,
            databaseClosed: false,
            tempDirectoryRemoved: false,
            errors: []
        };

        try {
            mock.restore();
            result.mocksRestored = true;
        } catch (error) {
            result.errors?.push(error instanceof Error ? error : new Error(String(error)));
        }

        try {
            db.close();
            result.databaseClosed = true;
        } catch (error) {
            result.errors?.push(error instanceof Error ? error : new Error(String(error)));
        }

        try {
            await fs.remove(tempDir);
            result.tempDirectoryRemoved = true;
        } catch (error) {
            result.errors?.push(error instanceof Error ? error : new Error(String(error)));
        }

        if (result.errors && result.errors.length > 0) {
            console.error("Cleanup errors:", result.errors);
        }

        return result;
    }
    
    return {
        mockLLM,
        conversationCoordinator,
        messageRepo,
        agentRegistry,
        projectContext: mockProjectContext,
        testAgents,
        cleanup: async (): Promise<void> => {
            await cleanupTestEnvironment();
        }
    };
}

export async function cleanupE2ETestEnvironment(context: E2ETestContext | undefined): Promise<TestEnvironmentCleanupResult | undefined> {
    if (!context?.cleanup) {
        return undefined;
    }
    
    await context.cleanup();
    return {
        mocksRestored: true,
        databaseClosed: true,
        tempDirectoryRemoved: true
    };
}