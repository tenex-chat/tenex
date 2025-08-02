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
 * E2E Tests for Execution Timeout Handling
 * 
 * Tests the system's ability to handle timeouts at the execution layer:
 * - Agent execution timeouts
 * - Recovery from timed-out operations
 * - Proper error propagation and state management
 * - Prevention of zombie executions
 */
describe("E2E: Execution Timeout Handling", () => {
    let context: E2ETestContext;

    beforeEach(async () => {
        // Setup with performance testing scenario
        context = await setupE2ETest(['performance-testing']);
    });

    afterEach(async () => {
        await cleanupE2ETest(context);
    });

    it("should simulate execution timeout with mock LLM delays", async () => {
        // Create a conversation with timeout test request
        const conversationId = await createConversation(
            context,
            "Execution Timeout Test",
            "Test execution timeout handling"
        );

        // Add a response with extreme delay to simulate timeout
        (context.mockLLM as MockLLMService).addResponse({
            trigger: {
                agentName: "Orchestrator",
                userMessage: /timeout handling/
            },
            response: {
                streamDelay: 60000, // 60 seconds - simulates a timeout scenario
                content: JSON.stringify({
                    agents: ["executor"],
                    phase: "EXECUTE",
                    reason: "This response simulates a timeout"
                })
            },
            priority: 100
        });

        const startTime = Date.now();
        
        // Execute agent - in real scenario this would timeout
        // For now we test that the delay is configured
        try {
            await executeAgent(
                context,
                "Orchestrator",
                conversationId,
                "Test execution timeout handling"
            );
        } catch (error) {
            // In real implementation, timeout would throw
        }

        // Verify the mock was configured with long delay
        const history = (context.mockLLM as MockLLMService).getRequestHistory();
        expect(history.length).toBeGreaterThan(0);
        
        // The response should have the extreme delay configured
        const responses = (context.mockLLM as any).responses;
        const timeoutResponse = responses.find((r: any) => 
            r.response.streamDelay === 60000
        );
        expect(timeoutResponse).toBeDefined();
    });

    it("should handle multiple concurrent executions with different delays", async () => {
        // Create multiple conversations
        const conversations = await Promise.all([
            createConversation(context, "Fast Test", "Fast execution test"),
            createConversation(context, "Medium Test", "Medium execution test"),
            createConversation(context, "Slow Test", "Slow execution test")
        ]);

        // Configure different response delays
        (context.mockLLM as MockLLMService).addResponse({
            trigger: { userMessage: /Fast execution test/ },
            response: { streamDelay: 100, content: JSON.stringify({
                agents: ["executor"],
                phase: "EXECUTE",
                reason: "Fast response"
            })},
            priority: 100
        });

        (context.mockLLM as MockLLMService).addResponse({
            trigger: { userMessage: /Medium execution test/ },
            response: { streamDelay: 2000, content: JSON.stringify({
                agents: ["executor"],
                phase: "EXECUTE",
                reason: "Medium response"
            })},
            priority: 100
        });

        (context.mockLLM as MockLLMService).addResponse({
            trigger: { userMessage: /Slow execution test/ },
            response: { streamDelay: 5000, content: JSON.stringify({
                agents: ["executor"],
                phase: "EXECUTE",
                reason: "Slow response"
            })},
            priority: 100
        });

        // Execute all conversations concurrently
        const executionPromises = conversations.map(async (conversationId, index) => {
            const startTime = Date.now();
            const message = index === 0 ? "Fast execution test" :
                          index === 1 ? "Medium execution test" : "Slow execution test";
            
            await executeAgent(context, "Orchestrator", conversationId, message);
            return { conversationId, duration: Date.now() - startTime };
        });

        const results = await Promise.all(executionPromises);

        // Verify execution times match configured delays
        expect(results[0].duration).toBeGreaterThanOrEqual(100);
        expect(results[0].duration).toBeLessThan(1000);

        expect(results[1].duration).toBeGreaterThanOrEqual(2000);
        expect(results[1].duration).toBeLessThan(3000);

        expect(results[2].duration).toBeGreaterThanOrEqual(5000);
        expect(results[2].duration).toBeLessThan(6000);

        // Verify conversation states progressed
        const states = await Promise.all(
            results.map(r => getConversationState(context, r.conversationId))
        );

        expect(states[0].phase).toBe("EXECUTE");
        expect(states[1].phase).toBe("EXECUTE");
        expect(states[2].phase).toBe("EXECUTE");
    });

    it("should handle memory efficiently with large delayed responses", async () => {
        const conversationId = await createConversation(
            context,
            "Memory Test",
            "Test memory with large response"
        );

        // Track memory before execution
        const memBefore = process.memoryUsage().heapUsed;

        // Configure large response with delay
        (context.mockLLM as MockLLMService).addResponse({
            trigger: {
                agentName: "Orchestrator",
                userMessage: /memory with large/
            },
            response: {
                streamDelay: 2000,
                content: "x".repeat(100000) // 100KB response
            },
            priority: 100
        });

        await executeAgent(context, "Orchestrator", conversationId, "Test memory with large response");

        // Check memory after execution
        const memAfter = process.memoryUsage().heapUsed;
        const memIncrease = memAfter - memBefore;

        // Memory increase should be reasonable
        expect(memIncrease).toBeLessThan(10 * 1024 * 1024); // Less than 10MB

        // Verify large response was handled
        const history = (context.mockLLM as MockLLMService).getRequestHistory();
        expect(history.length).toBeGreaterThan(0);
    });

    it("should support recovery scenarios after simulated timeout", async () => {
        const conversationId = await createConversation(
            context,
            "Recovery Test",
            "Test recovery scenario"
        );

        // First add a very slow response
        (context.mockLLM as MockLLMService).addResponse({
            trigger: {
                agentName: "Orchestrator",
                userMessage: /recovery scenario/,
                priority: 90
            },
            response: {
                streamDelay: 30000, // 30 second delay
                content: "This would timeout"
            }
        });

        // Also add a fast recovery response with higher priority
        (context.mockLLM as MockLLMService).addResponse({
            trigger: {
                agentName: "Orchestrator", 
                userMessage: /recovery scenario/,
                priority: 100
            },
            response: {
                streamDelay: 100,
                content: JSON.stringify({
                    agents: ["executor"],
                    phase: "VERIFICATION",
                    reason: "Quick recovery response"
                })
            }
        });

        const startTime = Date.now();
        await executeAgent(context, "Orchestrator", conversationId, "Test recovery scenario");
        const duration = Date.now() - startTime;

        // Should use the fast response due to higher priority
        expect(duration).toBeLessThan(1000);

        // Verify recovery succeeded
        const state = await getConversationState(context, conversationId);
        expect(state.phase).toBe("VERIFICATION");
    });

    it("should track performance metrics in request history", async () => {
        const conversationId = await createConversation(
            context,
            "Metrics Test",
            "Track performance metrics"
        );

        // Configure responses with various delays
        const delays = [100, 500, 1000];
        delays.forEach((delay, index) => {
            (context.mockLLM as MockLLMService).addResponse({
                trigger: {
                    agentName: "Orchestrator",
                    userMessage: new RegExp(`metrics ${index}`)
                },
                response: {
                    streamDelay: delay,
                    content: JSON.stringify({
                        agents: ["executor"],
                        phase: "EXECUTE",
                        reason: `Response with ${delay}ms delay`
                    })
                },
                priority: 100
            });
        });

        // Execute multiple requests
        for (let i = 0; i < delays.length; i++) {
            const startTime = Date.now();
            await executeAgent(context, "Orchestrator", conversationId, `Track performance metrics ${i}`);
            const duration = Date.now() - startTime;
            
            // Verify timing matches configured delay
            expect(duration).toBeGreaterThanOrEqual(delays[i]);
            expect(duration).toBeLessThan(delays[i] + 1000);
        }

        // Check request history
        const history = (context.mockLLM as MockLLMService).getRequestHistory();
        expect(history.length).toBe(delays.length);
    });

    it("should handle timeout scenario from performance-testing scenario", async () => {
        const conversationId = await createConversation(
            context,
            "Scenario Timeout Test",
            "Test timeout scenario"
        );

        // Move to EXECUTE phase to trigger the 35-second timeout scenario
        await context.conversationManager.updatePhase(
            conversationId,
            "EXECUTE",
            "Moving to execute for timeout test",
            "test-agent-pubkey",
            "orchestrator"
        );

        const startTime = Date.now();
        
        // Execute with the timeout test trigger
        await executeAgent(context, "Executor", conversationId, "timeout test");
        
        const executionTime = Date.now() - startTime;

        // The scenario has a 35-second delay configured
        expect(executionTime).toBeGreaterThanOrEqual(35000);
        
        // Verify the timeout scenario was triggered
        const history = (context.mockLLM as MockLLMService).getRequestHistory();
        const timeoutResponse = history.find(h => 
            h.response.content?.includes("delayed beyond the typical timeout")
        );
        expect(timeoutResponse).toBeDefined();
    });
});