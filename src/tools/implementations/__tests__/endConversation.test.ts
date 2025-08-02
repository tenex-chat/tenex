import { describe, it, expect, beforeEach, mock, spyOn } from "bun:test";
import { endConversationTool } from "../endConversation";
import type { ToolContext } from "../../types";
import { logger } from "@/utils/logger";

// Spy on logger methods
const loggerInfoSpy = spyOn(logger, "info").mockImplementation(() => {});
const loggerErrorSpy = spyOn(logger, "error").mockImplementation(() => {});
const loggerWarnSpy = spyOn(logger, "warn").mockImplementation(() => {});
const loggerDebugSpy = spyOn(logger, "debug").mockImplementation(() => {});

describe("endConversation Tool", () => {
    let mockContext: ToolContext;
    let mockPublisher: any;

    beforeEach(() => {
        // Clear all spies
        loggerInfoSpy.mockClear();
        loggerErrorSpy.mockClear();
        loggerWarnSpy.mockClear();
        loggerDebugSpy.mockClear();
        
        // Create mock publisher
        mockPublisher = {
            publishResponse: mock().mockResolvedValue(undefined)
        };

        // Create base context
        mockContext = {
            agent: {
                name: "Orchestrator",
                pubkey: "orchestrator-pubkey",
                isOrchestrator: true,
                role: "orchestrator",
                systemPrompt: "test prompt"
            },
            conversationId: "test-conversation-id",
            publisher: mockPublisher,
            conversation: {
                id: "test-conversation-id",
                title: "Test Conversation",
                phase: "VERIFICATION",
                phaseTransitions: [],
                messages: [],
                parentTaskId: null,
                learnings: [],
                metadata: {}
            }
        };
    });

    describe("Parameter Validation", () => {
        it("should validate required response parameter", async () => {
            const result = await endConversationTool.execute(
                { _brand: "validated" as const, value: { response: "" } },
                mockContext
            );

            // Empty string should still be valid
            expect(result.ok).toBe(true);
        });

        it("should accept optional summary parameter", async () => {
            const input = {
                response: "Task completed successfully",
                summary: "Implemented authentication system with JWT tokens"
            };

            const result = await endConversationTool.execute(
                { _brand: "validated" as const, value: input },
                mockContext
            );

            expect(result.ok).toBe(true);
            if (result.ok && result.value.type === "end_conversation") {
                expect(result.value.result.summary).toBe(input.summary);
            }
        });

        it("should use response as summary when summary not provided", async () => {
            const input = {
                response: "Task completed successfully"
            };

            const result = await endConversationTool.execute(
                { _brand: "validated" as const, value: input },
                mockContext
            );

            expect(result.ok).toBe(true);
            if (result.ok && result.value.type === "end_conversation") {
                expect(result.value.result.summary).toBe(input.response);
            }
        });
    });

    describe("Orchestrator Restriction", () => {
        it("should fail when called by non-orchestrator agent", async () => {
            // Modify context to be non-orchestrator
            mockContext.agent.isOrchestrator = false;
            mockContext.agent.name = "Developer";
            mockContext.agent.role = "developer";

            const result = await endConversationTool.execute(
                { _brand: "validated" as const, value: { response: "Trying to end conversation" } },
                mockContext
            );

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error.kind).toBe("execution");
                expect(result.error.message).toContain("Only orchestrator can end conversations");
            }
        });

        it("should succeed when called by orchestrator", async () => {
            const result = await endConversationTool.execute(
                { _brand: "validated" as const, value: { response: "Conversation completed" } },
                mockContext
            );

            expect(result.ok).toBe(true);
        });
    });

    describe("Event Publishing", () => {
        it("should publish response event with correct metadata", async () => {
            const input = {
                response: "All tasks completed successfully",
                summary: "Implemented full authentication system"
            };

            const result = await endConversationTool.execute(
                { _brand: "validated" as const, value: input },
                mockContext
            );

            expect(result.ok).toBe(true);
            expect(mockPublisher.publishResponse).toHaveBeenCalledWith({
                content: input.response,
                completeMetadata: {
                    type: "end_conversation",
                    result: {
                        response: input.response,
                        summary: input.summary,
                        success: true
                    }
                }
            });
        });

        it("should handle publisher errors gracefully", async () => {
            // Make publisher throw an error
            mockPublisher.publishResponse.mockRejectedValue(new Error("Network error"));

            await expect(
                endConversationTool.execute(
                    { _brand: "validated" as const, value: { response: "Test response" } },
                    mockContext
                )
            ).rejects.toThrow("Network error");
        });
    });

    describe("Return Value", () => {
        it("should return proper termination object", async () => {
            const input = {
                response: "Successfully completed all requested tasks",
                summary: "Built complete e-commerce platform with user auth, product catalog, and payment processing"
            };

            const result = await endConversationTool.execute(
                { _brand: "validated" as const, value: input },
                mockContext
            );

            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.value.type).toBe("end_conversation");
                expect(result.value.result).toEqual({
                    response: input.response,
                    summary: input.summary,
                    success: true
                });
            }
        });
    });

    describe("Logging", () => {
        it("should log conversation conclusion details", async () => {
            const input = {
                response: "Task completed"
            };

            await endConversationTool.execute(
                { _brand: "validated" as const, value: input },
                mockContext
            );

            // Check initial log
            expect(loggerInfoSpy).toHaveBeenCalledWith(
                "📬 Orchestrator concluding conversation",
                expect.objectContaining({
                    tool: "end_conversation",
                    conversationId: mockContext.conversationId
                })
            );

            // Check completion log
            expect(loggerInfoSpy).toHaveBeenCalledWith(
                "✅ Conversation concluded",
                expect.objectContaining({
                    tool: "end_conversation",
                    agent: mockContext.agent.name,
                    agentId: mockContext.agent.pubkey,
                    returningTo: "user",
                    hasResponse: true,
                    conversationId: mockContext.conversationId
                })
            );
        });
    });

    describe("Edge Cases", () => {
        it("should handle very long responses", async () => {
            const longResponse = "A".repeat(10000); // 10k character response
            
            const result = await endConversationTool.execute(
                { _brand: "validated" as const, value: { response: longResponse } },
                mockContext
            );

            expect(result.ok).toBe(true);
            expect(mockPublisher.publishResponse).toHaveBeenCalled();
        });

        it("should handle unicode and special characters in response", async () => {
            const specialResponse = "Task completed! 🎉 Here's the summary: <script>alert('test')</script> & more";
            
            const result = await endConversationTool.execute(
                { _brand: "validated" as const, value: { response: specialResponse } },
                mockContext
            );

            expect(result.ok).toBe(true);
            if (result.ok && result.value.type === "end_conversation") {
                expect(result.value.result.response).toBe(specialResponse);
            }
        });

        it("should handle empty response gracefully", async () => {
            const result = await endConversationTool.execute(
                { _brand: "validated" as const, value: { response: "" } },
                mockContext
            );

            expect(result.ok).toBe(true);
            expect(mockPublisher.publishResponse).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: ""
                })
            );
        });
    });

    describe("Integration Scenarios", () => {
        it("should work correctly in different conversation phases", async () => {
            const phases = ["CHAT", "PLAN", "BUILD", "REVIEW", "VERIFICATION"];
            
            for (const phase of phases) {
                mockContext.conversation.phase = phase as any;
                
                const result = await endConversationTool.execute(
                    { _brand: "validated" as const, value: { response: `Completed in ${phase} phase` } },
                    mockContext
                );

                expect(result.ok).toBe(true);
            }
        });

        it("should handle concurrent calls correctly", async () => {
            const promises = Array(5).fill(null).map((_, i) => 
                endConversationTool.execute(
                    { _brand: "validated" as const, value: { response: `Response ${i}` } },
                    { ...mockContext, conversationId: `conv-${i}` }
                )
            );

            const results = await Promise.all(promises);
            
            expect(results).toHaveLength(5);
            expect(results.every(r => r.ok)).toBe(true);
            expect(mockPublisher.publishResponse).toHaveBeenCalledTimes(5);
        });
    });
});