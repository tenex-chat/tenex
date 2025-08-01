import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { handleNewConversation } from "../newConversation";
import { MockFactory } from "@/test-utils";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

describe("handleNewConversation", () => {
    let mockAgentRegistry: any;
    let mockConversationManager: any;
    let mockAgentExecutor: any;
    let mockEvent: NDKEvent;
    
    beforeEach(() => {
        // Create mock event
        mockEvent = MockFactory.createMockNostrEvent({
            content: "Hello, I need help with a task",
            tags: [
                ["d", "conversation-123"],
                ["agent", "planner"]
            ]
        });
        
        // Create mock agent registry
        mockAgentRegistry = {
            getAgentBySlug: mock((slug: string) => ({
                id: `agent-${slug}`,
                name: slug,
                slug,
                systemPrompt: `You are the ${slug} agent`,
                tools: ["analyze", "complete"],
                backend: "claude"
            })),
            getDefaultAgent: mock(() => ({
                id: "agent-orchestrator",
                name: "orchestrator",
                slug: "orchestrator",
                systemPrompt: "You are the orchestrator agent",
                tools: [],
                backend: "routing"
            }))
        };
        
        // Create mock conversation manager
        mockConversationManager = {
            createConversation: mock(async (id: string, initialMessage: any) => ({
                id,
                messages: [initialMessage],
                phase: "CHAT",
                createdAt: new Date(),
                updatedAt: new Date()
            })),
            addMessage: mock(async () => {}),
            updatePhase: mock(async () => {})
        };
        
        // Create mock agent executor
        mockAgentExecutor = {
            execute: mock(async () => {})
        };
        
        // Mock modules
        mock.module("@/services", () => ({
            getProjectContext: () => ({
                agentRegistry: mockAgentRegistry,
                conversationManager: mockConversationManager
            })
        }));
        
        mock.module("@/agents/execution/AgentExecutor", () => ({
            AgentExecutor: class {
                constructor() {}
                execute = mockAgentExecutor.execute;
            }
        }));
        
        mock.module("@/llm/router", () => ({
            getLLMService: () => ({})
        }));
        
        mock.module("@/nostr", () => ({
            getNDK: () => ({}),
            NostrPublisher: class {
                async publishResponse() {}
                async publishError() {}
            }
        }));
        
        mock.module("@/utils/logger", () => ({
            logger: {
                info: () => {},
                error: () => {},
                debug: () => {}
            }
        }));
        
        mock.module("@/tracing", () => ({
            createTracingContext: () => ({ id: "trace-123" })
        }));
    });
    
    afterEach(() => {
        mock.restore();
    });
    
    describe("conversation creation", () => {
        it("should create a new conversation", async () => {
            await handleNewConversation(mockEvent);
            
            expect(mockConversationManager.createConversation).toHaveBeenCalledWith(
                "conversation-123",
                expect.objectContaining({
                    role: "user",
                    content: "Hello, I need help with a task"
                })
            );
        });
        
        it("should use specified agent from tags", async () => {
            await handleNewConversation(mockEvent);
            
            expect(mockAgentRegistry.getAgentBySlug).toHaveBeenCalledWith("planner");
            expect(mockAgentExecutor.execute).toHaveBeenCalledWith(
                expect.objectContaining({
                    agent: expect.objectContaining({
                        slug: "planner"
                    }),
                    conversationId: "conversation-123"
                }),
                expect.any(Object)
            );
        });
        
        it("should use default agent when no agent specified", async () => {
            // Remove agent tag
            mockEvent.tags = [["d", "conversation-456"]];
            
            await handleNewConversation(mockEvent);
            
            expect(mockAgentRegistry.getDefaultAgent).toHaveBeenCalled();
            expect(mockAgentExecutor.execute).toHaveBeenCalledWith(
                expect.objectContaining({
                    agent: expect.objectContaining({
                        slug: "orchestrator"
                    })
                }),
                expect.any(Object)
            );
        });
    });
    
    describe("error handling", () => {
        it("should handle conversation creation errors", async () => {
            const error = new Error("Failed to create conversation");
            mockConversationManager.createConversation.mockRejectedValue(error);
            
            // Should not throw
            await expect(handleNewConversation(mockEvent)).resolves.toBeUndefined();
        });
        
        it("should handle agent not found", async () => {
            mockAgentRegistry.getAgentBySlug.mockReturnValue(null);
            mockAgentRegistry.getDefaultAgent.mockReturnValue(null);
            
            // Should not throw
            await expect(handleNewConversation(mockEvent)).resolves.toBeUndefined();
        });
        
        it("should handle execution errors", async () => {
            const error = new Error("Execution failed");
            mockAgentExecutor.execute.mockRejectedValue(error);
            
            // Should not throw
            await expect(handleNewConversation(mockEvent)).resolves.toBeUndefined();
        });
    });
    
    describe("event validation", () => {
        it("should handle missing conversation ID", async () => {
            mockEvent.tags = [];
            
            // Should not throw
            await expect(handleNewConversation(mockEvent)).resolves.toBeUndefined();
        });
        
        it("should handle empty content", async () => {
            mockEvent.content = "";
            
            await handleNewConversation(mockEvent);
            
            // Should still create conversation with empty content
            expect(mockConversationManager.createConversation).toHaveBeenCalledWith(
                "conversation-123",
                expect.objectContaining({
                    content: ""
                })
            );
        });
    });
});