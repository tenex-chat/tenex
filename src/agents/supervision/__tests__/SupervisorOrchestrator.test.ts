import { describe, it, expect, beforeEach, vi } from "vitest";
import { SupervisorOrchestrator } from "../SupervisorOrchestrator";
import { HeuristicRegistry } from "../heuristics/HeuristicRegistry";
import { SilentAgentHeuristic } from "../heuristics/SilentAgentHeuristic";
import { MAX_SUPERVISION_RETRIES } from "../types";
import type { PostCompletionContext } from "../types";

// Mock logger
vi.mock("@/utils/logger", () => ({
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

// Mock the LLM service to avoid actual API calls
vi.mock("../SupervisorLLMService", () => ({
    supervisorLLMService: {
        verify: vi.fn().mockResolvedValue({
            verdict: "ok",
            explanation: "Test verification passed",
        }),
    },
}));

describe("SupervisorOrchestrator", () => {
    let orchestrator: SupervisorOrchestrator;

    beforeEach(() => {
        // Clear registry before each test
        HeuristicRegistry.getInstance().clear();
        orchestrator = new SupervisorOrchestrator();
    });

    const createContext = (
        overrides: Partial<PostCompletionContext> = {}
    ): PostCompletionContext => ({
        agentSlug: "test-agent",
        agentPubkey: "abc123",
        hasPhases: false,
        messageContent: "Hello world",
        toolCallsMade: [],
        systemPrompt: "You are a helpful assistant.",
        conversationHistory: [],
        availableTools: {},
        ...overrides,
    });

    describe("supervision state management", () => {
        it("should create new state for unknown execution ID", () => {
            const state = orchestrator.getSupervisionState("exec-1");

            expect(state.retryCount).toBe(0);
            expect(state.maxRetries).toBe(MAX_SUPERVISION_RETRIES);
        });

        it("should return existing state for known execution ID", () => {
            orchestrator.incrementRetryCount("exec-1");
            const state = orchestrator.getSupervisionState("exec-1");

            expect(state.retryCount).toBe(1);
        });

        it("should increment retry count", () => {
            orchestrator.incrementRetryCount("exec-1");
            orchestrator.incrementRetryCount("exec-1");
            const state = orchestrator.getSupervisionState("exec-1");

            expect(state.retryCount).toBe(2);
        });

        it("should detect when max retries exceeded", () => {
            for (let i = 0; i < MAX_SUPERVISION_RETRIES; i++) {
                orchestrator.incrementRetryCount("exec-1");
            }

            expect(orchestrator.hasExceededMaxRetries("exec-1")).toBe(true);
        });

        it("should not exceed max retries when under limit", () => {
            orchestrator.incrementRetryCount("exec-1");

            expect(orchestrator.hasExceededMaxRetries("exec-1")).toBe(false);
        });

        it("should clear state", () => {
            orchestrator.incrementRetryCount("exec-1");
            orchestrator.clearState("exec-1");
            const state = orchestrator.getSupervisionState("exec-1");

            expect(state.retryCount).toBe(0);
        });
    });

    describe("checkPostCompletion", () => {
        it("should return no violation when no heuristics registered", async () => {
            const context = createContext();
            const result = await orchestrator.checkPostCompletion(context);

            expect(result.hasViolation).toBe(false);
        });

        it("should return no violation when heuristic does not trigger", async () => {
            HeuristicRegistry.getInstance().register(new SilentAgentHeuristic());

            const context = createContext({
                messageContent: "Here is my response",
            });
            const result = await orchestrator.checkPostCompletion(context);

            expect(result.hasViolation).toBe(false);
        });
    });
});
