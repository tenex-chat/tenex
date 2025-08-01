import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { handleReply } from "../reply";
import { MockFactory } from "@/test-utils";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

describe("handleReply", () => {
    let mockAgentRegistry: any;
    let mockConversationManager: any;
    let mockAgentExecutor: any;
    let mockEvent: NDKEvent;
    let mockConversation: any;
    
    beforeEach(() => {
        // Create mock conversation
        mockConversation = {
            id: "conversation-123",
            phase: "PLAN",
            messages: [
                { role: "user", content: "Initial message" },
                { role: "assistant", content: "Previous response" }
            ],
            metadata: {
                currentAgent: "planner"
            },
            createdAt: new Date(),
            updatedAt: new Date()
        };
        
        // Create mock event
        mockEvent = MockFactory.createMockNostrEvent({
            content: "Please continue with the next step",
            tags: [
                ["d", "conversation-123"],
                ["agent", "executor"]
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
            }))
        };
        
        // Create mock conversation manager
        mockConversationManager = {
            getConversation: mock(async () => mockConversation),
            addMessage: mock(async () => {}),
            updateState: mock(async () => {})
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
    
    describe("reply processing", () => {
        it("should add user message to conversation", async () => {
            await handleReply(mockEvent);
            
            expect(mockConversationManager.addMessage).toHaveBeenCalledWith(
                "conversation-123",
                expect.objectContaining({
                    role: "user",
                    content: "Please continue with the next step"
                })
            );
        });
        
        it("should execute specified agent", async () => {
            await handleReply(mockEvent);
            
            expect(mockAgentRegistry.getAgentBySlug).toHaveBeenCalledWith("executor");
            expect(mockAgentExecutor.execute).toHaveBeenCalledWith(
                expect.objectContaining({
                    agent: expect.objectContaining({
                        slug: "executor"
                    }),
                    conversationId: "conversation-123"
                }),
                expect.any(Object)
            );
        });
        
        it("should use current agent from metadata when no agent specified", async () => {
            // Remove agent tag
            mockEvent.tags = [["d", "conversation-123"]];
            
            await handleReply(mockEvent);
            
            expect(mockAgentRegistry.getAgentBySlug).toHaveBeenCalledWith("planner");
            expect(mockAgentExecutor.execute).toHaveBeenCalledWith(
                expect.objectContaining({
                    agent: expect.objectContaining({
                        slug: "planner"
                    })
                }),
                expect.any(Object)
            );
        });
        
        it("should include all conversation messages in context", async () => {
            await handleReply(mockEvent);
            
            expect(mockAgentExecutor.execute).toHaveBeenCalledWith(
                expect.objectContaining({
                    messages: expect.arrayContaining([
                        expect.objectContaining({ content: "Initial message" }),
                        expect.objectContaining({ content: "Previous response" }),
                        expect.objectContaining({ content: "Please continue with the next step" })
                    ])
                }),
                expect.any(Object)
            );
        });
    });
    
    describe("error handling", () => {
        it("should handle conversation not found", async () => {
            mockConversationManager.getConversation.mockResolvedValue(null);
            
            // Should not throw
            await expect(handleReply(mockEvent)).resolves.toBeUndefined();
            
            // Should not attempt to execute
            expect(mockAgentExecutor.execute).not.toHaveBeenCalled();
        });
        
        it("should handle agent not found", async () => {
            mockAgentRegistry.getAgentBySlug.mockReturnValue(null);
            
            // Should not throw
            await expect(handleReply(mockEvent)).resolves.toBeUndefined();
            
            // Should not attempt to execute
            expect(mockAgentExecutor.execute).not.toHaveBeenCalled();
        });
        
        it("should handle execution errors", async () => {
            const error = new Error("Execution failed");
            mockAgentExecutor.execute.mockRejectedValue(error);
            
            // Should not throw
            await expect(handleReply(mockEvent)).resolves.toBeUndefined();
        });
        
        it("should handle message addition errors", async () => {
            const error = new Error("Failed to add message");
            mockConversationManager.addMessage.mockRejectedValue(error);
            
            // Should not throw but should not execute
            await expect(handleReply(mockEvent)).resolves.toBeUndefined();
            expect(mockAgentExecutor.execute).not.toHaveBeenCalled();
        });
    });
    
    describe("event validation", () => {
        it("should handle missing conversation ID", async () => {
            mockEvent.tags = [];
            
            // Should not throw
            await expect(handleReply(mockEvent)).resolves.toBeUndefined();
            
            // Should not attempt to get conversation
            expect(mockConversationManager.getConversation).not.toHaveBeenCalled();
        });
        
        it("should handle empty content", async () => {
            mockEvent.content = "";
            
            await handleReply(mockEvent);
            
            // Should still add message with empty content
            expect(mockConversationManager.addMessage).toHaveBeenCalledWith(
                "conversation-123",
                expect.objectContaining({
                    content: ""
                })
            );
        });
    });
});