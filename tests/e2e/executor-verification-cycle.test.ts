import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { 
    setupE2ETest, 
    cleanupE2ETest, 
    executeAgent, 
    createConversation, 
    getConversationState, 
    type E2ETestContext 
} from "./test-harness";
import type { MockLLMResponse } from "@/test-utils/mock-llm/types";

// Create a custom scenario for executor-verification cycle
const executorVerificationScenario: MockLLMResponse[] = [
    // Default response for any unmatched orchestrator request
    {
        trigger: {
            systemPrompt: /You must respond with ONLY a JSON object/
        },
        response: {
            content: JSON.stringify({
                agents: ["executor"],
                phase: "execute",
                reason: "Default routing to executor"
            })
        },
        priority: 1
    },
    // 1. Orchestrator initial routing to executor
    {
        trigger: {
            agentName: "orchestrator",
            userMessage: /implement authentication system/i
        },
        response: {
            content: JSON.stringify({
                agents: ["executor"],
                phase: "execute",
                reason: "User wants to implement an authentication system. Routing to executor for implementation."
            })
        },
        priority: 100
    },
    
    // 2. Executor implements (first attempt)
    {
        trigger: {
            agentName: "executor",
            phase: "execute",
            messageContains: /implement authentication/i
        },
        response: {
            content: "I've implemented a basic authentication system with login and registration endpoints.",
            toolCalls: [{
                id: "1",
                type: "function",
                function: {
                    name: "continue",
                    arguments: JSON.stringify({
                        agents: ["orchestrator"],
                        phase: "verification",
                        reason: "Initial implementation complete, ready for verification"
                    })
                }
            }]
        },
        priority: 90
    },
    
    // 3. Orchestrator routes to project-manager for verification
    {
        trigger: {
            agentName: "orchestrator",
            phase: "verification",
            messageContains: /basic authentication system/i
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
            messageContains: /basic authentication/i
        },
        response: {
            content: "Security audit identified critical issues:\n- Passwords stored in plaintext\n- No rate limiting on login attempts\n- Missing CSRF protection",
            toolCalls: [{
                id: "2",
                type: "function",
                function: {
                    name: "continue",
                    arguments: JSON.stringify({
                        agents: ["orchestrator"],
                        phase: "execute",
                        reason: "Found security vulnerabilities that need to be fixed before deployment"
                    })
                }
            }]
        },
        priority: 90
    },
    
    // 5. Orchestrator routes back to executor with feedback
    {
        trigger: {
            agentName: "orchestrator",
            phase: "execute",
            messageContains: /security vulnerabilities/i
        },
        response: {
            content: JSON.stringify({
                agents: ["executor"],
                phase: "execute",
                reason: "Project manager identified security issues. Routing back to executor to implement fixes."
            })
        },
        priority: 90
    },
    
    // 6. Executor fixes the issues
    {
        trigger: {
            agentName: "executor",
            phase: "execute",
            messageContains: /security/i
        },
        response: {
            content: "Fixed all security issues:\n- Implemented bcrypt for password hashing\n- Added rate limiting with express-rate-limit\n- Implemented CSRF token validation",
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
    
    // 7. Orchestrator routes to project-manager again
    {
        trigger: {
            agentName: "orchestrator",
            phase: "verification",
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
            messageContains: /bcrypt|rate limiting/i
        },
        response: {
            content: "Verification complete. All security issues have been properly addressed. The authentication system is ready for deployment.",
            toolCalls: [{
                id: "4",
                type: "function",
                function: {
                    name: "complete",
                    arguments: JSON.stringify({
                        summary: "Authentication system successfully implemented with proper security measures"
                    })
                }
            }]
        },
        priority: 85
    }
];

describe("E2E: Executor-Verification Cycle", () => {
    let context: E2ETestContext;
    
    beforeEach(async () => {
        // Setup with our custom scenario
        context = await setupE2ETest([], { debug: true }); // Enable debug for troubleshooting
        // Add our custom responses to the mock LLM
        for (const response of executorVerificationScenario) {
            context.mockLLM.addResponse(response);
        }
    });
    
    afterEach(async () => {
        await cleanupE2ETest(context);
    });
    
    it("should handle executor → verification → fix → verification cycle", async () => {
        // Create initial conversation
        const conversationId = await createConversation(
            context,
            "Implement Authentication",
            "Please implement an authentication system"
        );
        
        // Track all agent executions
        const agentExecutions: string[] = [];
        const phaseTransitions: string[] = [];
        
        // Execute orchestrator with initial request
        await executeAgent(
            context, 
            "orchestrator", 
            conversationId, 
            "Please implement an authentication system",
            {
                onStreamContent: (content) => {
                    // Track which agents are being invoked
                    if (content.includes("executor")) {
                        agentExecutions.push("executor");
                    } else if (content.includes("project-manager")) {
                        agentExecutions.push("project-manager");
                    }
                }
            }
        );
        
        // Get conversation state after first orchestrator decision
        let state = await getConversationState(context, conversationId);
        phaseTransitions.push(state.phase);
        
        // Simulate the full cycle by checking mock LLM history
        const history = context.mockLLM.getRequestHistory();
        
        // Verify the flow happened correctly
        expect(history.length).toBeGreaterThanOrEqual(3); // At least orchestrator, executor, orchestrator again
        
        // Check that we had the right sequence of agents
        const agentSequence = history.map(h => {
            // Extract agent name from the request
            const systemMessage = h.messages?.find((m: any) => m.role === 'system');
            if (systemMessage?.content) {
                // Parse agent name from system prompt
                const agentMatch = systemMessage.content.match(/You are ([^,\.]+)/);
                return agentMatch ? agentMatch[1] : 'unknown';
            }
            return 'unknown';
        });
        
        console.log("Agent execution sequence:", agentSequence);
        
        // Verify phase transitions occurred
        expect(state.phaseTransitions).toBeDefined();
        expect(state.phaseTransitions.length).toBeGreaterThan(0);
        
        // Verify the conversation went through the expected phases
        const phases = state.phaseTransitions.map((t: any) => t.toPhase);
        expect(phases).toContain("execute");
        expect(phases).toContain("verification");
        
        // Check that feedback was captured in the conversation
        const messages = state.messages || [];
        const hasSecurityFeedback = messages.some((m: any) => 
            m.content?.includes("security") || m.content?.includes("plaintext")
        );
        expect(hasSecurityFeedback).toBe(true);
        
        // Verify the fix was attempted
        const hasSecurityFix = messages.some((m: any) => 
            m.content?.includes("bcrypt") || m.content?.includes("rate limiting")
        );
        expect(hasSecurityFix).toBe(true);
    });
    
    it("should preserve feedback context between agent transitions", async () => {
        const conversationId = await createConversation(
            context,
            "Test Feedback Flow",
            "Implement authentication system with security"
        );
        
        // Execute initial orchestrator routing
        await executeAgent(context, "orchestrator", conversationId, "Implement authentication system with security");
        
        // Check mock LLM history to ensure feedback flows correctly
        const history = context.mockLLM.getRequestHistory();
        
        // Find project manager's feedback
        const pmFeedback = history.find(h => 
            h.response.content?.includes("security audit") || 
            h.response.content?.includes("plaintext")
        );
        expect(pmFeedback).toBeDefined();
        
        // Find executor's fix response  
        const executorFix = history.find(h =>
            h.response.content?.includes("bcrypt") ||
            h.response.content?.includes("Fixed all security")
        );
        
        // If we found both, verify the fix came after the feedback
        if (pmFeedback && executorFix) {
            const pmIndex = history.indexOf(pmFeedback);
            const fixIndex = history.indexOf(executorFix);
            expect(fixIndex).toBeGreaterThan(pmIndex);
        }
    });
});