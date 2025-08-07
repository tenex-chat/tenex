import { describe, it, expect, beforeEach } from "bun:test";
import { MockLLMService } from "./MockLLMService";
import type { MockLLMScenario } from "./types";

/**
 * Unit tests for MockLLMService performance features
 * Tests that streamDelay works correctly for simulating slow responses
 */
describe("MockLLMService Performance Testing", () => {
    let mockLLM: MockLLMService;

    beforeEach(() => {
        // Create a simple scenario with delays
        const performanceScenario: MockLLMScenario = {
            name: "performance-test",
            description: "Test scenario for delays",
            responses: [
                {
                    trigger: {
                        userMessage: /very slow test/i,
                    },
                    response: {
                        streamDelay: 3000, // 3 second delay
                        content: "This is a very slow response"
                    },
                    priority: 10
                },
                {
                    trigger: {
                        userMessage: /slow test/i,
                    },
                    response: {
                        streamDelay: 1000, // 1 second delay
                        content: "This is a slow response"
                    },
                    priority: 10
                },
                {
                    trigger: {
                        userMessage: /instant test/i,
                    },
                    response: {
                        streamDelay: 0, // No delay
                        content: "This is an instant response"
                    },
                    priority: 10
                }
            ]
        };

        mockLLM = new MockLLMService({
            scenarios: [performanceScenario],
            debug: true
        });
    });

    it("should delay response by specified streamDelay", async () => {
        const startTime = Date.now();
        
        const response = await mockLLM.complete({
            messages: [
                { role: "user", content: "slow test" }
            ],
            options: { configName: "test-model" }
        });

        const endTime = Date.now();
        const duration = endTime - startTime;

        // Should take at least 1000ms
        expect(duration).toBeGreaterThanOrEqual(1000);
        expect(response.content).toBe("This is a slow response");
    });

    it("should handle very slow responses", async () => {
        const startTime = Date.now();
        
        const response = await mockLLM.complete({
            messages: [
                { role: "user", content: "very slow test" }
            ],
            options: { configName: "test-model" }
        });

        const endTime = Date.now();
        const duration = endTime - startTime;

        // Should take at least 3000ms
        expect(duration).toBeGreaterThanOrEqual(3000);
        expect(response.content).toBe("This is a very slow response");
    });

    it("should handle instant responses with no delay", async () => {
        const startTime = Date.now();
        
        const response = await mockLLM.complete({
            messages: [
                { role: "user", content: "instant test" }
            ],
            options: { configName: "test-model" }
        });

        const endTime = Date.now();
        const duration = endTime - startTime;

        // Should be nearly instant (less than 100ms)
        expect(duration).toBeLessThan(100);
        expect(response.content).toBe("This is an instant response");
    });

    it("should apply delays to streaming responses", async () => {
        const startTime = Date.now();
        const chunks: string[] = [];
        
        // Stream the response
        for await (const event of mockLLM.stream({
            messages: [
                { role: "user", content: "slow test" }
            ],
            options: { configName: "test-model" }
        })) {
            if (event.type === 'content') {
                chunks.push(event.content);
            }
        }

        const endTime = Date.now();
        const duration = endTime - startTime;

        // Streaming should also respect the delay
        expect(duration).toBeGreaterThanOrEqual(1000);
        expect(chunks.join('')).toContain("This is a slow response");
    });

    it("should track requests with delays in history", async () => {
        // Make a delayed request
        await mockLLM.complete({
            messages: [
                { role: "user", content: "slow test" }
            ],
            options: { configName: "test-model" }
        });

        const history = mockLLM.getRequestHistory();
        expect(history).toHaveLength(1);
        expect(history[0].response.content).toBe("This is a slow response");
        expect(history[0].messages[0].content).toBe("slow test");
    });

    it("should handle concurrent requests with different delays", async () => {
        const startTime = Date.now();
        
        // Start three requests concurrently
        const promises = [
            mockLLM.complete({
                messages: [{ role: "user", content: "instant test" }],
                options: { configName: "test-model" }
            }),
            mockLLM.complete({
                messages: [{ role: "user", content: "slow test" }],
                options: { configName: "test-model" }
            }),
            mockLLM.complete({
                messages: [{ role: "user", content: "very slow test" }],
                options: { configName: "test-model" }
            })
        ];

        const responses = await Promise.all(promises);
        const endTime = Date.now();
        const totalDuration = endTime - startTime;

        // All should complete, with the slowest determining total time
        expect(totalDuration).toBeGreaterThanOrEqual(3000);
        expect(responses[0].content).toBe("This is an instant response");
        expect(responses[1].content).toBe("This is a slow response");
        expect(responses[2].content).toBe("This is a very slow response");
    });
});