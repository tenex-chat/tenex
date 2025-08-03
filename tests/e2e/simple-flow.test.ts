import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { setupE2ETest, cleanupE2ETest, type E2ETestContext } from "./test-harness";
import { createMockLLMService } from "@/test-utils";
import type { MockLLMResponse } from "@/test-utils/mock-llm/types";

describe("E2E: Simple Flow Test", () => {
    let context: E2ETestContext;
    
    afterEach(async () => {
        await cleanupE2ETest(context);
    });
    
    it("should execute a simple mock LLM flow", async () => {
        // Add a custom response
        const customResponse: MockLLMResponse = {
            trigger: {
                userMessage: /Hello/i
            },
            response: {
                content: "Hello! How can I help you today?",
                toolCalls: []
            },
            priority: 100
        };
        
        // Create a custom mock LLM with a default response
        const mockLLM = createMockLLMService([], {
            customResponses: [customResponse],
            defaultResponse: {
                content: "Default response",
                toolCalls: []
            }
        });
        
        // Execute through the complete method
        const response = await mockLLM.complete({
            messages: [
                { role: "user", content: "Hello" }
            ],
            options: { configName: "test-model" }
        });
        
        expect(response.content).toBe("Hello! How can I help you today?");
        expect(response.toolCalls).toHaveLength(0);
    });
    
    it("should handle tool calls", async () => {
        // Add a response with tool calls
        const customResponse: MockLLMResponse = {
            trigger: {
                userMessage: /analyze.*code/i
            },
            response: {
                content: "I'll analyze the code for you.",
                toolCalls: [{
                    id: "1",
                    type: "function",
                    function: {
                        name: "analyze",
                        arguments: JSON.stringify({ path: "/src" })
                    }
                }]
            },
            priority: 100
        };
        
        const mockLLM = createMockLLMService([], {
            customResponses: [customResponse]
        });
        
        const response = await mockLLM.complete({
            messages: [
                { role: "user", content: "Please analyze this code" }
            ],
            options: { configName: "test-model" }
        });
        
        expect(response.content).toBe("I'll analyze the code for you.");
        expect(response.toolCalls).toHaveLength(1);
        expect(response.toolCalls![0].function.name).toBe("analyze");
    });
    
    it("should use scenarios correctly", async () => {
        // Load orchestrator workflow scenario
        context = await setupE2ETest(['orchestrator-workflow']);
        
        // Test orchestrator response
        const response = await context.mockLLM.complete({
            messages: [
                { role: "system", content: "You are the Orchestrator agent. Current Phase: CHAT" },
                { role: "user", content: "I need to create a user authentication system with JWT and OAuth support" }
            ],
            options: { configName: "test-model" }
        });
        
        expect(response.content).toContain("authentication");
        expect(response.toolCalls).toHaveLength(1);
        expect(response.toolCalls![0].function.name).toBe("continue");
        
        // Verify tool call arguments
        const args = JSON.parse(response.toolCalls![0].function.arguments);
        expect(args.suggestedPhase).toBe("CHAT");
        expect(args.confidence).toBe(90);
    });
    
    it("should track request history", async () => {
        context = await setupE2ETest();
        
        // Make multiple requests
        await context.mockLLM.complete({
            messages: [{ role: "user", content: "First request" }],
            options: { configName: "test-model" }
        });
        
        await context.mockLLM.complete({
            messages: [{ role: "user", content: "Second request" }],
            options: { configName: "test-model" }
        });
        
        // Check history
        const history = context.mockLLM.getRequestHistory();
        expect(history).toHaveLength(2);
        expect(history[0].messages[0].content).toBe("First request");
        expect(history[1].messages[0].content).toBe("Second request");
    });
});