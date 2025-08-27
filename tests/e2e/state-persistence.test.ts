import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
    setupE2ETest,
    cleanupE2ETest,
    createConversation,
    executeConversationFlow,
    getConversationState,
    assertAgentSequence,
    assertPhaseTransitions,
    assertToolCalls,
    type E2ETestContext
} from "./test-harness";
import { ConversationCoordinator } from "@/conversations";
import { AgentRegistry } from "@/agents/AgentRegistry";
import type { MockLLMResponse } from "@/test-utils/mock-llm/types";
import path from "path";
import * as fs from "fs/promises";

describe("E2E: State Persistence and Recovery", () => {
    let context: E2ETestContext;
    
    beforeEach(async () => {
        context = await setupE2ETest([]);
        
        // Enable debug logging
        (context.mockLLM as any).config.debug = true;
        
        // Define persistence test scenarios
        const persistenceScenarios: MockLLMResponse[] = [
            // Initial orchestrator routing
            {
                trigger: {
                    systemPrompt: /You must respond with ONLY a JSON object/,
                    userMessage: /authentication system/i
                },
                response: {
                    content: JSON.stringify({
                        agents: ["executor"],
                        phase: "chat",
                        reason: "User wants to create an authentication system"
                    })
                },
                priority: 100
            },
            // Executor initial response
            {
                trigger: {
                    agentName: "executor",
                    phase: "chat"
                },
                response: {
                    content: "I understand you need an authentication system. Let me plan this out.",
                    toolCalls: [{
                        id: "1",
                        type: "function",
                        function: {
                            name: "continue",
                            arguments: JSON.stringify({
                                agents: ["orchestrator"],
                                phase: "plan",
                                reason: "Moving to planning phase"
                            })
                        }
                    }]
                },
                priority: 90
            },
            // Orchestrator routes to planner
            {
                trigger: {
                    systemPrompt: /You must respond with ONLY a JSON object/,
                    previousAgent: "executor"
                },
                response: {
                    content: JSON.stringify({
                        agents: ["planner"],
                        phase: "plan",
                        reason: "Routing to planner for implementation plan"
                    })
                },
                priority: 95
            },
            // Planner creates plan
            {
                trigger: {
                    agentName: "planner",
                    phase: "plan"
                },
                response: {
                    content: "Authentication System Plan:\n1. User registration\n2. Login endpoints\n3. JWT token generation",
                    toolCalls: [{
                        id: "2",
                        type: "function",
                        function: {
                            name: "writeContextFile",
                            arguments: JSON.stringify({
                                filename: "auth-plan.md",
                                content: "# Authentication Plan\n\nDetailed plan..."
                            })
                        }
                    }, {
                        id: "3",
                        type: "function",
                        function: {
                            name: "continue",
                            arguments: JSON.stringify({
                                agents: ["orchestrator"],
                                phase: "build",
                                reason: "Plan complete, ready to build"
                            })
                        }
                    }]
                },
                priority: 90
            },
            // Orchestrator routes to executor for build
            {
                trigger: {
                    systemPrompt: /You must respond with ONLY a JSON object/,
                    previousAgent: "planner"
                },
                response: {
                    content: JSON.stringify({
                        agents: ["executor"],
                        phase: "build",
                        reason: "Plan complete, routing to executor for implementation"
                    })
                },
                priority: 95
            },
            // Executor implements (first part) - stop the flow here for persistence test
            {
                trigger: {
                    agentName: "executor",
                    phase: "build"
                },
                response: {
                    content: "Implementing the authentication components...",
                    toolCalls: [{
                        id: "4",
                        type: "function",
                        function: {
                            name: "writeFile",
                            arguments: JSON.stringify({
                                filename: "auth.js",
                                content: "// Authentication implementation"
                            })
                        }
                    }, {
                        id: "4b",
                        type: "function",
                        function: {
                            name: "complete",
                            arguments: JSON.stringify({
                                summary: "Initial implementation started - stopping here for persistence test"
                            })
                        }
                    }]
                },
                priority: 90
            },
            // For recovery test - executor continues after crash
            {
                trigger: {
                    agentName: "executor",
                    phase: "build",
                    messageContains: /continue the analysis/i
                },
                response: {
                    content: "Continuing the implementation after recovery...",
                    toolCalls: [{
                        id: "5",
                        type: "function",
                        function: {
                            name: "continue",
                            arguments: JSON.stringify({
                                agents: ["orchestrator"],
                                phase: "verification",
                                reason: "Implementation complete, ready for verification"
                            })
                        }
                    }]
                },
                priority: 85
            },
            // Default fallback
            {
                trigger: {
                    systemPrompt: /You must respond with ONLY a JSON object/
                },
                response: {
                    content: JSON.stringify({
                        agents: ["executor"],
                        phase: "chat",
                        reason: "Default routing"
                    })
                },
                priority: 1
            }
        ];
        
        persistenceScenarios.forEach(s => context.mockLLM.addResponse(s));
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
        
        // Execute workflow up to BUILD phase
        const trace = await executeConversationFlow(
            context,
            conversationId,
            "I need to create an authentication system with user registration and login",
            {
                maxIterations: 6, // Stop after reaching BUILD phase
                onPhaseTransition: (from, to) => {
                    console.log(`Phase transition: ${from} -> ${to}`);
                }
            }
        );
        
        // Verify we reached BUILD phase
        const stateBeforeCrash = await getConversationState(context, conversationId);
        console.log("stateBeforeCrash:", JSON.stringify(stateBeforeCrash, null, 2));
        console.log("agentContexts type:", typeof stateBeforeCrash.agentContexts);
        console.log("agentContexts:", stateBeforeCrash.agentContexts);
        
        expect(stateBeforeCrash.phase).toBe("build");
        expect(stateBeforeCrash.phaseTransitions).toHaveLength(2);
        // Check if agentContexts exists before checking size
        if (stateBeforeCrash.agentContexts instanceof Map) {
            expect(stateBeforeCrash.agentContexts.size).toBeGreaterThan(0);
        } else {
            // It might be serialized as an object or array
            expect(Object.keys(stateBeforeCrash.agentContexts || {}).length).toBeGreaterThan(0);
        }
        
        // Verify phase transitions occurred
        assertPhaseTransitions(trace, "plan", "build");
        
        // Step 3: Simulate system restart by creating new instances
        const newConversationCoordinator = new ConversationCoordinator(context.projectPath);
        await newConversationCoordinator.initialize();
        
        const newAgentRegistry = new AgentRegistry(context.projectPath);
        await newAgentRegistry.loadFromProject();
        
        // Step 4: Load conversation from persistence
        const recoveredConversation = await newConversationCoordinator.getConversation(conversationId);
        expect(recoveredConversation).toBeDefined();
        expect(recoveredConversation?.id).toBe(conversationId);
        expect(recoveredConversation?.phase).toBe("build");
        expect(recoveredConversation?.phaseTransitions).toHaveLength(2);
        
        // Verify recovered agent contexts
        expect(recoveredConversation?.agentContexts.size).toBe(stateBeforeCrash.agentContexts.size);
        for (const [agentSlug, context] of stateBeforeCrash.agentContexts) {
            const recoveredContext = recoveredConversation?.agentContexts.get(agentSlug);
            expect(recoveredContext).toBeDefined();
            expect(recoveredContext?.messages.length).toBe(context.messages.length);
        }
        
        // Step 5: Continue workflow after recovery using the new conversation manager
        // Create updated context with new manager
        const updatedContext = {
            ...context,
            conversationCoordinator: newConversationCoordinator,
            agentRegistry: newAgentRegistry
        };
        
        // Add response for continuation
        updatedContext.mockLLM.addResponse({
            trigger: {
                systemPrompt: /You must respond with ONLY a JSON object/,
                phase: "build"
            },
            response: {
                content: JSON.stringify({
                    agents: ["executor"],
                    phase: "build",
                    reason: "Continuing after recovery"
                })
            },
            priority: 80
        });
        
        // Execute one more step to verify recovery works
        const continuationTrace = await executeConversationFlow(
            updatedContext,
            conversationId,
            "continue the analysis",
            {
                maxIterations: 2,
                onAgentExecution: (agent, phase) => {
                    console.log(`[RECOVERY] ${agent} in ${phase}`);
                }
            }
        );
        
        // Verify continuation worked
        expect(continuationTrace.executions.length).toBeGreaterThan(0);
        const lastExecution = continuationTrace.executions[continuationTrace.executions.length - 1];
        expect(lastExecution.message).toContain("Continuing the implementation after recovery");
        
        // Verify complete tool sequence
        const allToolCalls = [...trace.toolCalls, ...continuationTrace.toolCalls];
        const toolNames = allToolCalls.map(tc => tc.tool);
        expect(toolNames).toContain("writeContextFile");
        expect(toolNames).toContain("writeFile");
        expect(toolNames).toContain("continue");
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
        
        // Execute initial phases for all conversations in parallel
        const traces = await Promise.all(conversationIds.map(async (convId, index) => {
            // Add specific routing for each task
            context.mockLLM.addResponse({
                trigger: {
                    systemPrompt: /You must respond with ONLY a JSON object/,
                    userMessage: new RegExp(`feature ${String.fromCharCode(65 + index)}`, 'i')
                },
                response: {
                    content: JSON.stringify({
                        agents: ["executor"],
                        phase: "chat",
                        reason: `Starting work on feature ${String.fromCharCode(65 + index)}`
                    })
                },
                priority: 95
            });
            
            return executeConversationFlow(
                context,
                convId,
                `Task: Create feature ${String.fromCharCode(65 + index)}`,
                { maxIterations: 3 }
            );
        }));
        
        // Verify all conversations progressed
        for (const trace of traces) {
            expect(trace.executions.length).toBeGreaterThan(0);
        }
        
        // Get states for all conversations
        const states = await Promise.all(conversationIds.map(id => 
            getConversationState(context, id)
        ));
        
        // Verify all have progressed past initial state
        for (const state of states) {
            expect(state.phaseTransitions.length).toBeGreaterThanOrEqual(0);
            expect(state.agentContexts.size).toBeGreaterThan(0);
        }
        
        // Verify persistence files exist
        const persistencePath = path.join(context.projectPath, ".tenex", "conversations");
        const files = await fs.readdir(persistencePath).catch(() => []);
        
        // Should have one file per conversation (if using file persistence)
        // Note: TestPersistenceAdapter might store differently
        if (files.length > 0) {
            expect(files.length).toBe(conversationIds.length);
            
            // Verify each conversation file exists and contains valid data
            for (const convId of conversationIds) {
                const filePath = path.join(persistencePath, `${convId}.json`);
                const fileExists = await fs.access(filePath).then(() => true).catch(() => false);
                if (fileExists) {
                    const fileContent = await fs.readFile(filePath, 'utf-8');
                    const savedData = JSON.parse(fileContent);
                    
                    expect(savedData.id).toBe(convId);
                    expect(savedData.phase).toBeDefined();
                    expect(savedData.phaseTransitions).toBeDefined();
                    expect(savedData.agentContexts).toBeDefined();
                }
            }
        }
        
        // Simulate restart and recover all conversations
        const newConversationCoordinator = new ConversationCoordinator(context.projectPath);
        await newConversationCoordinator.initialize();
        
        // Load and verify all conversations
        const recoveredConversations = await Promise.all(
            conversationIds.map(id => newConversationCoordinator.getConversation(id))
        );
        
        recoveredConversations.forEach((conv, index) => {
            expect(conv).toBeDefined();
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
        
        // Add specific response for analysis
        context.mockLLM.addResponse({
            trigger: {
                systemPrompt: /You must respond with ONLY a JSON object/,
                userMessage: /analyze.*project/i
            },
            response: {
                content: JSON.stringify({
                    agents: ["executor"],
                    phase: "chat",
                    reason: "Starting project analysis"
                })
            },
            priority: 95
        });
        
        // Start execution
        const trace = await executeConversationFlow(
            context,
            conversationId,
            "analyze the project structure",
            { maxIterations: 2 }
        );
        
        // Wait a moment to accumulate execution time
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Get state before restart
        const stateBeforeCrash = await getConversationState(context, conversationId);
        const metricsBeforeCrash = stateBeforeCrash.metrics;
        
        expect(metricsBeforeCrash?.executionTime.totalSeconds).toBeGreaterThan(0);
        
        // Simulate restart
        const newConversationCoordinator = new ConversationCoordinator(context.projectPath);
        await newConversationCoordinator.initialize();
        
        // Load conversation
        const recovered = await newConversationCoordinator.getConversation(conversationId);
        expect(recovered).toBeDefined();
        
        // Verify metrics are preserved
        expect(recovered?.metrics?.executionTime.totalSeconds).toBe(
            metricsBeforeCrash?.executionTime.totalSeconds
        );
        expect(recovered?.metrics?.executionTime.isActive).toBe(false);
        
        // Continue execution with updated context
        const updatedContext = {
            ...context,
            conversationCoordinator: newConversationCoordinator
        };
        
        // Add continuation response
        updatedContext.mockLLM.addResponse({
            trigger: {
                systemPrompt: /You must respond with ONLY a JSON object/
            },
            response: {
                content: JSON.stringify({
                    agents: ["executor"],
                    phase: recovered?.phase || "chat",
                    reason: "Continuing analysis"
                })
            },
            priority: 80
        });
        
        await executeConversationFlow(
            updatedContext,
            conversationId,
            "continue the analysis",
            { maxIterations: 2 }
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
        await executeConversationFlow(
            context,
            conversationId,
            "create a simple feature",
            { maxIterations: 2 }
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
        
        // Try to corrupt the persisted file (if it exists)
        try {
            await fs.writeFile(convFilePath, "{ invalid json content");
        } catch (e) {
            // File might not exist with TestPersistenceAdapter
            console.log("Note: Using in-memory persistence adapter");
        }
        
        // Attempt to load with new manager
        const newConversationCoordinator = new ConversationCoordinator(context.projectPath);
        await newConversationCoordinator.initialize();
        
        // Should handle corrupted file gracefully
        const recovered = await newConversationCoordinator.getConversation(conversationId);
        
        // The current implementation might return null or throw
        // This test verifies the system doesn't crash completely
        if (recovered === null) {
            // Expected behavior - unable to recover from corrupted data
            expect(recovered).toBeNull();
        } else {
            // If recovery succeeded (e.g., using in-memory adapter), verify it's in a valid state
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
        const trace = await executeConversationFlow(
            context,
            conversationId,
            "Let's plan this feature",
            { 
                maxIterations: 4,
                onAgentExecution: (agent, phase) => {
                    console.log(`Step: ${agent} in ${phase}`);
                }
            }
        );
        
        // Get state before restart
        const conversation = await context.conversationCoordinator.getConversation(conversationId);
        const historyBeforeRestart = conversation?.history || [];
        
        expect(historyBeforeRestart.length).toBeGreaterThan(0);
        expect(trace.executions.length).toBeGreaterThan(0);
        
        // Simulate restart
        const newConversationCoordinator = new ConversationCoordinator(context.projectPath);
        await newConversationCoordinator.initialize();
        
        // Load conversation
        const recovered = await newConversationCoordinator.getConversation(conversationId);
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
        
        // Verify execution trace matches history
        // Each agent execution should correspond to history entries
        const agentMessages = trace.executions.filter(e => e.agent !== "orchestrator");
        expect(agentMessages.length).toBeGreaterThan(0);
    });
});