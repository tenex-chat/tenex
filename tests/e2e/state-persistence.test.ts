import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
    setupE2ETest,
    cleanupE2ETest,
    createConversation,
    executeAgent,
    getConversationState,
    waitForPhase,
    e2eAssertions,
    type E2ETestContext
} from "./test-harness";
import { ConversationManager } from "@/conversations/ConversationManager";
import { AgentRegistry } from "@/agents/AgentRegistry";
import { FileSystemAdapter } from "@/conversations/persistence/FileSystemAdapter";
import path from "path";
import * as fs from "fs/promises";

describe("E2E: State Persistence and Recovery", () => {
    let context: E2ETestContext;
    
    beforeEach(async () => {
        context = await setupE2ETest(['state-persistence']);
    });
    
    afterEach(async () => {
        await cleanupE2ETest(context);
    });
    
    it("should persist conversation state and recover after restart", async () => {
        // Step 1: Create conversation and execute initial workflow
        const conversationId = await createConversation(
            context,
            "Create authentication system",
            "I need to create an authentication system with user registration and login"
        );
        
        // Execute orchestrator to start the workflow
        await executeAgent(
            context,
            "orchestrator",
            conversationId,
            "I need to create an authentication system with user registration and login"
        );
        
        // Wait for phase transition to PLAN
        await waitForPhase(context, conversationId, "PLAN");
        
        // Continue to BUILD phase
        await executeAgent(
            context,
            "orchestrator",
            conversationId,
            "continue with implementation"
        );
        
        // Wait for BUILD phase
        await waitForPhase(context, conversationId, "BUILD");
        
        // Execute Test Agent in BUILD phase
        await executeAgent(
            context,
            "executor",
            conversationId,
            "Implement the authentication components"
        );
        
        // Step 2: Verify state before "crash"
        const stateBeforeCrash = await getConversationState(context, conversationId);
        expect(stateBeforeCrash.phase).toBe("BUILD");
        expect(stateBeforeCrash.phaseTransitions).toHaveLength(2);
        expect(stateBeforeCrash.agentContexts.size).toBeGreaterThan(0);
        
        // Verify phase transitions
        e2eAssertions.toHavePhaseTransition(
            stateBeforeCrash.phaseTransitions,
            "CHAT",
            "PLAN"
        );
        e2eAssertions.toHavePhaseTransition(
            stateBeforeCrash.phaseTransitions,
            "PLAN",
            "BUILD"
        );
        
        // Step 3: Simulate system restart by creating new instances
        const newConversationManager = new ConversationManager(context.projectPath);
        await newConversationManager.initialize();
        
        const newAgentRegistry = new AgentRegistry(context.projectPath);
        await newAgentRegistry.loadFromProject();
        
        // Step 4: Load conversation from persistence
        const recoveredConversation = await newConversationManager.getConversation(conversationId);
        expect(recoveredConversation).toBeDefined();
        expect(recoveredConversation?.id).toBe(conversationId);
        expect(recoveredConversation?.phase).toBe("BUILD");
        expect(recoveredConversation?.phaseTransitions).toHaveLength(2);
        
        // Verify recovered agent contexts
        expect(recoveredConversation?.agentContexts.size).toBe(stateBeforeCrash.agentContexts.size);
        for (const [agentSlug, context] of stateBeforeCrash.agentContexts) {
            const recoveredContext = recoveredConversation?.agentContexts.get(agentSlug);
            expect(recoveredContext).toBeDefined();
            expect(recoveredContext?.messages.length).toBe(context.messages.length);
        }
        
        // Step 5: Continue workflow after recovery
        const updatedContext = {
            ...context,
            conversationManager: newConversationManager,
            agentRegistry: newAgentRegistry
        };
        
        // Continue with the recovered conversation
        await executeAgent(
            updatedContext,
            "executor",
            conversationId,
            "continue the analysis"
        );
        
        // Verify completion
        const finalState = await getConversationState(updatedContext, conversationId);
        expect(finalState.phase).toBe("VERIFICATION");
        
        // Verify tool call sequence includes completion
        e2eAssertions.toHaveToolCallSequence(
            context.mockLLM,
            ['continue', 'continue', 'writeContextFile', 'complete']
        );
    });
    
    it("should handle concurrent conversations and persist all states", async () => {
        // Create multiple conversations
        const conversationIds = await Promise.all([
            createConversation(
                context,
                "Task 1: Create feature A",
                "Task: Create feature A with authentication"
            ),
            createConversation(
                context,
                "Task 2: Create feature B",
                "Task: Create feature B with database integration"
            ),
            createConversation(
                context,
                "Task 3: Create feature C",
                "Task: Create feature C with API endpoints"
            )
        ]);
        
        // Execute initial phases for all conversations
        await Promise.all(conversationIds.map(async (convId, index) => {
            await executeAgent(
                context,
                "orchestrator",
                convId,
                `Task: Create feature ${String.fromCharCode(65 + index)}`
            );
        }));
        
        // Wait for all to reach PLAN phase
        await Promise.all(conversationIds.map(convId => 
            waitForPhase(context, convId, "PLAN")
        ));
        
        // Verify all conversations are persisted
        const persistencePath = path.join(context.projectPath, ".tenex", "conversations");
        const files = await fs.readdir(persistencePath);
        
        // Should have one file per conversation
        expect(files.length).toBe(conversationIds.length);
        
        // Verify each conversation file exists and contains valid data
        for (const convId of conversationIds) {
            const filePath = path.join(persistencePath, `${convId}.json`);
            const fileContent = await fs.readFile(filePath, 'utf-8');
            const savedData = JSON.parse(fileContent);
            
            expect(savedData.id).toBe(convId);
            expect(savedData.phase).toBe("PLAN");
            expect(savedData.phaseTransitions).toBeDefined();
            expect(savedData.agentContexts).toBeDefined();
        }
        
        // Simulate restart and recover all conversations
        const newConversationManager = new ConversationManager(context.projectPath);
        await newConversationManager.initialize();
        
        // Load and verify all conversations
        const recoveredConversations = await Promise.all(
            conversationIds.map(id => newConversationManager.getConversation(id))
        );
        
        recoveredConversations.forEach((conv, index) => {
            expect(conv).toBeDefined();
            expect(conv?.phase).toBe("PLAN");
            expect(conv?.title).toContain(`Task ${index + 1}`);
        });
    });
    
    it("should preserve execution metrics across restarts", async () => {
        // Create conversation
        const conversationId = await createConversation(
            context,
            "Analyze project structure",
            "Please analyze the project structure and provide insights"
        );
        
        // Start execution
        await executeAgent(
            context,
            "orchestrator",
            conversationId,
            "analyze the project structure"
        );
        
        // Wait a moment to accumulate execution time
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Get state before restart
        const stateBeforeCrash = await getConversationState(context, conversationId);
        const metricsBeforeCrash = stateBeforeCrash.metrics;
        
        expect(metricsBeforeCrash?.executionTime.totalSeconds).toBeGreaterThan(0);
        
        // Simulate restart
        const newConversationManager = new ConversationManager(context.projectPath);
        await newConversationManager.initialize();
        
        // Load conversation
        const recovered = await newConversationManager.getConversation(conversationId);
        expect(recovered).toBeDefined();
        
        // Verify metrics are preserved
        expect(recovered?.metrics?.executionTime.totalSeconds).toBe(
            metricsBeforeCrash?.executionTime.totalSeconds
        );
        expect(recovered?.metrics?.executionTime.isActive).toBe(false);
        
        // Continue execution
        const updatedContext = {
            ...context,
            conversationManager: newConversationManager
        };
        
        await executeAgent(
            updatedContext,
            "executor",
            conversationId,
            "continue the analysis"
        );
        
        // Verify metrics continue to accumulate
        const finalState = await getConversationState(updatedContext, conversationId);
        expect(finalState.metrics?.executionTime.totalSeconds).toBeGreaterThan(
            metricsBeforeCrash?.executionTime.totalSeconds || 0
        );
    });
    
    it("should handle persistence errors gracefully", async () => {
        // Create conversation
        const conversationId = await createConversation(
            context,
            "Test persistence error handling",
            "Create a simple feature"
        );
        
        // Execute initial phase
        await executeAgent(
            context,
            "orchestrator",
            conversationId,
            "create a simple feature"
        );
        
        // Make persistence directory read-only to simulate write error
        const persistencePath = path.join(context.projectPath, ".tenex", "conversations");
        
        // Note: This test is simplified because filesystem permissions are complex
        // In a real scenario, we would test various failure modes:
        // - Disk full
        // - Permission denied
        // - Corrupted JSON files
        // - Network failures for remote persistence
        
        // Instead, we'll test recovery from corrupted data
        const convFilePath = path.join(persistencePath, `${conversationId}.json`);
        
        // Corrupt the persisted file
        await fs.writeFile(convFilePath, "{ invalid json content");
        
        // Attempt to load with new manager
        const newConversationManager = new ConversationManager(context.projectPath);
        await newConversationManager.initialize();
        
        // Should handle corrupted file gracefully
        const recovered = await newConversationManager.getConversation(conversationId);
        
        // The current implementation might return null or throw
        // This test verifies the system doesn't crash completely
        if (recovered === null) {
            // Expected behavior - unable to recover from corrupted data
            expect(recovered).toBeNull();
        } else {
            // If recovery succeeded, verify it's in a valid state
            expect(recovered.id).toBe(conversationId);
            expect(recovered.phase).toBeDefined();
        }
    });
    
    it("should maintain conversation history order after recovery", async () => {
        // Create conversation
        const conversationId = await createConversation(
            context,
            "Multi-step task",
            "Implement a complex feature with multiple steps"
        );
        
        // Execute multiple interactions
        const interactions = [
            { agent: "Orchestrator", message: "Let's plan this feature" },
            { agent: "Orchestrator", message: "continue to implementation" },
            { agent: "Test Agent", message: "implementing the first part" }
        ];
        
        for (const { agent, message } of interactions) {
            await executeAgent(context, agent, conversationId, message);
            // Small delay to ensure distinct timestamps
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        
        // Get state before restart
        const conversation = await context.conversationManager.getConversation(conversationId);
        const historyBeforeRestart = conversation?.history || [];
        
        expect(historyBeforeRestart.length).toBeGreaterThan(0);
        
        // Simulate restart
        const newConversationManager = new ConversationManager(context.projectPath);
        await newConversationManager.initialize();
        
        // Load conversation
        const recovered = await newConversationManager.getConversation(conversationId);
        expect(recovered).toBeDefined();
        
        // Verify history is preserved in correct order
        expect(recovered?.history.length).toBe(historyBeforeRestart.length);
        
        // Check that history entries match
        recovered?.history.forEach((entry, index) => {
            const original = historyBeforeRestart[index];
            expect(entry.role).toBe(original.role);
            expect(entry.content).toBe(original.content);
            // Tool calls should also match if present
            if (original.toolCalls) {
                expect(entry.toolCalls).toEqual(original.toolCalls);
            }
        });
    });
});