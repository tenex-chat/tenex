import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { ExecutionCoordinator } from "../ExecutionCoordinator";
import { ClawbackAbortError, DEFAULT_ROUTING_POLICY } from "../types";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

// Mock the LLM Operations Registry
vi.mock("@/services/LLMOperationsRegistry", () => ({
    llmOpsRegistry: {
        getOperationsByEvent: vi.fn(() => new Map()),
        stopByEventId: vi.fn(),
    },
}));

// Mock logger
vi.mock("@/utils/logger", () => ({
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

describe("ExecutionCoordinator", () => {
    let coordinator: ExecutionCoordinator;

    beforeEach(() => {
        ExecutionCoordinator.resetInstance();
        coordinator = ExecutionCoordinator.getInstance();
    });

    afterEach(() => {
        ExecutionCoordinator.resetInstance();
    });

    describe("getInstance", () => {
        it("should return the same instance on multiple calls", () => {
            const instance1 = ExecutionCoordinator.getInstance();
            const instance2 = ExecutionCoordinator.getInstance();
            expect(instance1).toBe(instance2);
        });

        it("should use custom policy when provided", () => {
            ExecutionCoordinator.resetInstance();
            const customPolicy = { maxInjectionWaitMs: 5000 };
            const instance = ExecutionCoordinator.getInstance(customPolicy);
            expect(instance.getPolicy().maxInjectionWaitMs).toBe(5000);
        });
    });

    describe("registerOperation", () => {
        it("should register an operation with initial state", () => {
            coordinator.registerOperation("op-1", "agent-pubkey", "test-agent", "conv-1");

            const state = coordinator.getOperationState("op-1");
            expect(state).toBeDefined();
            expect(state?.operationId).toBe("op-1");
            expect(state?.agentPubkey).toBe("agent-pubkey");
            expect(state?.agentSlug).toBe("test-agent");
            expect(state?.conversationId).toBe("conv-1");
            expect(state?.stepCount).toBe(0);
            expect(state?.currentStepStartedAt).toBeNull();
            expect(state?.injectionQueue).toEqual([]);
            expect(state?.currentTool).toBeNull();
        });
    });

    describe("unregisterOperation", () => {
        it("should remove operation state", () => {
            coordinator.registerOperation("op-1", "agent-pubkey", "test-agent", "conv-1");
            expect(coordinator.getOperationState("op-1")).toBeDefined();

            coordinator.unregisterOperation("op-1");
            expect(coordinator.getOperationState("op-1")).toBeUndefined();
        });
    });

    describe("step lifecycle", () => {
        it("should track step start", () => {
            coordinator.registerOperation("op-1", "agent-pubkey", "test-agent", "conv-1");

            coordinator.onStepStart("op-1", 1);

            const state = coordinator.getOperationState("op-1");
            expect(state?.stepCount).toBe(1);
            expect(state?.currentStepStartedAt).not.toBeNull();
        });

        it("should track step completion", () => {
            coordinator.registerOperation("op-1", "agent-pubkey", "test-agent", "conv-1");
            coordinator.onStepStart("op-1", 1);

            coordinator.onStepComplete("op-1", 1);

            const state = coordinator.getOperationState("op-1");
            expect(state?.currentStepStartedAt).toBeNull();
            expect(state?.lastStepCompletedAt).not.toBeNull();
        });
    });

    describe("tool lifecycle", () => {
        it("should track tool start", () => {
            coordinator.registerOperation("op-1", "agent-pubkey", "test-agent", "conv-1");

            coordinator.onToolStart("op-1", "read_file");

            const state = coordinator.getOperationState("op-1");
            expect(state?.currentTool?.name).toBe("read_file");
            expect(state?.recentToolNames).toContain("read_file");
        });

        it("should track tool completion", () => {
            coordinator.registerOperation("op-1", "agent-pubkey", "test-agent", "conv-1");
            coordinator.onToolStart("op-1", "read_file");

            coordinator.onToolComplete("op-1", "read_file");

            const state = coordinator.getOperationState("op-1");
            expect(state?.currentTool).toBeNull();
        });

        it("should track recent tools (max 10)", () => {
            coordinator.registerOperation("op-1", "agent-pubkey", "test-agent", "conv-1");

            // Add 15 tools
            for (let i = 0; i < 15; i++) {
                coordinator.onToolStart("op-1", `tool-${i}`);
                coordinator.onToolComplete("op-1", `tool-${i}`);
            }

            const state = coordinator.getOperationState("op-1");
            expect(state?.recentToolNames.length).toBe(10);
            expect(state?.recentToolNames[0]).toBe("tool-5"); // First 5 should be dropped
        });
    });

    describe("message injection", () => {
        it("should queue messages for injection", () => {
            coordinator.registerOperation("op-1", "agent-pubkey", "test-agent", "conv-1");

            const mockEvent = { id: "event-1", content: "test message" } as NDKEvent;
            coordinator.queueMessageForInjection("op-1", mockEvent);

            const state = coordinator.getOperationState("op-1");
            expect(state?.injectionQueue.length).toBe(1);
            expect(state?.injectionQueue[0].event).toBe(mockEvent);
            expect(state?.injectionQueue[0].priority).toBe("normal");
        });

        it("should drain injection queue", () => {
            coordinator.registerOperation("op-1", "agent-pubkey", "test-agent", "conv-1");

            const mockEvent1 = { id: "event-1", content: "test 1" } as NDKEvent;
            const mockEvent2 = { id: "event-2", content: "test 2" } as NDKEvent;
            coordinator.queueMessageForInjection("op-1", mockEvent1);
            coordinator.queueMessageForInjection("op-1", mockEvent2);

            const drained = coordinator.drainInjectionQueue("op-1");

            expect(drained.length).toBe(2);
            expect(drained[0].event).toBe(mockEvent1);
            expect(drained[1].event).toBe(mockEvent2);

            // Queue should be empty after drain
            const state = coordinator.getOperationState("op-1");
            expect(state?.injectionQueue.length).toBe(0);
        });
    });

    describe("routeMessage", () => {
        it("should return start-new when no active operation exists", async () => {
            const mockAgent = { pubkey: "agent-pubkey", slug: "test-agent" } as any;
            const mockEvent = { id: "event-1", content: "test" } as NDKEvent;
            const mockConversation = { id: "conv-1" } as any;

            const decision = await coordinator.routeMessage({
                agent: mockAgent,
                event: mockEvent,
                conversation: mockConversation,
            });

            expect(decision.type).toBe("start-new");
        });

        it("should return inject when active operation exists", async () => {
            coordinator.registerOperation("op-1", "agent-pubkey", "test-agent", "conv-1");

            const mockAgent = { pubkey: "agent-pubkey", slug: "test-agent" } as any;
            const mockEvent = { id: "event-1", content: "test" } as NDKEvent;
            const mockConversation = { id: "conv-1" } as any;

            const decision = await coordinator.routeMessage({
                agent: mockAgent,
                event: mockEvent,
                conversation: mockConversation,
            });

            expect(decision.type).toBe("inject");
        });
    });

    describe("clawback", () => {
        it("should trigger clawback when injection waits too long", async () => {
            // Use a very short timeout for testing
            ExecutionCoordinator.resetInstance();
            coordinator = ExecutionCoordinator.getInstance({ maxInjectionWaitMs: 10 });

            coordinator.registerOperation("op-1", "agent-pubkey", "test-agent", "conv-1");

            // Queue a message
            const mockEvent = { id: "event-1", content: "test" } as NDKEvent;
            coordinator.queueMessageForInjection("op-1", mockEvent);

            // Wait for the timeout to expire
            await new Promise((resolve) => setTimeout(resolve, 50));

            // Now route another message - should trigger clawback
            const mockAgent = { pubkey: "agent-pubkey", slug: "test-agent" } as any;
            const mockConversation = { id: "conv-1" } as any;

            const decision = await coordinator.routeMessage({
                agent: mockAgent,
                event: mockEvent,
                conversation: mockConversation,
            });

            expect(decision.type).toBe("clawback");
        });

        it("should include operationId in clawback decision", async () => {
            ExecutionCoordinator.resetInstance();
            coordinator = ExecutionCoordinator.getInstance({ maxInjectionWaitMs: 10 });

            coordinator.registerOperation("op-1", "agent-pubkey", "test-agent", "conv-1");

            const mockEvent = { id: "event-1", content: "test" } as NDKEvent;
            coordinator.queueMessageForInjection("op-1", mockEvent);

            await new Promise((resolve) => setTimeout(resolve, 50));

            const mockAgent = { pubkey: "agent-pubkey", slug: "test-agent" } as any;
            const mockConversation = { id: "conv-1" } as any;

            const decision = await coordinator.routeMessage({
                agent: mockAgent,
                event: mockEvent,
                conversation: mockConversation,
            });

            expect(decision.type).toBe("clawback");
            if (decision.type === "clawback") {
                expect(decision.operationId).toBe("op-1");
                expect(decision.reason).toContain("threshold");
            }
        });

        it("should trigger clawback for step duration with interruptible tool", async () => {
            ExecutionCoordinator.resetInstance();
            coordinator = ExecutionCoordinator.getInstance({
                maxStepDurationMs: 10,
                interruptibleTools: ["read_file"],
            });

            coordinator.registerOperation("op-1", "agent-pubkey", "test-agent", "conv-1");
            coordinator.onStepStart("op-1", 1);
            coordinator.onToolStart("op-1", "read_file");

            await new Promise((resolve) => setTimeout(resolve, 50));

            const mockAgent = { pubkey: "agent-pubkey", slug: "test-agent" } as any;
            const mockEvent = { id: "event-1", content: "test" } as NDKEvent;
            const mockConversation = { id: "conv-1" } as any;

            const decision = await coordinator.routeMessage({
                agent: mockAgent,
                event: mockEvent,
                conversation: mockConversation,
            });

            expect(decision.type).toBe("clawback");
            if (decision.type === "clawback") {
                expect(decision.reason).toContain("interruptible tool");
            }
        });

        it("should fall back to inject when step runs long with uninterruptible tool", async () => {
            ExecutionCoordinator.resetInstance();
            coordinator = ExecutionCoordinator.getInstance({
                maxStepDurationMs: 10,
                uninterruptibleTools: ["write_file"],
                allowConcurrentExecution: true,
            });

            coordinator.registerOperation("op-1", "agent-pubkey", "test-agent", "conv-1");
            coordinator.onStepStart("op-1", 1);
            coordinator.onToolStart("op-1", "write_file");

            await new Promise((resolve) => setTimeout(resolve, 50));

            const mockAgent = { pubkey: "agent-pubkey", slug: "test-agent" } as any;
            const mockEvent = { id: "event-1", content: "test" } as NDKEvent;
            const mockConversation = { id: "conv-1" } as any;

            const decision = await coordinator.routeMessage({
                agent: mockAgent,
                event: mockEvent,
                conversation: mockConversation,
            });

            // Should inject (not start-concurrent since it's not implemented)
            expect(decision.type).toBe("inject");
        });
    });

    describe("tool interruption", () => {
        it("should consider unknown tools as uninterruptible by default", async () => {
            ExecutionCoordinator.resetInstance();
            coordinator = ExecutionCoordinator.getInstance({
                maxStepDurationMs: 10,
                interruptibleTools: ["read_file"],
                uninterruptibleTools: ["write_file"],
            });

            coordinator.registerOperation("op-1", "agent-pubkey", "test-agent", "conv-1");
            coordinator.onStepStart("op-1", 1);
            coordinator.onToolStart("op-1", "unknown_tool"); // Not in either list

            await new Promise((resolve) => setTimeout(resolve, 50));

            const mockAgent = { pubkey: "agent-pubkey", slug: "test-agent" } as any;
            const mockEvent = { id: "event-1", content: "test" } as NDKEvent;
            const mockConversation = { id: "conv-1" } as any;

            const decision = await coordinator.routeMessage({
                agent: mockAgent,
                event: mockEvent,
                conversation: mockConversation,
            });

            // Unknown tool is treated as uninterruptible, so we get inject (not clawback)
            expect(decision.type).toBe("inject");
        });

        it("should allow interruption when no tool is running", async () => {
            ExecutionCoordinator.resetInstance();
            coordinator = ExecutionCoordinator.getInstance({
                maxStepDurationMs: 10,
            });

            coordinator.registerOperation("op-1", "agent-pubkey", "test-agent", "conv-1");
            coordinator.onStepStart("op-1", 1);
            // No tool started

            await new Promise((resolve) => setTimeout(resolve, 50));

            const mockAgent = { pubkey: "agent-pubkey", slug: "test-agent" } as any;
            const mockEvent = { id: "event-1", content: "test" } as NDKEvent;
            const mockConversation = { id: "conv-1" } as any;

            const decision = await coordinator.routeMessage({
                agent: mockAgent,
                event: mockEvent,
                conversation: mockConversation,
            });

            // No tool running = interruptible
            expect(decision.type).toBe("clawback");
        });
    });

    describe("event emission", () => {
        it("should emit step-started event", () => {
            coordinator.registerOperation("op-1", "agent-pubkey", "test-agent", "conv-1");

            const eventHandler = vi.fn();
            coordinator.on("step-started", eventHandler);

            coordinator.onStepStart("op-1", 1);

            expect(eventHandler).toHaveBeenCalled();
            expect(eventHandler.mock.calls[0][0]).toEqual({
                operationId: "op-1",
                stepNumber: 1,
            });
        });

        it("should emit step-completed event", () => {
            coordinator.registerOperation("op-1", "agent-pubkey", "test-agent", "conv-1");
            coordinator.onStepStart("op-1", 1);

            const eventHandler = vi.fn();
            coordinator.on("step-completed", eventHandler);

            coordinator.onStepComplete("op-1", 1);

            expect(eventHandler).toHaveBeenCalled();
            expect(eventHandler.mock.calls[0][0].operationId).toBe("op-1");
            expect(eventHandler.mock.calls[0][0].stepNumber).toBe(1);
            expect(eventHandler.mock.calls[0][0].durationMs).toBeDefined();
        });

        it("should emit message-queued event", () => {
            coordinator.registerOperation("op-1", "agent-pubkey", "test-agent", "conv-1");

            const eventHandler = vi.fn();
            coordinator.on("message-queued", eventHandler);

            const mockEvent = { id: "event-1", content: "test" } as NDKEvent;
            coordinator.queueMessageForInjection("op-1", mockEvent);

            expect(eventHandler).toHaveBeenCalled();
            expect(eventHandler.mock.calls[0][0]).toEqual({
                operationId: "op-1",
                eventId: "event-1",
                queuePosition: 1,
            });
        });

        it("should emit clawback-triggered event", async () => {
            ExecutionCoordinator.resetInstance();
            coordinator = ExecutionCoordinator.getInstance({ maxInjectionWaitMs: 10 });

            coordinator.registerOperation("op-1", "agent-pubkey", "test-agent", "conv-1");

            const eventHandler = vi.fn();
            coordinator.on("clawback-triggered", eventHandler);

            const mockEvent = { id: "event-1", content: "test" } as NDKEvent;
            coordinator.queueMessageForInjection("op-1", mockEvent);

            await new Promise((resolve) => setTimeout(resolve, 50));

            const mockAgent = { pubkey: "agent-pubkey", slug: "test-agent" } as any;
            const mockConversation = { id: "conv-1" } as any;

            await coordinator.routeMessage({
                agent: mockAgent,
                event: mockEvent,
                conversation: mockConversation,
            });

            expect(eventHandler).toHaveBeenCalled();
            expect(eventHandler.mock.calls[0][0].operationId).toBe("op-1");
        });
    });

    describe("stale operation cleanup", () => {
        it("should not clean up recent operations", async () => {
            coordinator.registerOperation("op-1", "agent-pubkey", "test-agent", "conv-1");

            // Operation is fresh - should not be cleaned
            const state = coordinator.getOperationState("op-1");
            expect(state).toBeDefined();
        });

        it("should clear clawback timer on unregister", () => {
            coordinator.registerOperation("op-1", "agent-pubkey", "test-agent", "conv-1");

            const mockEvent = { id: "event-1", content: "test" } as NDKEvent;
            coordinator.queueMessageForInjection("op-1", mockEvent);

            // This should clear the timer
            coordinator.unregisterOperation("op-1");

            // No error should occur - timer was properly cleared
            expect(coordinator.getOperationState("op-1")).toBeUndefined();
        });
    });

    describe("ClawbackAbortError", () => {
        it("should have correct properties", () => {
            const error = new ClawbackAbortError("op-1", "timeout exceeded");

            expect(error.operationId).toBe("op-1");
            expect(error.reason).toBe("timeout exceeded");
            expect(error.name).toBe("ClawbackAbortError");
            expect(error.message).toContain("timeout exceeded");
        });
    });

    describe("DEFAULT_ROUTING_POLICY", () => {
        it("should have sensible defaults", () => {
            expect(DEFAULT_ROUTING_POLICY.maxInjectionWaitMs).toBe(30000);
            expect(DEFAULT_ROUTING_POLICY.maxStepDurationMs).toBe(60000);
            expect(DEFAULT_ROUTING_POLICY.allowConcurrentExecution).toBe(true);
            expect(DEFAULT_ROUTING_POLICY.interruptibleTools).toContain("read_file");
            expect(DEFAULT_ROUTING_POLICY.uninterruptibleTools).toContain("write_file");
        });
    });
});
