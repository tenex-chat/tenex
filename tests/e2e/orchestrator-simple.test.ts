import { describe, it, expect, beforeEach, mock } from "bun:test";

// Mock tracing before imports
mock.module("@/tracing", () => ({
    createTracingLogger: () => ({
        trace: () => {},
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {}
    })
}));

import { createMockLLMService, createMockAgent, createMockConversation } from "@/test-utils";
import { AgentExecutor } from "@/agents/execution/AgentExecutor";
import { RoutingBackend } from "@/agents/execution/RoutingBackend";
import type { ExecutionContext } from "@/agents/types";

// Mock tools
mock.module("@/tools/registry", () => ({
    ToolRegistry: {
        getInstance: () => ({
            getAllTools: () => [],
            getTool: () => null
        })
    }
}));

describe("E2E: Orchestrator Simple Test", () => {
    beforeEach(() => {
        // Mock dependencies
        mock.module("@/nostr", () => ({
            NostrPublisher: class {
                async publishResponse() { }
                async publishError() { }
                async publishTypingIndicator() { }
                async stopTypingIndicator() { }
            }
        }));
        
        mock.module("@/logging/ExecutionLogger", () => ({
            ExecutionLogger: class {
                logToolCall() {}
                logToolResult() {}
                logStream() {}
                logComplete() {}
                logError() {}
            }
        }));
        
        mock.module("@/services/ProjectContext", () => ({
            getProjectContext: () => ({
                project: { id: "test", pubkey: "test" },
                orchestrator: createMockAgent({ name: "Orchestrator" }),
                agents: new Map([
                    ["orchestrator", createMockAgent({ name: "Orchestrator" })],
                    ["executor", createMockAgent({ name: "Executor" })],
                    ["planner", createMockAgent({ name: "Planner" })]
                ])
            })
        }));
        
        // Mock conversation manager
        mock.module("@/conversations/ConversationManager", () => ({
            ConversationManager: class {
                async updatePhase(id: string, phase: string) {
                    console.log(`Phase updated to: ${phase}`);
                }
                async updateAgentContext() {}
                async getConversation() {
                    return createMockConversation({ phase: "CHAT" });
                }
            }
        }));
        
    });
    
    it("should route orchestrator decisions correctly", async () => {
        const mockLLM = createMockLLMService(['orchestrator-workflow']);
        
        // Mock LLM router
        mock.module("@/llm/router", () => ({
            getLLMService: () => mockLLM,
            LLMRouter: class {
                getService() { return mockLLM; }
            }
        }));
        
        // Create execution context
        const orchestrator = createMockAgent({
            name: "Orchestrator",
            systemPrompt: "You are the Orchestrator agent"
        });
        
        const conversation = createMockConversation({
            phase: "CHAT"
        });
        
        const toolCalls: any[] = [];
        const context: ExecutionContext = {
            agent: orchestrator,
            conversation,
            conversationId: conversation.id,
            projectPath: "/test",
            userMessage: "I need to create a user authentication system with JWT and OAuth support",
            systemPrompt: orchestrator.systemPrompt || "",
            availableTools: ["continue", "endConversation"],
            onStreamContent: () => {},
            onStreamToolCall: (toolCall) => {
                toolCalls.push(toolCall);
            },
            onComplete: () => {},
            onError: (error) => {
                console.error("Error:", error);
            },
            tracingContext: {
                conversationId: conversation.id,
                traceId: "test-trace",
                spanId: "test-span"
            }
        };
        
        // Execute routing backend
        const routingBackend = new RoutingBackend();
        await routingBackend.execute(context);
        
        // Verify tool calls
        expect(toolCalls).toHaveLength(1);
        expect(toolCalls[0].function.name).toBe("continue");
        
        // Parse arguments
        const args = JSON.parse(toolCalls[0].function.arguments);
        expect(args.suggestedPhase).toBe("CHAT");
        expect(args.confidence).toBeGreaterThan(80);
        expect(args.reasoning).toContain("requirements");
        
        // Check LLM history
        const history = (mockLLM as any).getRequestHistory();
        expect(history).toHaveLength(1);
        expect(history[0].messages[0].role).toBe("system");
        expect(history[0].messages[0].content).toContain("Orchestrator");
    });
    
    it("should handle phase transitions", async () => {
        const mockLLM = createMockLLMService();
        
        // Add custom response for phase transition
        mockLLM.addResponse({
            trigger: {
                agentName: "Orchestrator",
                phase: "CHAT",
                previousToolCalls: ["complete"]
            },
            response: {
                toolCalls: [{
                    id: "1",
                    type: "function",
                    function: {
                        name: "continue",
                        arguments: JSON.stringify({
                            summary: "Moving to planning phase",
                            suggestedPhase: "PLAN",
                            confidence: 95,
                            reasoning: "Requirements gathered"
                        })
                    }
                }]
            },
            priority: 10
        });
        
        // Mock LLM router
        mock.module("@/llm/router", () => ({
            getLLMService: () => mockLLM,
            LLMRouter: class {
                getService() { return mockLLM; }
            }
        }));
        
        // Create context with previous tool call
        const conversation = createMockConversation({
            phase: "CHAT"
        });
        
        const context: ExecutionContext = {
            agent: createMockAgent({ name: "Orchestrator" }),
            conversation,
            conversationId: conversation.id,
            projectPath: "/test",
            userMessage: "Continue with the next phase",
            systemPrompt: "You are the Orchestrator agent. Current Phase: CHAT",
            availableTools: ["continue", "endConversation"],
            onStreamContent: () => {},
            onStreamToolCall: () => {},
            onComplete: () => {},
            onError: () => {}
        };
        
        // Add mock tool call history
        const messages = [
            { role: "system", content: context.systemPrompt },
            { role: "user", content: "Previous message" },
            { role: "assistant", content: "Response", tool_calls: [{
                id: "prev1",
                type: "function",
                function: { name: "complete", arguments: "{}" }
            }] },
            { role: "user", content: context.userMessage }
        ];
        
        // Manually call the LLM to test trigger matching
        const response = await mockLLM.chat(messages as any, "test");
        
        expect(response.toolCalls).toHaveLength(1);
        expect(response.toolCalls[0].function.name).toBe("continue");
        
        const args = JSON.parse(response.toolCalls[0].function.arguments);
        expect(args.suggestedPhase).toBe("PLAN");
    });
});