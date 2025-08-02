import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { setupE2ETest, cleanupE2ETest, executeAgent, createConversation, getConversationState, type E2ETestContext } from "./test-harness";

describe("E2E: Orchestrator Simple Test", () => {
    let context: E2ETestContext;
    
    beforeEach(async () => {
        context = await setupE2ETest(["routing-decisions"]);
    });
    
    afterEach(async () => {
        await cleanupE2ETest(context);
    });
    
    it("should route orchestrator decisions correctly", async () => {
        // Create conversation
        const conversationId = await createConversation(
            context,
            "Test Error Recovery",
            "I need help with error recovery mechanisms"
        );
        
        // Execute orchestrator
        const toolCalls: any[] = [];
        await executeAgent(context, "Orchestrator", conversationId, "I need help with error recovery mechanisms", {
            onStreamToolCall: (toolCall) => {
                toolCalls.push(toolCall);
            }
        });
        
        // Get conversation state
        const state = await getConversationState(context, conversationId);
        
        // Verify routing happened
        expect(state.phase).toBe("PLAN");
        
        // Check mock LLM history
        const history = context.mockLLM.getRequestHistory();
        expect(history).toHaveLength(1);
        
        // Verify the routing decision was made correctly
        const response = history[0].response;
        expect(response.content).toContain("planner");
        
        // Parse the routing decision
        const routingDecision = JSON.parse(response.content);
        expect(routingDecision.agents).toContain("planner");
        expect(routingDecision.phase).toBe("PLAN");
        expect(routingDecision.reason).toBeTruthy();
    });
    
    it("should handle multiple routing scenarios", async () => {
        // Test infinite loop scenario
        const conversationId1 = await createConversation(
            context,
            "Test Infinite Loop",
            "Test infinite loop detection"
        );
        
        await executeAgent(context, "Orchestrator", conversationId1, "Test infinite loop detection");
        
        const state1 = await getConversationState(context, conversationId1);
        expect(state1.phase).toBe("PLAN");
        
        // Test timeout scenario
        const conversationId2 = await createConversation(
            context,
            "Test Timeout",
            "Test timeout handling"
        );
        
        await executeAgent(context, "Orchestrator", conversationId2, "Test timeout handling");
        
        const state2 = await getConversationState(context, conversationId2);
        expect(state2.phase).toBe("PLAN");
        
        // Verify both routing decisions were made
        const history = context.mockLLM.getRequestHistory();
        expect(history.length).toBeGreaterThanOrEqual(2);
        
        // Verify routing decisions
        for (const request of history) {
            const routingDecision = JSON.parse(request.response.content);
            expect(routingDecision.agents).toBeDefined();
            expect(routingDecision.agents).toHaveLength(1);
            expect(routingDecision.reason).toBeTruthy();
        }
    });
});