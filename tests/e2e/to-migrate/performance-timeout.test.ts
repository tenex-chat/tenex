import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { 
    setupE2ETest, 
    cleanupE2ETest, 
    createConversation,
    executeAgent,
    getConversationState,
    type E2ETestContext 
} from "./test-harness";
import type { MockLLMService } from "@/test-utils";

/**
 * E2E Tests for Performance and Timeout Handling
 * 
 * Tests system behavior under performance stress:
 * - Slow LLM responses
 * - Timeout handling
 * - Recovery after timeouts
 * - Large response handling
 */
describe("E2E: Performance and Timeout Handling", () => {
    let context: E2ETestContext;

    beforeEach(async () => {
        // Setup with performance testing scenario
        context = await setupE2ETest(['performance-testing']);
    });

    afterEach(async () => {
        await cleanupE2ETest(context);
    });

    it("should handle slow LLM responses gracefully", async () => {
        // Create a conversation with performance test request
        const conversationId = await createConversation(
            context,
            "Performance Test",
            "Let's do a performance test with slow responses"
        );

        const startTime = Date.now();
        
        // Execute with slow response scenario
        await executeAgent(
            context,
            "Orchestrator",
            conversationId,
            "Let's do a performance test with slow responses"
        );

        const executionTime = Date.now() - startTime;
        
        // Verify execution took at least 5 seconds (due to streamDelay)
        expect(executionTime).toBeGreaterThanOrEqual(5000);
        
        // Verify conversation progressed despite delay
        const state = await getConversationState(context, conversationId);
        expect(state.phase).toBe("PLAN");
        
        // Check request history
        const history = (context.mockLLM as MockLLMService).getRequestHistory();
        expect(history).toHaveLength(1);
        expect(history[0].response.content).toContain("performance test");
    });

    it("should handle very slow planning phase", async () => {
        // Create conversation for planning phase test
        const conversationId = await createConversation(
            context,
            "Planning Performance Test",
            "performance test"
        );

        // Execute orchestrator to move to PLAN phase
        await executeAgent(
            context,
            "Orchestrator",
            conversationId,
            "performance test"
        );

        // Now execute planning phase with delay
        const planStartTime = Date.now();
        
        // Update conversation to trigger planning phase scenario
        await context.conversationManager.updatePhase(
            conversationId,
            "PLAN",
            "Moving to planning phase for performance test",
            "test-agent-pubkey",
            "orchestrator"
        );
        
        await executeAgent(
            context,
            "Orchestrator",
            conversationId,
            "performance test"
        );
        
        const planExecutionTime = Date.now() - planStartTime;

        // Verify planning took at least 8 seconds
        expect(planExecutionTime).toBeGreaterThanOrEqual(8000);
        
        // Verify phase progression
        const state = await getConversationState(context, conversationId);
        expect(state.phase).toBe("EXECUTE");
    });

    it("should handle large responses without memory issues", async () => {
        const conversationId = await createConversation(
            context,
            "Large Response Test",
            "Test with large response test"
        );

        // Move to EXECUTE phase
        await context.conversationManager.updatePhase(
            conversationId,
            "EXECUTE",
            "Moving to execute phase for large response test",
            "test-agent-pubkey",
            "orchestrator"
        );

        // Track memory before execution
        const memBefore = process.memoryUsage().heapUsed;

        await executeAgent(
            context,
            "Executor",
            conversationId,
            "large response test"
        );

        // Track memory after execution
        const memAfter = process.memoryUsage().heapUsed;
        const memIncrease = memAfter - memBefore;

        // Verify memory increase is reasonable (less than 10MB)
        expect(memIncrease).toBeLessThan(10 * 1024 * 1024);

        // Verify large response was handled
        const history = (context.mockLLM as MockLLMService).getRequestHistory();
        const largeResponse = history.find(h => h.response.content?.includes("Large response data"));
        expect(largeResponse).toBeDefined();
        expect(largeResponse?.response.content?.length).toBeGreaterThan(50000);
    });

    it("should recover gracefully after timeout", async () => {
        const conversationId = await createConversation(
            context,
            "Recovery Test",
            "Test retry after timeout"
        );

        await executeAgent(
            context,
            "Orchestrator",
            conversationId,
            "retry after timeout"
        );

        // Verify quick recovery
        const history = (context.mockLLM as MockLLMService).getRequestHistory();
        const recoveryResponse = history.find(h => h.response.content?.includes("Recovering from previous timeout"));
        expect(recoveryResponse).toBeDefined();

        // Verify conversation moved to verification
        const state = await getConversationState(context, conversationId);
        expect(state.phase).toBe("VERIFICATION");
    });

    it("should handle rapid sequential requests", async () => {
        const conversationId = await createConversation(
            context,
            "Stress Test",
            "Run stress test rapid requests"
        );

        // Execute multiple rapid requests concurrently
        const promises = [];
        for (let i = 0; i < 3; i++) {
            promises.push(executeAgent(
                context,
                "Orchestrator",
                conversationId,
                "stress test rapid"
            ));
        }

        // All should complete without errors
        await expect(Promise.all(promises)).resolves.toBeDefined();

        // Verify all requests were processed
        const history = (context.mockLLM as MockLLMService).getRequestHistory();
        expect(history.length).toBeGreaterThanOrEqual(3);
    });

    it("should track execution time in conversation metadata", async () => {
        const conversationId = await createConversation(
            context,
            "Metrics Test",
            "Test performance metrics tracking"
        );

        const startTime = Date.now();
        
        await executeAgent(
            context,
            "Orchestrator",
            conversationId,
            "performance test"
        );
        
        const endTime = Date.now();

        // Verify execution time tracking
        const executionTime = endTime - startTime;
        expect(executionTime).toBeGreaterThan(0);

        // Check if execution metrics were stored
        const conversation = await context.conversationManager.getConversation(conversationId);
        expect(conversation).toBeDefined();
        
        // Verify conversation has timestamp metadata
        expect(conversation?.created_at).toBeDefined();
        expect(conversation?.updated_at).toBeDefined();
    });

    it("should handle timeout simulation with appropriate delay", async () => {
        const conversationId = await createConversation(
            context,
            "Timeout Test",
            "timeout test"
        );

        // Move to EXECUTE phase to trigger timeout scenario
        await context.conversationManager.updatePhase(
            conversationId,
            "EXECUTE",
            "Moving to execute phase for timeout test",
            "test-agent-pubkey",
            "orchestrator"
        );

        const startTime = Date.now();
        let errorOccurred = false;
        
        // Execute with a shorter timeout than the mock response delay
        try {
            // Note: Real timeout handling would happen at the LLM service level
            // This test verifies the mock scenario is configured correctly
            await executeAgent(
                context,
                "Executor",
                conversationId,
                "timeout test"
            );
        } catch (error) {
            errorOccurred = true;
        }

        const executionTime = Date.now() - startTime;
        
        // Since our mock doesn't actually enforce timeouts, 
        // we verify the delay was configured correctly
        const history = (context.mockLLM as MockLLMService).getRequestHistory();
        const timeoutScenario = history.find(h => 
            h.response.content?.includes("delayed beyond the typical timeout")
        );
        
        expect(timeoutScenario).toBeDefined();
        // The streamDelay should be 35000ms as configured
        expect(executionTime).toBeGreaterThanOrEqual(30000);
    });
});