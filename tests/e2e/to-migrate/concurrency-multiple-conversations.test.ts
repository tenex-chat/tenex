import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
    setupE2ETest,
    cleanupE2ETest,
    createConversation,
    executeAgent,
    getConversationState,
    type E2ETestContext
} from "./test-harness";
import { logger } from "@/utils/logger";

describe("E2E: Concurrent Multiple Conversations", () => {
    let context: E2ETestContext;
    
    beforeEach(async () => {
        logger.info("Setting up E2E test environment for concurrency test");
        context = await setupE2ETest(['concurrency-workflow']);
    });
    
    afterEach(async () => {
        logger.info("Cleaning up E2E test environment");
        await cleanupE2ETest(context);
    });

    it("should handle multiple simultaneous conversations without interference", async () => {
        logger.info("Starting concurrent conversation test");
        
        // Step 1: Create two conversations with different requests
        const conversationA = await createConversation(
            context,
            "Authentication System for User A",
            "Please create a user authentication system for User A"
        );
        
        const conversationB = await createConversation(
            context,
            "Payment Processing for User B",
            "Please implement payment processing for User B"
        );
        
        // Verify both conversations are created
        const stateA = await getConversationState(context, conversationA);
        const stateB = await getConversationState(context, conversationB);
        
        expect(stateA.phase).toBe("chat");
        expect(stateB.phase).toBe("chat");
        
        // Step 2: Execute both conversations concurrently
        const executionPromises = [
            executeAgent(
                context,
                "orchestrator",
                conversationA,
                "Please create a user authentication system for User A"
            ),
            executeAgent(
                context,
                "orchestrator",
                conversationB,
                "Please implement payment processing for User B"
            )
        ];
        
        await Promise.all(executionPromises);
        
        // Step 3: Continue executing both workflows in parallel
        const workflowA = async () => {
            let currentState = await getConversationState(context, conversationA);
            while (currentState.phase !== "complete" && currentState.phase !== "verification") {
                const activeAgent = currentState.currentAgent || "orchestrator";
                await executeAgent(context, activeAgent, conversationA);
                currentState = await getConversationState(context, conversationA);
            }
            return currentState;
        };
        
        const workflowB = async () => {
            let currentState = await getConversationState(context, conversationB);
            while (currentState.phase !== "complete" && currentState.phase !== "verification") {
                const activeAgent = currentState.currentAgent || "orchestrator";
                await executeAgent(context, activeAgent, conversationB);
                currentState = await getConversationState(context, conversationB);
            }
            return currentState;
        };
        
        const [finalStateA, finalStateB] = await Promise.all([workflowA(), workflowB()]);

        // Step 4: Verify both conversations reached expected phases
        expect(finalStateA.phase).toBe("verification");
        expect(finalStateB.phase).toBe("verification");
        
        // Verify phase transitions for User A
        expect(finalStateA.phaseTransitions).toContainEqual(
            expect.objectContaining({
                from: "chat",
                to: "plan",
            })
        );
        expect(finalStateA.phaseTransitions).toContainEqual(
            expect.objectContaining({
                from: "plan",
                to: "implementation",
            })
        );
        expect(finalStateA.phaseTransitions).toContainEqual(
            expect.objectContaining({
                from: "implementation",
                to: "verification",
            })
        );
        
        // Verify phase transitions for User B
        expect(finalStateB.phaseTransitions).toContainEqual(
            expect.objectContaining({
                from: "chat",
                to: "plan",
            })
        );
        expect(finalStateB.phaseTransitions).toContainEqual(
            expect.objectContaining({
                from: "plan",
                to: "implementation",
            })
        );
        expect(finalStateB.phaseTransitions).toContainEqual(
            expect.objectContaining({
                from: "implementation",
                to: "verification",
            })
        );
        
        // Step 5: Verify conversations didn't interfere with each other
        const historyA = context.mockLLM.getRequestHistory().filter(h => 
            h.messages.some(m => m.content?.includes("User A"))
        );
        const historyB = context.mockLLM.getRequestHistory().filter(h => 
            h.messages.some(m => m.content?.includes("User B"))
        );
        
        expect(historyA.length).toBeGreaterThan(0);
        expect(historyB.length).toBeGreaterThan(0);
        
        // Verify correct content isolation
        const messagesA = finalStateA.messages;
        const messagesB = finalStateB.messages;
        
        expect(messagesA.some(m => m.content.includes("authentication"))).toBe(true);
        expect(messagesA.some(m => m.content.includes("User A"))).toBe(true);
        expect(messagesA.every(m => !m.content.includes("payment"))).toBe(true);
        expect(messagesA.every(m => !m.content.includes("User B"))).toBe(true);
        
        expect(messagesB.some(m => m.content.includes("payment"))).toBe(true);
        expect(messagesB.some(m => m.content.includes("User B"))).toBe(true);
        expect(messagesB.every(m => !m.content.includes("authentication"))).toBe(true);
        expect(messagesB.every(m => !m.content.includes("User A"))).toBe(true);
    }, 30000); // Extended timeout for concurrent operations

    it("should handle conversation isolation with shared resources", async () => {
        logger.info("Testing conversation isolation with multiple users");
        
        // Create three conversations to test resource contention
        const conversations = await Promise.all([
            createConversation(
                context,
                "Auth System for User A",
                "Please create a user authentication system for User A"
            ),
            createConversation(
                context,
                "Payment for User B",
                "Please implement payment processing for User B"
            ),
            createConversation(
                context,
                "Payment for User C",
                "Please implement payment processing for User C"
            )
        ]);
        
        // Execute all conversations concurrently
        const executeConversation = async (conversationId: string, userLabel: string) => {
            const content = userLabel === "A" 
                ? "Please create a user authentication system for User A"
                : `Please implement payment processing for User ${userLabel}`;
            
            await executeAgent(context, "Orchestrator", conversationId, content);
            
            let state = await getConversationState(context, conversationId);
            while (state.phase !== "complete" && state.phase !== "verification") {
                const activeAgent = state.currentAgent || "orchestrator";
                await executeAgent(context, activeAgent, conversationId);
                state = await getConversationState(context, conversationId);
            }
            return state;
        };
        
        const finalStates = await Promise.all([
            executeConversation(conversations[0], "A"),
            executeConversation(conversations[1], "B"),
            executeConversation(conversations[2], "C")
        ]);
        
        // All should reach verification phase
        finalStates.forEach(state => {
            expect(state.phase).toBe("verification");
            expect(state.messages.length).toBeGreaterThan(0);
        });
        
        // Verify no cross-contamination between conversations
        const labels = ["A", "B", "C"];
        finalStates.forEach((state, index) => {
            const currentLabel = labels[index];
            const otherLabels = labels.filter((_, i) => i !== index);
            
            state.messages.forEach(msg => {
                // Should contain references to current user
                expect(msg.content).toContain(`User ${currentLabel}`);
                
                // Should not contain references to other users
                otherLabels.forEach(otherLabel => {
                    expect(msg.content).not.toContain(`User ${otherLabel}`);
                });
            });
        });
    }, 45000); // Extended timeout for multiple concurrent operations

    it("should handle race conditions in phase transitions", async () => {
        logger.info("Testing race conditions in phase transitions");
        
        // Create two conversations that will transition at similar times
        const convA = await createConversation(
            context,
            "Race Test A",
            "Please create a user authentication system for User A"
        );
        
        const convB = await createConversation(
            context,
            "Race Test B",
            "Please implement payment processing for User B"
        );
        
        // Execute with minimal delays to simulate race conditions
        const executeWithTiming = async (conversationId: string, label: string, delay: number) => {
            await new Promise(resolve => setTimeout(resolve, delay));
            
            const content = label === "A"
                ? "Please create a user authentication system for User A"
                : "Please implement payment processing for User B";
            
            await executeAgent(context, "Orchestrator", conversationId, content);
            
            let state = await getConversationState(context, conversationId);
            while (state.phase !== "complete" && state.phase !== "verification") {
                // Add small random delays to increase race condition likelihood
                await new Promise(resolve => setTimeout(resolve, Math.random() * 10));
                
                const activeAgent = state.currentAgent || "orchestrator";
                await executeAgent(context, activeAgent, conversationId);
                state = await getConversationState(context, conversationId);
            }
            return state;
        };
        
        // Execute both with minimal timing differences
        const [finalA, finalB] = await Promise.all([
            executeWithTiming(convA, "A", 0),
            executeWithTiming(convB, "B", 5)
        ]);
        
        // Both should reach verification despite race conditions
        expect(finalA.phase).toBe("verification");
        expect(finalB.phase).toBe("verification");
        
        // Verify phase transition integrity
        const expectedTransitions = [
            { from: "chat", to: "plan" },
            { from: "plan", to: "implementation" },
            { from: "implementation", to: "verification" }
        ];
        
        [finalA, finalB].forEach(state => {
            // Each expected transition should occur exactly once
            expectedTransitions.forEach(expected => {
                const transitions = state.phaseTransitions.filter(
                    t => t.from === expected.from && t.to === expected.to
                );
                expect(transitions.length).toBe(1);
            });
            
            // No duplicate or out-of-order transitions
            expect(state.phaseTransitions.length).toBe(expectedTransitions.length);
        });
    }, 30000);
});