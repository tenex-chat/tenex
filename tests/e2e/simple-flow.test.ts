import { describe, it, expect, beforeEach, mock } from "bun:test";
import { createMockLLMService } from "@/test-utils";

describe("E2E: Simple Flow Test", () => {
    it("should execute a simple mock LLM flow", async () => {
        // Create a mock LLM with a simple scenario
        const mockLLM = createMockLLMService();
        
        // Add a simple response
        mockLLM.addResponse({
            trigger: {
                userMessage: "Hello"
            },
            response: {
                content: "Hello! How can I help you today?",
                toolCalls: []
            }
        });
        
        // Execute a chat
        const response = await mockLLM.chat([
            { role: "user", content: "Hello" }
        ], "test-model");
        
        // Verify response
        expect(response.content).toBe("Hello! How can I help you today?");
        expect(response.toolCalls).toHaveLength(0);
        
        // Check history
        const history = (mockLLM as any).getRequestHistory();
        expect(history).toHaveLength(1);
        expect(history[0].messages[0].content).toBe("Hello");
    });
    
    it("should handle tool calls", async () => {
        const mockLLM = createMockLLMService();
        
        // Add response with tool call
        mockLLM.addResponse({
            trigger: {
                userMessage: /analyze/i
            },
            response: {
                content: "I'll analyze that for you.",
                toolCalls: [{
                    id: "1",
                    type: "function",
                    function: {
                        name: "analyze",
                        arguments: JSON.stringify({ query: "test analysis" })
                    }
                }]
            }
        });
        
        // Execute
        const response = await mockLLM.chat([
            { role: "user", content: "Please analyze this code" }
        ], "test-model");
        
        // Verify
        expect(response.content).toContain("analyze");
        expect(response.toolCalls).toHaveLength(1);
        expect(response.toolCalls[0].function.name).toBe("analyze");
    });
    
    it("should use scenarios correctly", async () => {
        // Load orchestrator workflow scenario
        const mockLLM = createMockLLMService(['orchestrator-workflow']);
        
        // Test orchestrator response
        const response = await mockLLM.chat([
            { role: "system", content: "You are the Orchestrator agent. Current Phase: CHAT" },
            { role: "user", content: "I need to create a user authentication system with JWT and OAuth support" }
        ], "test-model");
        
        // Verify orchestrator behavior
        expect(response.content).toContain("help you create");
        expect(response.toolCalls).toHaveLength(1);
        expect(response.toolCalls[0].function.name).toBe("continue");
        
        const args = JSON.parse(response.toolCalls[0].function.arguments);
        expect(args.suggestedPhase).toBe("CHAT");
        expect(args.confidence).toBeGreaterThan(80);
    });
});