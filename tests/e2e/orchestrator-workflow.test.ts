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
import { logger } from "@/utils/logger";

describe("E2E: Orchestrator Workflow", () => {
    let context: E2ETestContext;
    
    beforeEach(async () => {
        logger.info("Setting up E2E test environment");
        context = await setupE2ETest(['orchestrator-workflow']);
    });
    
    afterEach(async () => {
        logger.info("Cleaning up E2E test environment");
        await cleanupE2ETest(context);
    });
    
    it("should complete full workflow from CHAT to VERIFICATION", async () => {
        logger.info("Starting orchestrator workflow test");
        
        // Step 1: Create conversation with initial request
        const conversationId = await createConversation(
            context,
            "Create Authentication System",
            "I need to create a user authentication system with JWT and OAuth support"
        );
        
        const initialState = await getConversationState(context, conversationId);
        expect(initialState.phase).toBe("CHAT");
        expect(initialState.phaseTransitions).toHaveLength(0);
        
        // Step 2: Execute Orchestrator to handle initial request
        logger.info("Executing Orchestrator for initial request");
        
        const toolCalls: string[] = [];
        await executeAgent(
            context,
            "Orchestrator",
            conversationId,
            "I need to create a user authentication system with JWT and OAuth support",
            {
                onStreamToolCall: (toolCall) => {
                    logger.debug("Tool call:", toolCall);
                    toolCalls.push(toolCall.function.name);
                }
            }
        );
        
        // Verify Orchestrator decided to continue in CHAT phase
        expect(toolCalls).toContain("continue");
        
        // Step 3: Execute assigned agent (Executor in CHAT phase)
        logger.info("Executing Executor in CHAT phase");
        
        await executeAgent(
            context,
            "Executor",
            conversationId,
            "JWT-based auth with OAuth providers like Google and GitHub",
            {
                onStreamContent: (content) => {
                    logger.debug("Executor response:", content);
                }
            }
        );
        
        // Step 4: Orchestrator should transition to PLAN phase
        logger.info("Checking phase transition to PLAN");
        
        await executeAgent(
            context,
            "Orchestrator",
            conversationId,
            "Continue with planning",
            {}
        );
        
        await waitForPhase(context, conversationId, "PLAN");
        
        const planState = await getConversationState(context, conversationId);
        expect(planState.phase).toBe("PLAN");
        e2eAssertions.toHavePhaseTransition(
            planState.phaseTransitions,
            "CHAT",
            "PLAN"
        );
        
        // Step 5: Execute Planner
        logger.info("Executing Planner");
        
        await executeAgent(
            context,
            "Planner",
            conversationId,
            "Create implementation plan",
            {}
        );
        
        // Step 6: Transition to EXECUTE phase
        logger.info("Transitioning to EXECUTE phase");
        
        await executeAgent(
            context,
            "Orchestrator",
            conversationId,
            "Continue with execution",
            {}
        );
        
        await waitForPhase(context, conversationId, "EXECUTE");
        
        // Step 7: Execute implementation
        logger.info("Executing implementation");
        
        await executeAgent(
            context,
            "Executor",
            conversationId,
            "Implement the authentication system",
            {}
        );
        
        // Step 8: Run tests/verification
        logger.info("Running verification");
        
        await executeAgent(
            context,
            "Executor",
            conversationId,
            "Run tests and verify implementation",
            {}
        );
        
        // Step 9: Transition to VERIFICATION
        logger.info("Transitioning to VERIFICATION phase");
        
        await executeAgent(
            context,
            "Orchestrator",
            conversationId,
            "Continue with verification",
            {}
        );
        
        await waitForPhase(context, conversationId, "VERIFICATION");
        
        // Step 10: Complete verification
        logger.info("Completing verification");
        
        await executeAgent(
            context,
            "Executor",
            conversationId,
            "Verify the implementation is complete and working",
            {}
        );
        
        // Final assertions
        const finalState = await getConversationState(context, conversationId);
        expect(finalState.phase).toBe("VERIFICATION");
        expect(finalState.phaseTransitions).toHaveLength(3);
        
        // Verify complete tool sequence
        e2eAssertions.toHaveToolCallSequence(
            context.mockLLM,
            ["continue", "complete", "continue", "writeContextFile", "complete", "continue", "writeFile", "shell", "complete", "continue", "complete", "endConversation"]
        );
        
        // Check metrics
        expect(finalState.metrics.toolCallsCount).toBeGreaterThan(10);
        expect(finalState.metrics.errorsCount).toBe(0);
        
        logger.info("Orchestrator workflow test completed successfully");
    }, 30000); // 30 second timeout for full workflow
    
    it("should handle phase transition with review feedback", async () => {
        logger.info("Testing phase transition with review");
        
        // Create conversation starting in PLAN phase
        const conversationId = await createConversation(
            context,
            "Review Authentication Plan",
            "Review and refine the authentication plan"
        );
        
        // Manually set to PLAN phase for this test
        const conversation = await context.conversationManager.getConversation(conversationId);
        if (conversation) {
            await context.conversationManager.updatePhase(
                conversationId,
                "PLAN",
                "Starting in PLAN phase for review test"
            );
        }
        
        // Execute Planner with a plan that needs review
        await executeAgent(
            context,
            "Planner",
            conversationId,
            "Create a basic plan that might need improvements",
            {}
        );
        
        // Orchestrator should evaluate the plan
        const toolCalls: string[] = [];
        await executeAgent(
            context,
            "Orchestrator",
            conversationId,
            "Review the plan and decide next steps",
            {
                onStreamToolCall: (toolCall) => {
                    toolCalls.push(toolCall.function.name);
                }
            }
        );
        
        // Verify orchestrator made a routing decision
        expect(toolCalls).toContain("continue");
        
        const state = await getConversationState(context, conversationId);
        logger.info(`Current phase after review: ${state.phase}`);
    });
});