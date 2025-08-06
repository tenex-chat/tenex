import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { 
    setupE2ETest, 
    cleanupE2ETest, 
    createConversation,
    executeConversationFlow,
    assertAgentSequence,
    assertPhaseTransitions,
    assertToolCalls,
    assertFeedbackPropagated,
    type E2ETestContext,
    type ExecutionTrace
} from "./test-harness";
import type { MockLLMResponse } from "@/test-utils/mock-llm/types";

describe("E2E: Executor-Verification Flow", () => {
    let context: E2ETestContext;
    
    beforeEach(async () => {
        // Setup with empty scenarios - we'll add responses dynamically
        process.env.DEBUG = 'true';
        context = await setupE2ETest([]);
        
        // Define the flow scenario
        const flowScenario: MockLLMResponse[] = [
            // 1. Orchestrator routes to executor (initial request)
            {
                trigger: {
                    systemPrompt: /You must respond with ONLY a JSON object/,
                    userMessage: /implement authentication/i
                },
                response: {
                    content: JSON.stringify({
                        agents: ["executor"],
                        phase: "execute",
                        reason: "User wants to implement authentication. Routing to executor."
                    })
                },
                priority: 100
            },
            
            // 2. Executor implements (first attempt)
            {
                trigger: {
                    agentName: "executor",
                    phase: "execute",
                    iterationCount: 1  // First time executor is called
                },
                response: {
                    content: "I've implemented a basic authentication system with login and registration endpoints using Express.js.",
                    toolCalls: [{
                        id: "1",
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
                priority: 90
            },
            
            // 3. Orchestrator routes to project-manager for verification
            {
                trigger: {
                    systemPrompt: /You must respond with ONLY a JSON object/,
                    phase: "verification",
                    previousAgent: "executor"  // After executor calls continue
                },
                response: {
                    content: JSON.stringify({
                        agents: ["project-manager"],
                        phase: "verification",
                        reason: "Executor completed implementation. Routing to project-manager for verification."
                    })
                },
                priority: 90
            },
            
            // 4. Project Manager finds issues
            {
                trigger: {
                    agentName: "project-manager",
                    phase: "verification",
                    iterationCount: 1  // First verification
                },
                response: {
                    content: "Security audit found critical issues:\n- Passwords stored in plaintext\n- No rate limiting\n- Missing CSRF protection",
                    toolCalls: [{
                        id: "2",
                        type: "function",
                        function: {
                            name: "continue",
                            arguments: JSON.stringify({
                                agents: ["orchestrator"],
                                phase: "execute",
                                reason: "Security vulnerabilities found that need fixing"
                            })
                        }
                    }]
                },
                priority: 90
            },
            
            // 5. Orchestrator routes back to executor with feedback
            {
                trigger: {
                    systemPrompt: /You must respond with ONLY a JSON object/,
                    phase: "execute",
                    previousAgent: "project-manager"  // After PM calls continue
                },
                response: {
                    content: JSON.stringify({
                        agents: ["executor"],
                        phase: "execute",
                        reason: "Project manager found security issues. Routing back to executor for fixes."
                    })
                },
                priority: 90
            },
            
            // 6. Executor fixes issues (second attempt)
            {
                trigger: {
                    agentName: "executor",
                    phase: "execute",
                    iterationCount: 2  // Second time executor is called
                },
                response: {
                    content: "Fixed security issues:\n- Implemented bcrypt for password hashing\n- Added express-rate-limit\n- Implemented CSRF tokens",
                    toolCalls: [{
                        id: "3",
                        type: "function",
                        function: {
                            name: "continue",
                            arguments: JSON.stringify({
                                agents: ["orchestrator"],
                                phase: "verification",
                                reason: "Security fixes implemented, ready for re-verification"
                            })
                        }
                    }]
                },
                priority: 85
            },
            
            // 7. Orchestrator routes to PM again
            {
                trigger: {
                    systemPrompt: /You must respond with ONLY a JSON object/,
                    phase: "verification",
                    previousAgent: "executor",
                    messageContains: /bcrypt|security fixes/i
                },
                response: {
                    content: JSON.stringify({
                        agents: ["project-manager"],
                        phase: "verification",
                        reason: "Executor implemented security fixes. Routing to project-manager for final verification."
                    })
                },
                priority: 85
            },
            
            // 8. Project Manager approves
            {
                trigger: {
                    agentName: "project-manager",
                    phase: "verification",
                    iterationCount: 2  // Second verification
                },
                response: {
                    content: "Verification complete. All security issues resolved. Authentication system approved.",
                    toolCalls: [{
                        id: "4",
                        type: "function",
                        function: {
                            name: "complete",
                            arguments: JSON.stringify({
                                summary: "Authentication system successfully implemented with proper security"
                            })
                        }
                    }]
                },
                priority: 85
            },
            
            // Default fallback for any unmatched orchestrator calls
            {
                trigger: {
                    systemPrompt: /You must respond with ONLY a JSON object/
                },
                response: {
                    content: JSON.stringify({
                        agents: ["executor"],
                        phase: "execute",
                        reason: "Default routing"
                    })
                },
                priority: 1
            }
        ];
        
        // Add all responses to mock LLM
        for (const response of flowScenario) {
            context.mockLLM.addResponse(response);
        }
    });
    
    afterEach(async () => {
        await cleanupE2ETest(context);
    });
    
    it("should handle executor → verification → fix → verification cycle", async () => {
        // Create conversation
        const conversationId = await createConversation(
            context,
            "Implement Authentication",
            "Please implement an authentication system"
        );
        
        // Execute the conversation flow
        const trace = await executeConversationFlow(
            context,
            conversationId,
            "Please implement an authentication system",
            {
                maxIterations: 10,
                onAgentExecution: (agent, phase) => {
                    console.log(`Executing ${agent} in ${phase} phase`);
                },
                onPhaseTransition: (from, to) => {
                    console.log(`Phase transition: ${from} → ${to}`);
                }
            }
        );
        
        // Verify the agent sequence
        assertAgentSequence(trace,
            "orchestrator",     // Initial routing
            "executor",        // First implementation
            "orchestrator",    // Route to verification
            "project-manager", // Find issues
            "orchestrator",    // Route back to executor
            "executor",        // Fix issues
            "orchestrator",    // Route to verification again
            "project-manager"  // Final approval
        );
        
        // Verify phase transitions
        assertPhaseTransitions(trace,
            "execute",      // Start in execute
            "verification", // Move to verification
            "execute",      // Back to execute for fixes
            "verification"  // Final verification
        );
        
        // Verify tool calls
        assertToolCalls(trace, "executor", "continue", "continue");
        assertToolCalls(trace, "project-manager", "continue", "complete");
        
        // Verify feedback was propagated
        const feedbackPropagated = assertFeedbackPropagated(
            trace,
            "project-manager",
            "executor",
            "security"
        );
        expect(feedbackPropagated).toBe(true);
        
        // Verify conversation completed
        const finalExecution = trace.executions[trace.executions.length - 1];
        expect(finalExecution.agent).toBe("project-manager");
        
        // Verify security issues were mentioned and fixed
        const executorMessages = trace.executions
            .filter(e => e.agent === "executor")
            .map(e => e.message);
        
        expect(executorMessages[0]).toContain("basic authentication");
        expect(executorMessages[1]).toContain("bcrypt");
        
        // Verify project manager feedback
        const pmMessages = trace.executions
            .filter(e => e.agent === "project-manager")
            .map(e => e.message);
        
        expect(pmMessages[0]).toContain("security");
        expect(pmMessages[0]).toContain("plaintext");
        expect(pmMessages[1]).toContain("approved");
    });
    
    it("should track iteration counts correctly", async () => {
        const conversationId = await createConversation(
            context,
            "Test Iterations",
            "Implement auth with proper security"
        );
        
        const trace = await executeConversationFlow(
            context,
            conversationId,
            "Implement auth with proper security",
            { maxIterations: 10 }
        );
        
        // Count how many times each agent was executed
        const agentCounts = new Map<string, number>();
        for (const execution of trace.executions) {
            agentCounts.set(execution.agent, (agentCounts.get(execution.agent) || 0) + 1);
        }
        
        // Orchestrator should be called 4 times (initial + after each continue)
        expect(agentCounts.get("orchestrator")).toBe(4);
        
        // Executor should be called twice (initial + fix)
        expect(agentCounts.get("executor")).toBe(2);
        
        // Project manager should be called twice (initial check + final approval)
        expect(agentCounts.get("project-manager")).toBe(2);
    });
    
    it("should handle phase transitions with proper context", async () => {
        const conversationId = await createConversation(
            context,
            "Phase Test",
            "Build authentication with testing"
        );
        
        const phaseChanges: string[] = [];
        
        const trace = await executeConversationFlow(
            context,
            conversationId,
            "Build authentication with testing",
            {
                maxIterations: 10,
                onPhaseTransition: (from, to) => {
                    phaseChanges.push(`${from}->${to}`);
                }
            }
        );
        
        // Verify we captured phase transitions
        expect(phaseChanges.length).toBeGreaterThan(0);
        expect(phaseChanges).toContain("execute->verification");
        expect(phaseChanges).toContain("verification->execute");
        
        // Verify phase transitions are recorded in trace
        expect(trace.phaseTransitions.length).toBeGreaterThan(0);
        
        // Each transition should have a reason
        for (const transition of trace.phaseTransitions) {
            expect(transition.reason).toBeTruthy();
            expect(transition.agent).toBeTruthy();
        }
    });
});