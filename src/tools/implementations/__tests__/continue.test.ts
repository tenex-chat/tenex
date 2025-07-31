import { describe, expect, it, mock } from "bun:test";
import type { Agent } from "@/agents/types";
import type { Conversation } from "@/conversations/types";
import { continueTool } from "../continue";
import type { ExecutionContext } from "@/tools/types";
import type { ToolExecutionResult } from "@/tools/executor";
import { createToolExecutor } from "@/tools/executor";

// Mock dependencies
mock.module("@/services/ProjectContext", () => ({
    getProjectContext: () => ({
        agents: new Map([
            ["planner", { pubkey: "planner-pubkey", name: "Planner" }],
            ["executor", { pubkey: "executor-pubkey", name: "Executor" }],
            ["project-manager", { pubkey: "pm-pubkey", name: "Project Manager" }],
            ["frontend-expert", { pubkey: "frontend-pubkey", name: "Frontend Expert" }],
            ["backend-expert", { pubkey: "backend-pubkey", name: "Backend Expert" }],
            ["orchestrator", { pubkey: "orchestrator-pubkey", name: "Orchestrator" }],
        ]),
    }),
}));

mock.module("@/utils/logger", () => ({
    logger: {
        info: mock(),
        warn: mock(),
        error: mock(),
    },
}));

describe("continueTool - Agent routing", () => {
    const mockConversation: Conversation = {
        id: "test-conversation",
        title: "Test Conversation",
        phase: "chat",
        history: [
            {
                id: "user-event-1",
                pubkey: "user-pubkey",
                content: "Previous user message",
            } as any,
        ],
        agentContexts: new Map(),
        phaseStartedAt: Date.now(),
        metadata: {},
        phaseTransitions: [],
        executionTime: {
            totalSeconds: 0,
            isActive: false,
            lastUpdated: Date.now(),
        },
    };

    const mockOrchestrator: Agent = {
        id: "orchestrator",
        name: "Orchestrator",
        slug: "orchestrator",
        role: "Orchestrator",
        pubkey: "orchestrator-pubkey",
        instructions: "Orchestrator instructions",
        tools: ["complete", "continue"],
        llmConfig: "agents",
        isOrchestrator: true,
    };

    const context: ExecutionContext = {
        // Base context
        projectPath: "/test/project",
        conversationId: "test-conversation",
        phase: "chat",

        // Execution context
        agent: mockOrchestrator,

        // Required fields
        publisher: {
            publishResponse: mock(),
        } as any,
        conversationManager: {
            updatePhase: mock(),
            getConversation: mock(() => mockConversation),
        } as any,
        triggeringEvent: {
            pubkey: "user-pubkey",
            content: "Test user message",
            id: "test-event-id",
        } as any,
    };

    // Helper function to execute tool and get result
    async function executeControl(input: any): Promise<ToolExecutionResult> {
        const executor = createToolExecutor(context);
        const result = await executor.execute(continueTool, input);
        return result;
    }

    describe("Required parameters", () => {
        it("should fail when no agents specified", async () => {
            const result = await executeControl({
                phase: "plan",
                reason: "Need to plan the architecture",
            });

            expect(result.success).toBe(false);
            expect(result.error?.kind).toBe("validation");
            expect(result.error?.message).toBe("Required");
        });

        it("should fail when agents array is empty", async () => {
            const result = await executeControl({
                agents: [],
                reason: "Test routing",
            });

            expect(result.success).toBe(false);
            expect(result.error?.kind).toBe("validation");
            expect(result.error?.message).toBe("Agents array cannot be empty");
        });

        it("should succeed with valid agents", async () => {
            const result = await executeControl({
                agents: ["planner"],
                phase: "plan",
                reason: "Need to plan the architecture",
            });

            if (!result.success) {
                console.log("Test failed with error:", result.error);
            }

            expect(result.success).toBe(true);
            expect(result.output?.type).toBe("continue");
            expect(result.output?.routing.agents).toEqual(["planner-pubkey"]);
            expect(result.output?.routing.phase).toBe("plan");
            expect(result.output?.routing.reason).toBe("Need to plan the architecture");
        });
    });

    describe("Explicit agent routing", () => {
        it("should route to specified agents even with phase", async () => {
            const result = await executeControl({
                phase: "execute",
                agents: ["frontend-expert", "backend-expert"],
                reason: "Need expert review",
            });

            expect(result.success).toBe(true);
            expect(result.output?.type).toBe("continue");
            expect(result.output?.routing.agents).toEqual(["frontend-pubkey", "backend-pubkey"]);
            expect(result.output?.routing.phase).toBe("execute");
            expect(result.output?.routing.reason).toBe("Need expert review");
        });

        it("should validate agent slugs", async () => {
            const result = await executeControl({
                agents: ["invalid-agent"],
                reason: "Test routing",
            });

            expect(result.success).toBe(false);
            expect(result.error?.kind).toBe("validation");
            expect(result.error?.message).toContain("Agents not found: invalid-agent");
            expect(result.error?.message).toContain("Available agents:");
        });

        it("should prevent routing to self", async () => {
            const result = await executeControl({
                agents: ["orchestrator"],
                reason: "Test self routing",
            });

            expect(result.success).toBe(false);
            expect(result.error?.kind).toBe("validation");
            expect(result.error?.message).toBe("Cannot route to self (orchestrator)");
        });
    });

    describe("Agent routing", () => {
        it("should route to executor for implementation", async () => {
            const result = await executeControl({
                agents: ["executor"],
                phase: "execute",
                reason: "Implementing feature",
            });

            expect(result.success).toBe(true);
            expect(result.output?.type).toBe("continue");
            expect(result.output?.routing).toMatchObject({
                phase: "execute",
                agents: ["executor-pubkey"],
                reason: "Implementing feature",
            });
        });
    });

    describe("Non-orchestrator usage", () => {
        it("should fail when non-orchestrator tries to use continue", async () => {
            const nonOrchestratorContext = {
                ...context,
                agent: {
                    ...mockOrchestrator,
                    isOrchestrator: false,
                    slug: "planner",
                },
            };

            const executor = createToolExecutor(nonOrchestratorContext);
            const result = await executor.execute(continueTool, {
                agents: ["executor"],
                phase: "execute",
                reason: "Test",
            });

            expect(result.success).toBe(false);
            expect(result.error?.kind).toBe("execution");
            expect(result.error?.message).toBe("Only orchestrator can use continue tool");
        });
    });

    describe("Case insensitive phase handling", () => {
        it("should handle uppercase phase names", async () => {
            const executor = createToolExecutor(context);
            const result = await executor.execute(continueTool, {
                agents: ["executor"],
                phase: "CHORES" as any,
                reason: "Here is why I decided this path: Testing uppercase",
            });

            expect(result.success).toBe(true);
            if (result.success && result.value?.type === "continue") {
                expect(result.value.routing.phase).toBe("chores");
            }
        });

        it("should handle mixed case phase names", async () => {
            const executor = createToolExecutor(context);
            const result = await executor.execute(continueTool, {
                agents: ["planner"],
                phase: "ReFlEcTiOn" as any,
                reason: "Here is why I decided this path: Testing mixed case",
            });

            expect(result.success).toBe(true);
            if (result.success && result.value?.type === "continue") {
                expect(result.value.routing.phase).toBe("reflection");
            }
        });

        it("should reject invalid phase names", async () => {
            const executor = createToolExecutor(context);
            const result = await executor.execute(continueTool, {
                agents: ["executor"],
                phase: "INVALID_PHASE" as any,
                reason: "Here is why I decided this path: Testing invalid",
            });

            expect(result.success).toBe(false);
            expect(result.error?.kind).toBe("validation");
            expect(result.error?.message).toContain("Invalid phase");
        });
    });
});
