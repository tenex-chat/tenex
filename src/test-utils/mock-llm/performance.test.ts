import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { MockLLMService } from "./MockLLMService";
import type { MockLLMScenario } from "./types";

/**
 * Unit tests for MockLLMService performance features
 * Tests that streamDelay works correctly for simulating slow responses
 */
describe("MockLLMService Performance Testing", () => {
    let mockLLM: MockLLMService;
    let setTimeoutSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation((callback, delay?: number, ...args) => {
            if (typeof callback === "function") {
                callback(...args);
            }
            return 0 as unknown as ReturnType<typeof setTimeout>;
        });

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
                        content: "This is a very slow response",
                    },
                    priority: 10,
                },
                {
                    trigger: {
                        userMessage: /slow test/i,
                    },
                    response: {
                        streamDelay: 1000, // 1 second delay
                        content: "This is a slow response",
                    },
                    priority: 10,
                },
                {
                    trigger: {
                        userMessage: /instant test/i,
                    },
                    response: {
                        streamDelay: 0, // No delay
                        content: "This is an instant response",
                    },
                    priority: 10,
                },
            ],
        };

        mockLLM = new MockLLMService({
            scenarios: [performanceScenario],
            debug: true,
        });
    });

    afterEach(() => {
        setTimeoutSpy?.mockRestore();
    });

    it("should delay response by specified streamDelay", async () => {
        const response = await mockLLM.complete({
            messages: [{ role: "user", content: "slow test" }],
            options: { configName: "test-model" },
        });
        const delays = setTimeoutSpy.mock.calls.map(([, delay]) => Number(delay ?? 0));
        expect(delays).toEqual([1000]);
        expect(response.content).toBe("This is a slow response");
    });

    it("should handle very slow responses", async () => {
        const response = await mockLLM.complete({
            messages: [{ role: "user", content: "very slow test" }],
            options: { configName: "test-model" },
        });
        const delays = setTimeoutSpy.mock.calls.map(([, delay]) => Number(delay ?? 0));
        expect(delays).toEqual([3000]);
        expect(response.content).toBe("This is a very slow response");
    });

    it("should handle instant responses with no delay", async () => {
        const response = await mockLLM.complete({
            messages: [{ role: "user", content: "instant test" }],
            options: { configName: "test-model" },
        });
        expect(setTimeoutSpy).not.toHaveBeenCalled();
        expect(response.content).toBe("This is an instant response");
    });

    it("should apply delays to streaming responses", async () => {
        const chunks: string[] = [];

        // Stream the response
        for await (const event of mockLLM.stream({
            messages: [{ role: "user", content: "slow test" }],
            options: { configName: "test-model" },
        })) {
            if (event.type === "content") {
                chunks.push(event.content);
            }
        }
        const delays = setTimeoutSpy.mock.calls.map(([, delay]) => Number(delay ?? 0));
        const totalDelay = delays.reduce((sum, delay) => sum + delay, 0);
        expect(totalDelay).toBe(1000);
        expect(delays).toHaveLength(chunks.length);
        expect(chunks.join("")).toContain("This is a slow response");
    });

    it("should track requests with delays in history", async () => {
        // Make a delayed request
        await mockLLM.complete({
            messages: [{ role: "user", content: "slow test" }],
            options: { configName: "test-model" },
        });

        const history = mockLLM.getRequestHistory();
        expect(history).toHaveLength(1);
        expect(history[0].response.content).toBe("This is a slow response");
        expect(history[0].messages[0].content).toBe("slow test");
    });

    it("should handle concurrent requests with different delays", async () => {
        // Start three requests concurrently
        const promises = [
            mockLLM.complete({
                messages: [{ role: "user", content: "instant test" }],
                options: { configName: "test-model" },
            }),
            mockLLM.complete({
                messages: [{ role: "user", content: "slow test" }],
                options: { configName: "test-model" },
            }),
            mockLLM.complete({
                messages: [{ role: "user", content: "very slow test" }],
                options: { configName: "test-model" },
            }),
        ];

        const responses = await Promise.all(promises);
        const delays = setTimeoutSpy.mock.calls.map(([, delay]) => Number(delay ?? 0));
        expect(delays).toEqual(expect.arrayContaining([1000, 3000]));
        expect(Math.max(...delays)).toBe(3000);
        expect(responses[0].content).toBe("This is an instant response");
        expect(responses[1].content).toBe("This is a slow response");
        expect(responses[2].content).toBe("This is a very slow response");
    });
});
