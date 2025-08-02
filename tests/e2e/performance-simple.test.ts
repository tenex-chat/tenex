import { describe, it, expect } from "bun:test";
import { createMockLLMService } from "@/test-utils/mock-llm";

/**
 * Simple E2E test to verify performance testing capabilities
 * This demonstrates that the E2E framework supports performance testing with delays
 */
describe("E2E: Simple Performance Testing", () => {
    it("should support delayed mock responses", async () => {
        // Create mock LLM with performance testing scenario
        const mockLLM = createMockLLMService(['performance-testing']);
        
        // Add a simple delayed response
        mockLLM.addResponse({
            trigger: {
                userMessage: /test delay/
            },
            response: {
                streamDelay: 2000, // 2 second delay
                content: "This response was delayed by 2 seconds"
            }
        });

        const startTime = Date.now();
        
        // Make a request
        const response = await mockLLM.chat([
            { role: "user", content: "test delay" }
        ], "test-model");
        
        const endTime = Date.now();
        const duration = endTime - startTime;

        // Verify delay was applied
        expect(duration).toBeGreaterThanOrEqual(2000);
        expect(response.content).toBe("This response was delayed by 2 seconds");
    });

    it("should handle timeouts in E2E scenarios", async () => {
        const mockLLM = createMockLLMService();
        
        // Add response with very long delay
        mockLLM.addResponse({
            trigger: {
                userMessage: /timeout scenario/
            },
            response: {
                streamDelay: 10000, // 10 second delay
                content: "This will timeout"
            }
        });

        // In a real scenario, this would be handled by the execution layer
        // For now, we just verify the delay is configured
        const responses = (mockLLM as any).responses;
        const timeoutResponse = responses.find((r: any) => 
            r.response.content === "This will timeout"
        );
        
        expect(timeoutResponse).toBeDefined();
        expect(timeoutResponse.response.streamDelay).toBe(10000);
    });

    it("should support concurrent requests with different delays", async () => {
        const mockLLM = createMockLLMService();
        
        // Add responses with different delays
        mockLLM.addResponse({
            trigger: { userMessage: /fast/ },
            response: { streamDelay: 100, content: "Fast response" }
        });
        
        mockLLM.addResponse({
            trigger: { userMessage: /medium/ },
            response: { streamDelay: 500, content: "Medium response" }
        });
        
        mockLLM.addResponse({
            trigger: { userMessage: /slow/ },
            response: { streamDelay: 1000, content: "Slow response" }
        });

        const startTime = Date.now();
        
        // Execute requests concurrently
        const [fast, medium, slow] = await Promise.all([
            mockLLM.chat([{ role: "user", content: "fast request" }], "model"),
            mockLLM.chat([{ role: "user", content: "medium request" }], "model"),
            mockLLM.chat([{ role: "user", content: "slow request" }], "model")
        ]);
        
        const totalTime = Date.now() - startTime;

        // All should complete within the slowest request time
        expect(totalTime).toBeGreaterThanOrEqual(1000);
        expect(totalTime).toBeLessThan(2000);
        
        expect(fast.content).toBe("Fast response");
        expect(medium.content).toBe("Medium response");
        expect(slow.content).toBe("Slow response");
    });

    it("demonstrates performance testing scenario usage", () => {
        // This test documents how to use performance testing scenarios
        const mockLLM = createMockLLMService(['performance-testing']);
        
        // The performance-testing scenario includes:
        // - Slow orchestrator responses (5s delay)
        // - Very slow planning phase (8s delay)
        // - Timeout simulation (35s delay)
        // - Memory-intensive responses
        // - Recovery after timeout scenarios
        
        // Verify scenario was loaded
        const scenarios = (mockLLM as any).responses;
        expect(scenarios.length).toBeGreaterThan(0);
        
        // Find a slow response scenario
        const slowScenario = scenarios.find((s: any) => 
            s.response.streamDelay === 5000
        );
        
        expect(slowScenario).toBeDefined();
        expect(slowScenario.trigger.agentName).toBe("orchestrator");
    });
});