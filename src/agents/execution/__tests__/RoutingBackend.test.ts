import { describe, expect, it, mock, beforeEach } from "bun:test";
import type { LLMService } from "@/llm/types";
import type { ConversationManager } from "@/conversations/ConversationManager";
import { RoutingBackend } from "../RoutingBackend";
import type { ExecutionContext } from "../types";
import { Message } from "multi-llm-ts";

describe("RoutingBackend", () => {
    let routingBackend: RoutingBackend;
    let mockLLMService: LLMService;
    let mockConversationManager: ConversationManager;
    let mockAgentExecutor: any;

    beforeEach(() => {
        // Mock LLM service
        mockLLMService = {
            complete: mock().mockResolvedValue({
                type: "text",
                content: JSON.stringify({
                    agents: ["project-manager"],
                    phase: "chat",
                    reason: "User asking general question"
                })
            }),
            stream: mock(),
        };

        // Mock conversation manager
        mockConversationManager = {
            updatePhase: mock().mockResolvedValue(undefined),
        } as any;

        // Mock agent executor
        mockAgentExecutor = {
            execute: mock().mockResolvedValue(undefined),
        };

        routingBackend = new RoutingBackend(mockLLMService, mockConversationManager);
    });

    it("should parse routing decision and execute target agents", async () => {
        const context: ExecutionContext = {
            projectPath: "/test",
            conversationId: "test-conversation",
            phase: "chat",
            agent: {
                name: "Orchestrator",
                slug: "orchestrator",
                pubkey: "orchestrator-pubkey",
                isOrchestrator: true,
                backend: "routing",
            } as any,
            triggeringEvent: { id: "test-event" } as any,
            agentExecutor: mockAgentExecutor,
            conversationManager: mockConversationManager,
        } as any;

        const messages = [
            new Message("system", "You are a router"),
            new Message("user", "What's your name?"),
        ];

        // Mock project context
        mock.module("@/services/ProjectContext", () => ({
            getProjectContext: () => ({
                agents: new Map([
                    ["project-manager", { 
                        name: "Project Manager", 
                        slug: "project-manager",
                        pubkey: "pm-pubkey" 
                    }],
                ]),
            }),
        }));

        await routingBackend.execute(messages, [], context, {} as any);

        // Verify LLM was called
        expect(mockLLMService.complete).toHaveBeenCalled();
        
        // Verify agent executor was called
        expect(mockAgentExecutor.execute).toHaveBeenCalledWith(
            expect.objectContaining({
                agent: expect.objectContaining({
                    slug: "project-manager",
                }),
            })
        );
    });

    it("should handle phase transitions", async () => {
        mockLLMService.complete = mock().mockResolvedValue({
            type: "text",
            content: JSON.stringify({
                agents: ["planner"],
                phase: "plan", // Different phase
                reason: "Moving to planning phase"
            })
        });

        const context: ExecutionContext = {
            projectPath: "/test",
            conversationId: "test-conversation",
            phase: "chat", // Current phase
            agent: {
                name: "Orchestrator",
                slug: "orchestrator",
                pubkey: "orchestrator-pubkey",
                isOrchestrator: true,
                backend: "routing",
            } as any,
            triggeringEvent: { id: "test-event" } as any,
            agentExecutor: mockAgentExecutor,
            conversationManager: mockConversationManager,
        } as any;

        const messages = [
            new Message("system", "You are a router"),
            new Message("user", "Plan a feature"),
        ];

        // Mock project context
        mock.module("@/services/ProjectContext", () => ({
            getProjectContext: () => ({
                agents: new Map([
                    ["planner", { 
                        name: "Planner", 
                        slug: "planner",
                        pubkey: "planner-pubkey" 
                    }],
                ]),
            }),
        }));

        await routingBackend.execute(messages, [], context, {} as any);

        // Verify phase transition was called
        expect(mockConversationManager.updatePhase).toHaveBeenCalledWith(
            "test-conversation",
            "plan",
            expect.any(String),
            "orchestrator-pubkey",
            "Orchestrator",
            "Moving to planning phase"
        );
    });

    it("should handle JSON wrapped in markdown", async () => {
        mockLLMService.complete = mock().mockResolvedValue({
            type: "text",
            content: `Here's the routing decision:
\`\`\`json
{
    "agents": ["executor"],
    "phase": "execute",
    "reason": "Ready to implement"
}
\`\`\`
`
        });

        const context: ExecutionContext = {
            projectPath: "/test",
            conversationId: "test-conversation",
            phase: "plan",
            agent: {
                name: "Orchestrator",
                slug: "orchestrator",
                pubkey: "orchestrator-pubkey",
                isOrchestrator: true,
                backend: "routing",
            } as any,
            triggeringEvent: { id: "test-event" } as any,
            agentExecutor: mockAgentExecutor,
            conversationManager: mockConversationManager,
        } as any;

        const messages = [new Message("user", "Execute the plan")];

        // Mock project context
        mock.module("@/services/ProjectContext", () => ({
            getProjectContext: () => ({
                agents: new Map([
                    ["executor", { 
                        name: "Executor", 
                        slug: "executor",
                        pubkey: "executor-pubkey" 
                    }],
                ]),
            }),
        }));

        await routingBackend.execute(messages, [], context, {} as any);

        // Verify agent executor was called with executor
        expect(mockAgentExecutor.execute).toHaveBeenCalledWith(
            expect.objectContaining({
                agent: expect.objectContaining({
                    slug: "executor",
                }),
                phase: "execute",
            })
        );
    });

    it("should handle multiple agents", async () => {
        mockLLMService.complete = mock().mockResolvedValue({
            type: "text",
            content: JSON.stringify({
                agents: ["frontend-expert", "backend-expert"],
                phase: "execute",
                reason: "Need review from both experts"
            })
        });

        const context: ExecutionContext = {
            projectPath: "/test",
            conversationId: "test-conversation",
            phase: "execute",
            agent: {
                name: "Orchestrator",
                slug: "orchestrator",
                pubkey: "orchestrator-pubkey",
                isOrchestrator: true,
                backend: "routing",
            } as any,
            triggeringEvent: { id: "test-event" } as any,
            agentExecutor: mockAgentExecutor,
            conversationManager: mockConversationManager,
        } as any;

        const messages = [new Message("user", "Review the implementation")];

        // Mock project context
        mock.module("@/services/ProjectContext", () => ({
            getProjectContext: () => ({
                agents: new Map([
                    ["frontend-expert", { 
                        name: "Frontend Expert", 
                        slug: "frontend-expert",
                        pubkey: "fe-pubkey" 
                    }],
                    ["backend-expert", { 
                        name: "Backend Expert", 
                        slug: "backend-expert",
                        pubkey: "be-pubkey" 
                    }],
                ]),
            }),
        }));

        await routingBackend.execute(messages, [], context, {} as any);

        // Verify both agents were executed
        expect(mockAgentExecutor.execute).toHaveBeenCalledTimes(2);
        expect(mockAgentExecutor.execute).toHaveBeenCalledWith(
            expect.objectContaining({
                agent: expect.objectContaining({ slug: "frontend-expert" }),
            })
        );
        expect(mockAgentExecutor.execute).toHaveBeenCalledWith(
            expect.objectContaining({
                agent: expect.objectContaining({ slug: "backend-expert" }),
            })
        );
    });
});